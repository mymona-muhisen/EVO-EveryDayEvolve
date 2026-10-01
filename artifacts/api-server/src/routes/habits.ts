import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, asc, desc } from "drizzle-orm";
import {
  db, habitsTable, checkinsTable, habitDaysTable, habitPlanRevisionsTable,
  habitDailyExecutionsTable, rewardsTable, usersTable,
} from "@workspace/db";
import {
  ListHabitsQueryParams,
  ListHabitsResponse,
  CreateHabitBody,
  CreateHabitResponse,
  GetHabitParams,
  GetHabitResponse,
  UpdateHabitParams,
  UpdateHabitBody,
  UpdateHabitResponse,
  DeleteHabitParams,
  GetHabitJourneyParams,
  GetHabitJourneyResponse,
  StartHabitJourneyParams,
  StartHabitJourneyResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import {
  checkinsForPlanRevision, defaultMinimumFloor, effectiveMinimum, missedScheduledDays,
  proposeHabitAdaptation, validateHabitPlanUpdate,
} from "../lib/aiRules";
import { habitAdaptationMessages } from "../lib/aiMessages";
import { toDateOnly, todayInTimezone } from "../lib/dates";
import {
  addCalendarDays, HABIT_JOURNEY_LENGTH, isScheduledDate, isWithinJourneyWindow, journeyDayNumber, makeJourneyDays, snapshotPlan,
  resolveExecutionType,
} from "../lib/habitJourney";
import { reviseFutureUnrecordedDays } from "../lib/habitPlanService";
import { evaluateJourneyLifecycle } from "../lib/journeyLifecycle";
import {
  journeysAssociatedWithReward, markJourneyRewardRequired, preserveJourneyRewardGate,
} from "../lib/journeyRewardGate";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/habits", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListHabitsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = [eq(habitsTable.userId, req.userId!)];
  if (query.data.isActive !== undefined) {
    conditions.push(eq(habitsTable.isActive, query.data.isActive));
  }

  const habits = await db
    .select()
    .from(habitsTable)
    .where(and(...conditions))
    .orderBy(desc(habitsTable.createdAt));

  res.json(ListHabitsResponse.parse(habits));
});

router.post("/habits", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const parsed = CreateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  const executionType = resolveExecutionType(input.unit, input.goalType, input.executionType);
  if ((input.goalType === "quit" && executionType !== "limit")
    || (input.goalType === "build" && executionType === "limit")) {
    res.status(400).json({ error: "Reduce habits use limit execution; build habits cannot use limit execution" });
    return;
  }
  const minimumValue = input.minimumValue ?? input.targetValue;
  const minimumFloor = defaultMinimumFloor(input.goalType, input.minimumFloor);
  const successLimitValue = input.successLimitValue ?? (input.goalType === "quit" ? input.targetValue : null);
  const today = todayInTimezone(user.timezone);
  const journeyStartDate = input.journeyStartDate == null
    ? today
    : typeof input.journeyStartDate === "string"
      ? input.journeyStartDate
      : toDateOnly(input.journeyStartDate);
  const journeyLength = input.journeyLength ?? HABIT_JOURNEY_LENGTH;
  if ((input.goalType === "build" && input.targetValue <= 0)
    || (input.goalType === "quit" && input.targetValue < 0)) {
    res.status(400).json({ error: "Build targets must be positive; reduce targets cannot be negative" });
    return;
  }
  if (minimumValue > input.targetValue || minimumFloor > input.targetValue) {
    res.status(400).json({ error: "Minimum and floor values cannot exceed the target value" });
    return;
  }
  if (input.goalType === "build" && minimumValue <= 0) {
    res.status(400).json({ error: "Build minimum values must be positive" });
    return;
  }
  if (input.goalType === "quit" && (input.baselineValue === undefined || input.baselineValue < input.targetValue)) {
    res.status(400).json({ error: "A reduce habit requires a confirmed baseline at or above its target" });
    return;
  }
  if (input.cadence === "custom_days" && (!input.customDays || input.customDays.length === 0)) {
    res.status(400).json({ error: "Custom cadence requires at least one selected weekday" });
    return;
  }
  if (input.goalType === "quit" && (successLimitValue == null || successLimitValue < input.targetValue)) {
    res.status(400).json({ error: "Reduce success limit must be at or above its target" });
    return;
  }
  if (input.busyDayValue !== undefined && (input.busyDayValue < 0 || input.busyDayValue > minimumValue)) {
    res.status(400).json({ error: "Busy-day value must be positive and no greater than the minimum value" });
    return;
  }
  if (journeyLength !== HABIT_JOURNEY_LENGTH || journeyStartDate < today) {
    res.status(400).json({ error: "New habit journeys must be 22 days and cannot start before today in your timezone" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    if (input.rewardId != null) {
      const [reward] = await tx.select({ id: rewardsTable.id }).from(rewardsTable)
        .where(and(eq(rewardsTable.id, input.rewardId), eq(rewardsTable.userId, req.userId!)))
        .for("update");
      if (!reward) return { error: "Reward not found for this user" } as const;
    }
    const [habit] = await tx.insert(habitsTable).values({
      userId: req.userId!,
      ...input,
      executionType,
      minimumValue,
      minimumFloor,
      busyDayValue: input.busyDayValue ?? null,
      baselineValue: input.baselineValue ?? null,
      successLimitValue,
      customDays: input.customDays ?? null,
      cueType: input.cueType ?? null,
      cueTime: input.cueTime ?? null,
      cue: input.cue ?? null,
      startAction: input.startAction ?? null,
      friction: input.friction ?? null,
      journeyStartDate,
      journeyLength,
      rewardId: input.rewardId ?? null,
      milestones: input.milestones ?? [],
    }).returning();
    const plan = snapshotPlan({
      title: habit.title,
      cadence: habit.cadence,
      customDays: habit.customDays,
      targetValue: habit.targetValue,
      minimumValue: habit.minimumValue ?? habit.targetValue,
      busyDayValue: habit.busyDayValue,
      successLimitValue: habit.successLimitValue,
      minimumFloor: habit.minimumFloor,
      goalType: habit.goalType,
      cueType: habit.cueType,
      cueTime: habit.cueTime,
      cue: habit.cue,
      startAction: habit.startAction,
      friction: habit.friction,
      unit: habit.unit,
      executionType,
    });
    await tx.insert(habitDaysTable).values(makeJourneyDays(habit.id, journeyStartDate, journeyLength, {
      title: habit.title,
      targetValue: habit.targetValue,
      minimumValue: habit.minimumValue ?? habit.targetValue,
      busyDayValue: habit.busyDayValue,
      successLimitValue: habit.successLimitValue,
      goalType: habit.goalType,
      planRevision: 1,
      cadence: habit.cadence,
      customDays: habit.customDays,
      unit: habit.unit,
      executionType,
      cueType: habit.cueType,
      cueTime: habit.cueTime,
      cue: habit.cue,
      startAction: habit.startAction,
    }));
    await tx.insert(habitPlanRevisionsTable).values({
      habitId: habit.id, revision: 1, effectiveFrom: journeyStartDate, plan,
    });
    await preserveJourneyRewardGate(tx, req.userId!, habit, today);
    return { habit } as const;
  });

  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(CreateHabitResponse.parse(result.habit));
});

