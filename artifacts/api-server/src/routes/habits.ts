import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db, habitsTable, checkinsTable, habitDaysTable, habitPlanRevisionsTable,
  habitDailyExecutionsTable, rewardsTable,
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
  addCalendarDays, HABIT_JOURNEY_LENGTH, isScheduledDate, makeJourneyDays, snapshotPlan,
  resolveExecutionType,
} from "../lib/habitJourney";
import { reviseFutureUnrecordedDays } from "../lib/habitPlanService";

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

router.get("/habits/:habitId/journey", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const params = GetHabitJourneyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [habit] = await db.select().from(habitsTable).where(and(
    eq(habitsTable.id, params.data.habitId),
    eq(habitsTable.userId, req.userId!),
  ));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  const days = await db.select().from(habitDaysTable)
    .where(eq(habitDaysTable.habitId, habit.id))
    .orderBy(habitDaysTable.dayNumber);
  const [checkins, revisions] = days.length
    ? await Promise.all([
      db.select().from(checkinsTable).where(eq(checkinsTable.habitId, habit.id)),
      db.select().from(habitPlanRevisionsTable).where(eq(habitPlanRevisionsTable.habitId, habit.id)),
    ])
    : [[], []];
  const byDate = new Map(checkins.map((checkin) => [checkin.date, checkin]));
  const planByRevision = new Map(revisions.map((revision) => [revision.revision, revision.plan]));
  const scheduledDays = days.filter((day) => day.scheduled);
  const today = todayInTimezone(user.timezone);
  const startDate = habit.journeyStartDate;
  const elapsed = startDate
    ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1
    : 0;
  const payload = {
    habitId: habit.id,
    startDate,
    length: habit.journeyLength ?? 0,
    total: scheduledDays.length,
    completed: scheduledDays.filter((day) => byDate.has(day.date)).length,
    successful: scheduledDays.filter((day) => byDate.get(day.date)?.completed).length,
    currentDay: days.length === 0 || elapsed < 1 ? 0 : Math.min(days.length, elapsed),
    days: days.map((day) => {
      const plan = planByRevision.get(day.planRevision);
      return ({
      date: day.date,
      dayNumber: day.dayNumber,
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
      checkin: byDate.get(day.date) ?? null,
      });
    }),
  };
  res.json(GetHabitJourneyResponse.parse(payload));
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
  const [journeyDays, latestRevisionRows, dailyHistory] = await Promise.all([
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

    if (changes.rewardId !== undefined && changes.rewardId !== null) {
      const [reward] = await tx.select({ id: rewardsTable.id }).from(rewardsTable)
        .where(and(eq(rewardsTable.id, changes.rewardId), eq(rewardsTable.userId, req.userId!)))
        .for("update");
      if (!reward) return { kind: "invalid", error: "Reward not found for this user" } as const;
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
      });
    }
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
  await ensureUser(req.userId!);
  const params = DeleteHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [habit] = await db
    .delete(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)))
    .returning();

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