router.get("/habits/:habitId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.json(GetHabitResponse.parse(habit));
});

const getHabitJourneyHandler = async (req: Request, res: Response): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetHabitJourneyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!user) return { kind: "not_found" } as const;
    const [habit] = await tx.select().from(habitsTable).where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
    )).for("update");
    if (!habit) return { kind: "not_found" } as const;

    const savedDays = await tx.select().from(habitDaysTable)
      .where(eq(habitDaysTable.habitId, habit.id));
    const days = habit.journeyStartDate != null && habit.journeyLength != null
      ? savedDays.filter((day) => isWithinJourneyWindow(
        day.date, habit.journeyStartDate!, habit.journeyLength!,
      ))
      : savedDays;
    days.sort((left, right) => left.date.localeCompare(right.date));
    const [checkins, revisions, executions] = days.length
      ? await Promise.all([
        tx.select().from(checkinsTable).where(eq(checkinsTable.habitId, habit.id)),
        tx.select().from(habitPlanRevisionsTable).where(eq(habitPlanRevisionsTable.habitId, habit.id)),
        tx.select().from(habitDailyExecutionsTable).where(eq(habitDailyExecutionsTable.habitId, habit.id)),
      ])
      : [[], [], []];
    const rewardFields = {
      id: rewardsTable.id,
      title: rewardsTable.title,
      emoji: rewardsTable.emoji,
      coinCost: rewardsTable.coinCost,
      isRedeemed: rewardsTable.isRedeemed,
      redeemedAt: rewardsTable.redeemedAt,
      journeyRequired: rewardsTable.journeyRequired,
      journeyUnlockedAt: rewardsTable.journeyUnlockedAt,
    };
    const [forwardReward] = habit.rewardId == null
      ? []
      : await tx.select(rewardFields).from(rewardsTable).where(and(
        eq(rewardsTable.id, habit.rewardId),
        eq(rewardsTable.userId, req.userId!),
      )).limit(1);
    const [reverseReward] = forwardReward
      ? []
      : await tx.select(rewardFields).from(rewardsTable).where(and(
        eq(rewardsTable.habitId, habit.id),
        eq(rewardsTable.userId, req.userId!),
      )).orderBy(asc(rewardsTable.createdAt), asc(rewardsTable.id)).limit(1);
    const selectedReward = forwardReward ?? reverseReward;
    const byDate = new Map(checkins.map((checkin) => [checkin.date, checkin]));
    const executionByDate = new Map(executions.map((execution) => [execution.date, execution]));
    const planByRevision = new Map(revisions.map((revision) => [revision.revision, revision.plan]));
    const scheduledDays = days.filter((day) => day.scheduled);
    const today = todayInTimezone(user.timezone);
    const lifecycle = evaluateJourneyLifecycle({
      startDate: habit.journeyStartDate,
      length: habit.journeyLength,
      today,
      scheduledDates: scheduledDays.map((day) => day.date),
      successfulDates: new Set(checkins.filter((checkin) => checkin.completed).map((checkin) => checkin.date)),
      completedAt: habit.journeyCompletedAt,
    });
    let completedAt = habit.journeyCompletedAt;
    if (lifecycle.shouldCommitCompletion) {
      completedAt = new Date();
      await tx.update(habitsTable).set({ journeyCompletedAt: completedAt })
        .where(and(eq(habitsTable.id, habit.id), eq(habitsTable.userId, req.userId!)));
    }
    const currentDay = days.length === 0 || lifecycle.calendarDay < 1
      ? 0
      : Math.min(days.length, lifecycle.calendarDay);
    const successfulDays = scheduledDays.filter((day) => day.date <= today
      && byDate.get(day.date)?.completed).length;
    const eligibleDays = scheduledDays.filter((day) => day.date <= today).length;
    const missedDays = scheduledDays.filter((day) => {
      if (day.date < today) return !byDate.get(day.date)?.completed;
      if (day.date !== today || byDate.get(day.date)?.completed) return false;
      const execution = executionByDate.get(day.date);
      const checkin = byDate.get(day.date);
      return execution?.status === "missed" || checkin?.missedReason != null;
    }).length;
    const journeyCheckins = checkins.filter((checkin) => scheduledDays.some((day) => day.date === checkin.date)
      && checkin.completed);
    const unknownCheckins = journeyCheckins.filter((checkin) => checkin.xpEarned == null).length;
    const coinHistoryMayBeIncomplete = journeyCheckins.some((checkin) =>
      checkin.xpEarned == null && checkin.coinsEarned === 0 && !checkin.rewardGranted);
    let rewardUnlocked = false;
    if (selectedReward) {
      const linkedJourneys = await journeysAssociatedWithReward(tx, req.userId!, selectedReward.id);
      const definedJourneys = linkedJourneys.filter((linked) =>
        linked.journeyStartDate != null && linked.journeyLength === HABIT_JOURNEY_LENGTH);
      let qualifyingJourneyFound = false;
      for (const linked of definedJourneys) {
        if (linked.id === habit.id) {
          await markJourneyRewardRequired(
            tx, req.userId!, selectedReward.id, lifecycle.status === "completed",
          );
          if (lifecycle.status === "completed") qualifyingJourneyFound = true;
          continue;
        }
        const [linkedSavedDays, linkedCheckins] = await Promise.all([
          tx.select().from(habitDaysTable).where(eq(habitDaysTable.habitId, linked.id)),
          tx.select().from(checkinsTable).where(eq(checkinsTable.habitId, linked.id)),
        ]);
        const linkedDays = linkedSavedDays.filter((day) => isWithinJourneyWindow(
          day.date, linked.journeyStartDate!, linked.journeyLength!,
        ));
        const linkedLifecycle = evaluateJourneyLifecycle({
          startDate: linked.journeyStartDate,
          length: linked.journeyLength,
          today,
          scheduledDates: linkedDays.filter((day) => day.scheduled).map((day) => day.date),
          successfulDates: new Set(linkedCheckins
            .filter((checkin) => checkin.completed)
            .map((checkin) => checkin.date)),
          completedAt: linked.journeyCompletedAt,
        });
        if (linkedLifecycle.shouldCommitCompletion) {
          await tx.update(habitsTable).set({ journeyCompletedAt: new Date() }).where(and(
            eq(habitsTable.id, linked.id),
            eq(habitsTable.userId, req.userId!),
          ));
        }
        await markJourneyRewardRequired(
          tx, req.userId!, selectedReward.id, linkedLifecycle.status === "completed",
        );
        if (linkedLifecycle.status === "completed") qualifyingJourneyFound = true;
      }
      const journeyRequired = selectedReward.journeyRequired || definedJourneys.length > 0;
      rewardUnlocked = selectedReward.isRedeemed
        || !journeyRequired
        || selectedReward.journeyUnlockedAt != null
        || qualifyingJourneyFound;
    }
    return {
      kind: "ok" as const,
      payload: {
        habitId: habit.id,
        startDate: habit.journeyStartDate,
        length: habit.journeyLength ?? 0,
        total: scheduledDays.length,
        completed: scheduledDays.filter((day) => byDate.has(day.date)).length,
        successful: scheduledDays.filter((day) => byDate.get(day.date)?.completed).length,
        currentDay,
        today,
        timezone: user.timezone,
        status: lifecycle.status,
        completedAt,
        consistency: { successfulDays, eligibleDays },
        missedDays,
        restDays: days.filter((day) => !day.scheduled).length,
        selectedReward: selectedReward == null ? null : {
          id: selectedReward.id,
          title: selectedReward.title,
          emoji: selectedReward.emoji,
          coinCost: selectedReward.coinCost,
          isRedeemed: selectedReward.isRedeemed,
          redeemedAt: selectedReward.redeemedAt,
        },
        rewardUnlocked: Boolean(selectedReward && rewardUnlocked),
        finalEligibility: lifecycle.finalEligibility,
        earnings: {
          xp: journeyCheckins.reduce((sum, checkin) => sum + (checkin.xpEarned ?? 0), 0),
          coins: journeyCheckins.reduce((sum, checkin) => sum + checkin.coinsEarned, 0),
          xpComplete: unknownCheckins === 0,
          unknownCheckins,
          coinHistoryMayBeIncomplete,
        },
        days: days.map((day) => {
          const plan = planByRevision.get(day.planRevision);
          const checkin = byDate.get(day.date) ?? null;
          const execution = executionByDate.get(day.date);
          const executionActivityStatus = execution?.status === "in_progress"
            || execution?.status === "paused"
            || execution?.status === "minimum_reached"
            || execution?.status === "target_reached"
            || execution?.status === "pending_reflection";
          const status = !day.scheduled
            ? "rest"
            : day.date > today
              ? "future"
              : checkin?.completed
                ? "completed"
                : checkin?.missedReason != null || execution?.status === "missed" || day.date < today
                  ? "missed"
                  : executionActivityStatus ? execution!.status : "pending";
          const recoveryStatus = habit.recoveryEnabled && execution
            && ["recovery_available", "recovery_active", "recovered"].includes(execution.status)
            ? execution.status as "recovery_available" | "recovery_active" | "recovered"
            : null;
          return {
            date: day.date,
            dayNumber: habit.journeyStartDate == null
              ? day.dayNumber
              : journeyDayNumber(day.date, habit.journeyStartDate),
            scheduled: day.scheduled,
            targetValue: day.targetValue,
            minimumValue: day.minimumValue,
            busyDayValue: day.busyDayValue,
            successLimitValue: day.successLimitValue,
            goalType: day.goalType,
            unit: day.unit ?? plan?.unit ?? habit.unit,
            executionType: day.executionType ?? plan?.executionType
              ?? resolveExecutionType(day.unit ?? plan?.unit ?? habit.unit, day.goalType, habit.executionType),
            cueType: day.cueType ?? plan?.cueType ?? null,
            cueTime: day.cueTime ?? plan?.cueTime ?? null,
            cue: day.cue ?? plan?.cue ?? null,
            startAction: day.startAction ?? plan?.startAction ?? null,
            status,
            actualValue: execution?.actualValue ?? checkin?.value ?? null,
            actualSeconds: execution?.actualSeconds ?? null,
            difficulty: execution?.difficulty ?? checkin?.difficulty ?? null,
            missedReason: execution?.missedReason ?? checkin?.missedReason ?? null,
            recoveryEnabled: false,
            recoveryUsed: habit.recoveryUsed,
            recoveryLimit: habit.recoveryLimit,
            recoveryStatus,
            checkin,
          };
        }),
      },
    };
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  res.json(GetHabitJourneyResponse.parse(result.payload));
};

router.get("/habits/:habitId/journey", getHabitJourneyHandler);

router.post("/habits/:habitId/journey", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = StartHabitJourneyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!user) return { kind: "not_found" } as const;
    const [habit] = await tx.select().from(habitsTable).where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
    )).for("update");
    if (!habit) return { kind: "not_found" } as const;
    if (habit.journeyStartDate != null || habit.journeyLength != null) {
      return habit.journeyStartDate != null
        && habit.journeyLength === HABIT_JOURNEY_LENGTH
        ? { kind: "existing" } as const
        : { kind: "invalid" } as const;
    }

    const today = todayInTimezone(user.timezone);
    const minimumValue = effectiveMinimum(habit.targetValue, habit.minimumValue);
    if (habit.cadence === "custom_days" && !habit.customDays?.length) {
      return { kind: "invalid" } as const;
    }
    const executionType = resolveExecutionType(habit.unit, habit.goalType, habit.executionType);
    const [latestRevision] = await tx.select({ revision: habitPlanRevisionsTable.revision })
      .from(habitPlanRevisionsTable)
      .where(eq(habitPlanRevisionsTable.habitId, habit.id))
      .orderBy(desc(habitPlanRevisionsTable.revision))
      .limit(1);
    const revision = (latestRevision?.revision ?? 0) + 1;
    const plan = snapshotPlan({
      title: habit.title,
      cadence: habit.cadence,
      customDays: habit.customDays,
      targetValue: habit.targetValue,
      minimumValue,
      busyDayValue: habit.busyDayValue,
      successLimitValue: habit.successLimitValue,
      minimumFloor: habit.minimumFloor ?? defaultMinimumFloor(habit.goalType),
      goalType: habit.goalType,
      unit: habit.unit,
      executionType,
      cueType: habit.cueType,
      cueTime: habit.cueTime,
      cue: habit.cue,
      startAction: habit.startAction,
      friction: habit.friction,
    });
    const journeyDays = makeJourneyDays(habit.id, today, HABIT_JOURNEY_LENGTH, {
      title: habit.title,
      targetValue: habit.targetValue,
      minimumValue,
      busyDayValue: habit.busyDayValue,
      successLimitValue: habit.successLimitValue,
      goalType: habit.goalType,
      unit: habit.unit,
      executionType,
      cueType: habit.cueType,
      cueTime: habit.cueTime,
      cue: habit.cue,
      startAction: habit.startAction,
      planRevision: revision,
      cadence: habit.cadence,
      customDays: habit.customDays,
    });
    const savedDays = await tx.select().from(habitDaysTable)
      .where(eq(habitDaysTable.habitId, habit.id));
    const savedDates = new Set(savedDays.map((day) => day.date));
    const missingDays = journeyDays.filter((day) => !savedDates.has(day.date));
    if (missingDays.length) await tx.insert(habitDaysTable).values(missingDays);
    await tx.insert(habitPlanRevisionsTable).values({
      habitId: habit.id,
      revision,
      effectiveFrom: today,
      plan,
    });
    const [startedHabit] = await tx.update(habitsTable).set({
      journeyStartDate: today,
      journeyLength: HABIT_JOURNEY_LENGTH,
    }).where(and(
      eq(habitsTable.id, habit.id),
      eq(habitsTable.userId, req.userId!),
    )).returning();
    await preserveJourneyRewardGate(tx, req.userId!, startedHabit, today);
    return { kind: "started" } as const;
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  if (result.kind === "invalid") {
    res.status(400).json({ error: "The habit has an invalid or incomplete journey definition or cadence" });
    return;
  }
  await getHabitJourneyHandler(req, res);
});

router.get("/habits/:habitId/adaptation", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const params = GetHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [habit] = await db.select().from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  const history = await db.select({
    date: checkinsTable.date,
    difficulty: checkinsTable.difficulty,
    missedReason: checkinsTable.missedReason,
    completed: checkinsTable.completed,
    note: checkinsTable.note,
  }).from(checkinsTable)
    .where(eq(checkinsTable.habitId, habit.id))
    .orderBy(desc(checkinsTable.date));
  const [savedJourneyDays, latestRevisionRows, dailyHistory] = await Promise.all([
    db.select({
    date: habitDaysTable.date,
    scheduled: habitDaysTable.scheduled,
    planRevision: habitDaysTable.planRevision,
  }).from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id)),
    db.select({
      revision: habitPlanRevisionsTable.revision,
      effectiveFrom: habitPlanRevisionsTable.effectiveFrom,
    }).from(habitPlanRevisionsTable)
      .where(eq(habitPlanRevisionsTable.habitId, habit.id))
      .orderBy(desc(habitPlanRevisionsTable.revision)).limit(1),
    db.select({
      date: habitDailyExecutionsTable.date,
      scheduled: habitDailyExecutionsTable.scheduled,
      status: habitDailyExecutionsTable.status,
      planRevision: habitDailyExecutionsTable.planRevision,
      difficulty: habitDailyExecutionsTable.difficulty,
      missedReason: habitDailyExecutionsTable.missedReason,
      note: habitDailyExecutionsTable.note,
    }).from(habitDailyExecutionsTable).where(eq(habitDailyExecutionsTable.habitId, habit.id)),
  ]);
  const journeyDays = habit.journeyStartDate != null && habit.journeyLength != null
    ? savedJourneyDays.filter((day) => isWithinJourneyWindow(
      day.date, habit.journeyStartDate!, habit.journeyLength!,
    ))
    : savedJourneyDays;
  const today = todayInTimezone(user.timezone);
  const scheduledDates = new Set(journeyDays.filter((day) => day.scheduled).map((day) => day.date));
  const scheduledCheckins = journeyDays.length
    ? history.filter((row) => scheduledDates.has(row.date))
    : history.filter((row) => {
      const scheduleAnchor = habit.journeyStartDate ?? toDateOnly(habit.createdAt);
      const offset = Math.floor(
        (Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${scheduleAnchor}T00:00:00Z`)) / 86_400_000,
      );
      return offset >= 0
        && isScheduledDate(row.date, offset + 1, habit.cadence, habit.customDays);
    });
  const recordedDates = new Set(history.map((row) => row.date));
  const reflectedMisses = dailyHistory.filter((row) => row.scheduled
    && row.status === "missed"
    && row.date < today
    && !recordedDates.has(row.date)
    && (row.missedReason != null || row.note != null || row.difficulty != null));
  const analysisHistory = [
    ...scheduledCheckins,
    ...reflectedMisses.map((row) => ({
      date: row.date,
      difficulty: row.difficulty,
      missedReason: row.missedReason,
      completed: false,
      note: row.note,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const latestRevisionRow = latestRevisionRows[0];
  const currentRevision = latestRevisionRow?.revision ?? 0;
  const revisionScopedCheckins = journeyDays.length
    ? checkinsForPlanRevision(scheduledCheckins, journeyDays, currentRevision)
    : latestRevisionRow
      ? scheduledCheckins.filter((row) => row.date >= latestRevisionRow.effectiveFrom)
      : scheduledCheckins;
  const numericHistory = [
    ...revisionScopedCheckins,
    ...reflectedMisses
      .filter((row) => row.planRevision === currentRevision)
      .map((row) => ({
        date: row.date,
        difficulty: row.difficulty,
        missedReason: row.missedReason,
        completed: false,
        note: row.note,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const currentMinimum = effectiveMinimum(habit.targetValue, habit.minimumValue);
  const proposal = proposeHabitAdaptation({
    targetValue: habit.targetValue,
    minimumValue: currentMinimum,
    busyDayValue: habit.busyDayValue,
    goalType: habit.goalType,
    successLimitValue: habit.successLimitValue,
    baselineValue: habit.baselineValue,
    minimumFloor: habit.minimumFloor,
    checkins: [...analysisHistory].reverse(),
    numericCheckins: [...numericHistory].reverse(),
  });
  const missedDays = journeyDays.length
    ? journeyDays.filter((day) => day.scheduled && day.date < today && !recordedDates.has(day.date)).length
    : missedScheduledDays(
      habit.cadence, habit.customDays, history.map((row) => row.date), today, habit.createdAt,
    );
  const phrasing = await habitAdaptationMessages({
    reason: proposal.reason,
    missedReason: proposal.missedReason,
    changedTarget: proposal.targetValue !== habit.targetValue,
    changedMinimum: proposal.minimumValue !== currentMinimum,
    hasBusyDayOption: proposal.busyDayValue != null,
  });
  res.json({
    habitId: habit.id,
    ...proposal,
    suggestion: proposal.targetValue !== habit.targetValue
      || proposal.minimumValue !== currentMinimum
      || proposal.successLimitValue !== habit.successLimitValue
      || proposal.busyDayValue !== habit.busyDayValue,
    expectedTargetValue: habit.targetValue,
    expectedMinimumValue: currentMinimum,
    expectedSuccessLimitValue: habit.successLimitValue,
    newSuccessLimitValue: proposal.successLimitValue,
    actions: {
      cue: proposal.missedReason === "forgot"
        ? "اربطها بإشارة يومية ثابتة تختارها"
        : habit.cue,
      startAction: proposal.missedReason === "lost_motivation"
        ? "ابدأ بأصغر خطوة في العادة التي اخترتها"
        : habit.startAction,
      busyDayValue: proposal.busyDayValue,
    },
    phrasing,
    coachMessage: phrasing.explanation,
    missedDays,
  });
});

router.patch("/habits/:habitId", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const params = UpdateHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    expectedTargetValue, expectedMinimumValue, expectedSuccessLimitValue, ...changes
  } = parsed.data;
  const today = todayInTimezone(user.timezone);
  const outcome = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(habitsTable).where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
    )).for("update");
    if (!before) return { kind: "not_found" } as const;
    const currentMinimum = effectiveMinimum(before.targetValue, before.minimumValue);
    const guardStatus = validateHabitPlanUpdate({
      expectedTargetValue,
      expectedMinimumValue,
      expectedSuccessLimitValue,
    }, {
      targetValue: before.targetValue,
      minimumValue: currentMinimum,
      successLimitValue: before.successLimitValue,
    }, Object.keys(changes).length > 0);
    if (guardStatus === "conflict") {
      return { kind: "conflict" } as const;
    }
    if (guardStatus === "empty") {
      return { kind: "invalid", error: "At least one habit field must be updated" } as const;
    }

    const nextGoalType = changes.goalType ?? before.goalType;
    const nextUnit = changes.unit ?? before.unit;
    const nextExecutionType = resolveExecutionType(
      nextUnit,
      nextGoalType,
      changes.executionType ?? (
        changes.unit !== undefined || changes.goalType !== undefined
          ? null
          : before.executionType
      ),
    );
    if ((nextGoalType === "quit" && nextExecutionType !== "limit")
      || (nextGoalType === "build" && nextExecutionType === "limit")) {
      return { kind: "invalid", error: "Reduce habits use limit execution; build habits cannot use limit execution" } as const;
    }
    if (changes.executionType === undefined
      && (changes.unit !== undefined || changes.goalType !== undefined)) {
      changes.executionType = nextExecutionType;
    }
    const nextCadence = changes.cadence ?? before.cadence;
    const nextCustomDays = changes.customDays ?? before.customDays;
    if (nextCadence === "custom_days" && (!nextCustomDays || nextCustomDays.length === 0)) {
      return { kind: "invalid", error: "Custom cadence requires at least one selected weekday" } as const;
    }
    const nextTarget = changes.targetValue ?? before.targetValue;
    if (changes.targetValue !== undefined && changes.minimumValue === undefined) {
      changes.minimumValue = Math.min(currentMinimum, nextTarget);
      if (before.busyDayValue != null && changes.busyDayValue === undefined) {
        changes.busyDayValue = Math.min(before.busyDayValue, changes.minimumValue);
      }
    }
    const nextMinimum = changes.minimumValue ?? currentMinimum;
    const nextFloor = changes.minimumFloor ?? before.minimumFloor ?? defaultMinimumFloor(nextGoalType);
    if (nextGoalType === "build" && (nextTarget <= 0 || nextMinimum <= 0)) {
      return { kind: "invalid", error: "Build target and minimum must be positive" } as const;
    }
    if (nextGoalType === "quit" && nextTarget < 0) {
      return { kind: "invalid", error: "Reduce target cannot be negative" } as const;
    }
    if (nextMinimum < 0 || nextMinimum > nextTarget || nextFloor < 0 || nextFloor > nextTarget) {
      return { kind: "invalid", error: "Minimum and floor must be nonnegative and no greater than the target" } as const;
    }
    const nextBaseline = changes.baselineValue !== undefined ? changes.baselineValue : before.baselineValue;
    let nextSuccessLimit = changes.successLimitValue !== undefined
      ? changes.successLimitValue
      : before.successLimitValue;
    if (nextGoalType === "quit") {
      if (nextBaseline == null || nextBaseline < nextTarget) {
        return { kind: "invalid", error: "Reduce habits require a confirmed baseline at or above the target" } as const;
      }
      if (nextSuccessLimit == null && before.goalType !== "quit") nextSuccessLimit = nextTarget;
      if (nextSuccessLimit == null || nextSuccessLimit < nextTarget) {
        return { kind: "invalid", error: "Reduce success limit must be at or above its target" } as const;
      }
      if (changes.successLimitValue === undefined && before.goalType !== "quit") {
        changes.successLimitValue = nextSuccessLimit;
      }
    } else if (before.goalType === "quit" && changes.successLimitValue === undefined) {
      changes.successLimitValue = null;
      nextSuccessLimit = null;
    }
    const nextBusyDay = changes.busyDayValue !== undefined ? changes.busyDayValue : before.busyDayValue;
    if (nextBusyDay != null && (nextBusyDay < 0 || nextBusyDay > nextMinimum)) {
      return { kind: "invalid", error: "Busy-day value must be nonnegative and no greater than the minimum" } as const;
    }
    let journeyStartDate = before.journeyStartDate;
    let journeyLength = before.journeyLength;
    const askedForJourney = changes.journeyStartDate !== undefined || changes.journeyLength !== undefined;
    if (askedForJourney) {
      const requestedStartInput = changes.journeyStartDate;
      const requestedStart = requestedStartInput == null
        ? journeyStartDate ?? today
        : typeof requestedStartInput === "string"
          ? requestedStartInput
          : toDateOnly(requestedStartInput);
      const requestedLength = changes.journeyLength ?? journeyLength ?? HABIT_JOURNEY_LENGTH;
      if (journeyStartDate != null && requestedStart !== journeyStartDate) {
        return { kind: "invalid", error: "Journey start date is immutable once assigned" } as const;
      }
      if (journeyLength != null && requestedLength !== journeyLength) {
        return { kind: "invalid", error: "Journey length is immutable once assigned" } as const;
      }
      if (requestedStart < today || requestedLength !== HABIT_JOURNEY_LENGTH) {
        return { kind: "invalid", error: "A journey must be 22 days and cannot start before today in your timezone" } as const;
      }
      if (journeyStartDate == null) {
        const [existingDay] = await tx.select({ id: habitDaysTable.id }).from(habitDaysTable)
          .where(eq(habitDaysTable.habitId, before.id)).limit(1);
        const [existingCheckin] = await tx.select({ id: checkinsTable.id }).from(checkinsTable)
          .where(eq(checkinsTable.habitId, before.id)).limit(1);
        if (existingDay || existingCheckin) {
          return { kind: "invalid", error: "A journey cannot be initialized after a habit already has day history" } as const;
        }
        journeyStartDate = requestedStart;
        journeyLength = requestedLength;
        changes.journeyStartDate = new Date(`${requestedStart}T00:00:00.000Z`);
        changes.journeyLength = requestedLength;
      }
    }

    const rewardIdsToLock = [...new Set<number>(
      [before.rewardId, changes.rewardId].filter((id): id is number => id != null),
    )].sort((left, right) => left - right);
    let nextRewardExists = changes.rewardId == null;
    for (const rewardId of rewardIdsToLock) {
      const [reward] = await tx.select({ id: rewardsTable.id }).from(rewardsTable).where(and(
        eq(rewardsTable.id, rewardId),
        eq(rewardsTable.userId, req.userId!),
      )).for("update");
      if (rewardId === changes.rewardId) nextRewardExists = reward != null;
    }
    if (!nextRewardExists) return { kind: "invalid", error: "Reward not found for this user" } as const;
    if (
      before.rewardId != null
      && changes.rewardId !== undefined
      && changes.rewardId !== before.rewardId
    ) {
      await preserveJourneyRewardGate(tx, req.userId!, before, today);
    }

    const planFields = [
      "targetValue", "minimumValue", "busyDayValue", "successLimitValue", "minimumFloor",
      "goalType", "cueType", "cueTime", "cue", "startAction", "friction", "baselineValue",
      "cadence", "customDays", "unit", "executionType", "title",
    ] as const;
    const planChanged = planFields.some((field) => changes[field] !== undefined);
    const { journeyStartDate: requestedDate, ...habitChanges } = changes;
    void requestedDate;
    const updateChanges = {
      ...habitChanges,
      ...(journeyStartDate !== before.journeyStartDate && journeyStartDate !== null
        ? { journeyStartDate }
        : {}),
    };
    const [habit] = await tx.update(habitsTable).set(updateChanges)
      .where(and(eq(habitsTable.id, before.id), eq(habitsTable.userId, req.userId!)))
      .returning();

    if (journeyStartDate && journeyLength && before.journeyStartDate == null) {
      await tx.insert(habitDaysTable).values(makeJourneyDays(habit.id, journeyStartDate, journeyLength, {
        targetValue: habit.targetValue,
        minimumValue: habit.minimumValue ?? habit.targetValue,
        busyDayValue: habit.busyDayValue,
        successLimitValue: habit.successLimitValue,
        goalType: habit.goalType,
        title: habit.title,
        unit: habit.unit,
        executionType: nextExecutionType,
        cueType: habit.cueType,
        cueTime: habit.cueTime,
        cue: habit.cue,
        startAction: habit.startAction,
        planRevision: 1,
        cadence: habit.cadence,
        customDays: habit.customDays,
      }));
      const initialPlan = snapshotPlan({
        title: habit.title,
        cadence: habit.cadence,
        customDays: habit.customDays,
        targetValue: habit.targetValue,
        minimumValue: habit.minimumValue ?? habit.targetValue,
        busyDayValue: habit.busyDayValue,
        successLimitValue: habit.successLimitValue,
        minimumFloor: habit.minimumFloor,
        goalType: habit.goalType,
        unit: habit.unit,
        executionType: nextExecutionType,
        cueType: habit.cueType,
        cueTime: habit.cueTime,
        cue: habit.cue,
        startAction: habit.startAction,
        friction: habit.friction,
      });
      await tx.insert(habitPlanRevisionsTable).values({
        habitId: habit.id, revision: 1, effectiveFrom: journeyStartDate, plan: initialPlan,
      });
    } else if (planChanged) {
      const [latest] = await tx.select({ revision: habitPlanRevisionsTable.revision })
        .from(habitPlanRevisionsTable)
        .where(eq(habitPlanRevisionsTable.habitId, habit.id))
        .orderBy(desc(habitPlanRevisionsTable.revision)).limit(1);
      const revision = (latest?.revision ?? 0) + 1;
      const effectiveFrom = addCalendarDays(today, 1);
      const revisionPlan = snapshotPlan({
        title: habit.title,
        cadence: habit.cadence,
        customDays: habit.customDays,
        targetValue: habit.targetValue,
        minimumValue: habit.minimumValue ?? habit.targetValue,
        busyDayValue: habit.busyDayValue,
        successLimitValue: habit.successLimitValue,
        minimumFloor: habit.minimumFloor,
        goalType: habit.goalType,
        unit: habit.unit,
        executionType: nextExecutionType,
        cueType: habit.cueType,
        cueTime: habit.cueTime,
        cue: habit.cue,
        startAction: habit.startAction,
        friction: habit.friction,
      });
      await tx.insert(habitPlanRevisionsTable).values({
        habitId: habit.id, revision, effectiveFrom, plan: revisionPlan,
      });
      await reviseFutureUnrecordedDays(tx, habit.id, today, revision, {
        title: habit.title,
        targetValue: habit.targetValue,
        minimumValue: habit.minimumValue ?? habit.targetValue,
        busyDayValue: habit.busyDayValue,
        successLimitValue: habit.successLimitValue,
        goalType: habit.goalType,
        cadence: habit.cadence,
        customDays: habit.customDays,
        unit: habit.unit,
        executionType: nextExecutionType,
        cueType: habit.cueType,
        cueTime: habit.cueTime,
        cue: habit.cue,
        startAction: habit.startAction,
      }, journeyStartDate);
    }
    await preserveJourneyRewardGate(tx, req.userId!, habit, today);
    return { kind: "ok", habit } as const;
  });

  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  if (outcome.kind === "conflict") {
    res.status(409).json({ error: "Habit plan changed since the suggestion was made; request a new suggestion" });
    return;
  }
  if (outcome.kind === "invalid") {
    res.status(400).json({ error: outcome.error });
    return;
  }
  res.json(UpdateHabitResponse.parse(outcome.habit));
});

router.delete("/habits/:habitId", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const params = DeleteHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(habitsTable).where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
    )).for("update");
    if (!before) return null;
    await preserveJourneyRewardGate(tx, req.userId!, before, todayInTimezone(user.timezone));
    const [habit] = await tx.delete(habitsTable).where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
    )).returning();
    return habit ?? null;
  });

  if (!deleted) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
