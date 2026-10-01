import { and, desc, eq, lte } from "drizzle-orm";
import {
  db,
  habitsTable,
  usersTable,
  habitDaysTable,
  habitPlanRevisionsTable,
  habitDailyExecutionsTable,
  habitDailyActionKeysTable,
  checkinsTable,
  type HabitPlanJson,
  type HabitRow,
  type HabitDailyExecutionRow,
} from "@workspace/db";
import {
  ChangeDailyHabitExecutionBody,
  ChangeDailyHabitExecutionResponse,
  CreateCheckinBody,
  GetDailyHabitDayResponse,
  GetDailyOverviewResponse,
  RecordDailyAdaptationDecisionBody,
  RecordDailyAdaptationDecisionResponse,
  SaveDailyHabitReflectionBody,
  SaveDailyHabitReflectionResponse,
} from "@workspace/api-zod";
import type { z } from "zod";
import { recordCheckinInTransaction, CheckinConflictError } from "./checkinService";
import { effectiveMinimum } from "./aiRules";
import {
  addCalendarDays, isScheduledDate, isWithinJourneyWindow, journeyDayNumber, resolveExecutionType,
} from "./habitJourney";
import { todayInTimezone, toDateOnly } from "./dates";
import {
  DailyExecutionTransitionError,
  elapsedSecondsAt,
  transitionDailyExecution,
  type DailyPlan,
} from "./dailyExecution";

type DailyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DailyState = z.infer<typeof GetDailyHabitDayResponse>;
type ActionInput = z.infer<typeof ChangeDailyHabitExecutionBody>;
type ReflectionInput = z.infer<typeof SaveDailyHabitReflectionBody>;
type DecisionInput = z.infer<typeof RecordDailyAdaptationDecisionBody>;

export class DailyServiceError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409 | 400 = 409) {
    super(message);
  }
}

type PlanSnapshot = DailyPlan & {
  title: string;
  dayNumber: number;
  scheduled: boolean;
  planRevision: number;
  unit: "minutes" | "count" | "pages" | "custom";
  busyDayValue: number | null;
  cueType: "time" | "routine" | "custom" | null;
  cueTime: string | null;
  cue: string | null;
  startAction: string | null;
};

async function lockUserAndHabit(tx: DailyTransaction, userId: string, habitId: number): Promise<HabitRow> {
  const [user] = await tx.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.id, userId)).for("update");
  if (!user) throw new DailyServiceError("User not found", 404);
  const [habit] = await tx.select().from(habitsTable)
    .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)))
    .for("update");
  if (!habit) throw new DailyServiceError("Habit not found", 404);
  return habit;
}

function dayDifference(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

function localDayStart(date: string, timezone: string): Date {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const difference = represented - target;
    if (difference === 0) break;
    guess -= difference;
  }
  return new Date(guess);
}

async function planForDate(
  tx: DailyTransaction,
  habit: HabitRow,
  date: string,
  today: string,
): Promise<PlanSnapshot> {
  const hasStart = habit.journeyStartDate != null;
  const hasLength = habit.journeyLength != null;
  if (hasStart !== hasLength) {
    throw new DailyServiceError(`Habit ${habit.id} has an incomplete journey definition`, 409);
  }

  if (hasStart && hasLength) {
    const start = habit.journeyStartDate!;
    const end = addCalendarDays(start, habit.journeyLength! - 1);
    if (date < start || date > end) {
      throw new DailyServiceError("This date is outside the habit's journey", 409);
    }
    const [day] = await tx.select().from(habitDaysTable).where(and(
      eq(habitDaysTable.habitId, habit.id),
      eq(habitDaysTable.date, date),
    ));
    if (!day) {
      throw new DailyServiceError(`Habit ${habit.id} is missing its plan snapshot for ${date}`, 409);
    }
    const [revision] = await tx.select({ plan: habitPlanRevisionsTable.plan })
      .from(habitPlanRevisionsTable).where(and(
        eq(habitPlanRevisionsTable.habitId, habit.id),
        eq(habitPlanRevisionsTable.revision, day.planRevision),
      )).limit(1);
    const revisionPlan = revision?.plan as HabitPlanJson | undefined;
    const unit = day.unit ?? revisionPlan?.unit ?? habit.unit;
    return {
      title: day.title ?? revisionPlan?.title ?? habit.title,
      dayNumber: journeyDayNumber(date, start),
      scheduled: day.scheduled,
      planRevision: day.planRevision,
      targetValue: day.targetValue,
      minimumValue: day.minimumValue,
      busyDayValue: day.busyDayValue,
      successLimitValue: day.successLimitValue,
      goalType: day.goalType,
      unit,
      executionType: day.executionType ?? revisionPlan?.executionType
        ?? resolveExecutionType(unit, day.goalType),
      cueType: day.cueType ?? revisionPlan?.cueType ?? null,
      cueTime: day.cueTime ?? revisionPlan?.cueTime ?? null,
      cue: day.cue ?? revisionPlan?.cue ?? null,
      startAction: day.startAction ?? revisionPlan?.startAction ?? null,
    };
  }

  // A legacy habit has no immutable 22-day plan. Only today's cadence is
  // schedulable; historical check-ins remain visible but no old obligation is
  // silently invented from the current live plan.
  const anchor = toDateOnly(habit.createdAt);
  if (date < anchor) throw new DailyServiceError("This date predates the habit", 409);
  const dayNumber = dayDifference(anchor, date) + 1;
  const scheduled = date === today && isScheduledDate(date, dayNumber, habit.cadence, habit.customDays);
  return {
    title: habit.title,
    dayNumber,
    scheduled,
    planRevision: 0,
    targetValue: habit.targetValue,
    minimumValue: effectiveMinimum(habit.targetValue, habit.minimumValue),
    busyDayValue: habit.busyDayValue,
    successLimitValue: habit.successLimitValue,
    goalType: habit.goalType,
    unit: habit.unit,
    executionType: resolveExecutionType(habit.unit, habit.goalType, habit.executionType),
    cueType: habit.cueType,
    cueTime: habit.cueTime,
    cue: habit.cue,
    startAction: habit.startAction,
  };
}

async function loadCheckin(tx: DailyTransaction, habitId: number, date: string) {
  const [checkin] = await tx.select().from(checkinsTable).where(and(
    eq(checkinsTable.habitId, habitId),
    eq(checkinsTable.date, date),
  )).for("update");
  return checkin ?? null;
}

async function materializeExecution(
  tx: DailyTransaction,
  habit: HabitRow,
  plan: PlanSnapshot,
  date: string,
  today: string,
  timezone: string,
  now: Date,
): Promise<HabitDailyExecutionRow | null> {
  if (date > today) return null;
  let [execution] = await tx.select().from(habitDailyExecutionsTable).where(and(
    eq(habitDailyExecutionsTable.habitId, habit.id),
    eq(habitDailyExecutionsTable.date, date),
  )).for("update");
  if (!execution && !plan.scheduled) return null;
  const checkin = await loadCheckin(tx, habit.id, date);

  if (!execution) {
    const initialStatus = checkin?.completed
      ? (checkin.note || checkin.difficulty ? "completed" : "pending_reflection")
      : date < today
        ? "missed"
        : checkin
          ? "in_progress"
          : "pending";
    await tx.insert(habitDailyExecutionsTable).values({
      habitId: habit.id,
      date,
      dayNumber: plan.dayNumber,
      scheduled: plan.scheduled,
      title: plan.title,
      targetValue: plan.targetValue,
      minimumValue: plan.minimumValue,
      busyDayValue: plan.busyDayValue,
      successLimitValue: plan.successLimitValue,
      goalType: plan.goalType,
      executionType: plan.executionType,
      unit: plan.unit,
      planRevision: plan.planRevision,
      cueType: plan.cueType,
      cueTime: plan.cueTime,
      cue: plan.cue,
      startAction: plan.startAction,
      status: initialStatus,
      actualValue: checkin?.value ?? null,
      missedReason: checkin?.missedReason ?? null,
      note: checkin?.note ?? null,
      difficulty: checkin?.difficulty ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    [execution] = await tx.select().from(habitDailyExecutionsTable).where(and(
      eq(habitDailyExecutionsTable.habitId, habit.id),
      eq(habitDailyExecutionsTable.date, date),
    )).for("update");
  }

  if (!execution) throw new Error(`Failed to materialize daily execution for habit ${habit.id}`);
  const updates: Partial<typeof habitDailyExecutionsTable.$inferInsert> = {};
  const canImportCompletedCheckin = !execution.lastResumedAt
    && !execution.pausedAt
    && ![
      "completed",
      "pending_reflection",
      "minimum_reached",
      "target_reached",
    ].includes(execution.status);
  const completedReflectionWasAdded = execution.status === "pending_reflection"
    && Boolean(checkin?.note || checkin?.difficulty);
  if (date < today && checkin?.completed) {
    if (canImportCompletedCheckin || completedReflectionWasAdded
      || execution.status === "minimum_reached" || execution.status === "target_reached") {
      updates.status = checkin.note || checkin.difficulty ? "completed" : "pending_reflection";
    }
    updates.actualValue = execution.actualValue ?? checkin.value;
    updates.note = execution.note ?? checkin.note;
    updates.difficulty = execution.difficulty ?? checkin.difficulty;
    if (execution.lastResumedAt && execution.executionType === "duration") {
      const expiredAt = localDayStart(addCalendarDays(date, 1), timezone);
      updates.actualSeconds = elapsedSecondsAt(execution, expiredAt);
      updates.lastResumedAt = null;
      updates.finishedAt = expiredAt;
    }
    updates.updatedAt = now;
  } else if (checkin?.completed && (canImportCompletedCheckin || completedReflectionWasAdded)) {
    updates.status = checkin.note || checkin.difficulty ? "completed" : "pending_reflection";
    updates.actualValue = execution.actualValue ?? checkin.value;
    updates.note = execution.note ?? checkin.note;
    updates.difficulty = execution.difficulty ?? checkin.difficulty;
    updates.updatedAt = now;
  } else if (date < today && execution.status !== "completed"
    && execution.status !== "pending_reflection" && execution.status !== "recovered") {
    if (execution.status !== "missed") {
      const expiredAt = localDayStart(addCalendarDays(date, 1), timezone);
      updates.status = "missed";
      updates.actualValue = execution.actualValue ?? checkin?.value ?? null;
      updates.missedReason = execution.missedReason ?? checkin?.missedReason ?? null;
      updates.note = execution.note ?? checkin?.note ?? null;
      updates.difficulty = execution.difficulty ?? checkin?.difficulty ?? null;
      if (execution.lastResumedAt && execution.executionType === "duration") {
        const actualSeconds = elapsedSecondsAt(execution, expiredAt);
        updates.actualSeconds = actualSeconds;
        updates.lastResumedAt = null;
        updates.finishedAt = expiredAt;
      }
      updates.updatedAt = now;
    }
  }
  if (Object.keys(updates).length) {
    [execution] = await tx.update(habitDailyExecutionsTable).set(updates)
      .where(eq(habitDailyExecutionsTable.id, execution.id)).returning();
  }
  return execution;
}

async function consistencyStats(
  tx: DailyTransaction,
  habit: HabitRow,
  today: string,
): Promise<{ successfulDays: number; eligibleDays: number }> {
  const checks = await tx.select({
    date: checkinsTable.date,
    completed: checkinsTable.completed,
  }).from(checkinsTable).where(eq(checkinsTable.habitId, habit.id));
  const checkinsByDate = new Map(checks.map((checkin) => [checkin.date, checkin]));

  if (habit.journeyStartDate && habit.journeyLength) {
    const days = await tx.select({
      date: habitDaysTable.date,
      scheduled: habitDaysTable.scheduled,
    }).from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id));
    const journeyDays = days.filter((day) => isWithinJourneyWindow(
      day.date, habit.journeyStartDate!, habit.journeyLength!,
    ));
    const elapsedScheduled = journeyDays.filter((day) => day.scheduled && day.date <= today);
    return {
      eligibleDays: elapsedScheduled.length,
      successfulDays: elapsedScheduled.filter((day) => checkinsByDate.get(day.date)?.completed).length,
    };
  }

  const anchor = toDateOnly(habit.createdAt);
  const savedDays = await tx.select({
    date: habitDailyExecutionsTable.date,
    scheduled: habitDailyExecutionsTable.scheduled,
  }).from(habitDailyExecutionsTable).where(eq(habitDailyExecutionsTable.habitId, habit.id));
  const savedScheduleByDate = new Map(savedDays.map((day) => [day.date, day.scheduled]));
  const known = new Set<string>();
  for (const [date, scheduled] of savedScheduleByDate) {
    if (scheduled && date >= anchor && date <= today) known.add(date);
  }
  for (const checkin of checks) {
    if (checkin.date < anchor || checkin.date > today) continue;
    const dayNumber = dayDifference(anchor, checkin.date) + 1;
    const scheduled = savedScheduleByDate.get(checkin.date)
      ?? isScheduledDate(checkin.date, dayNumber, habit.cadence, habit.customDays);
    if (scheduled) known.add(checkin.date);
  }
  if (today >= anchor) {
    const dayNumber = dayDifference(anchor, today) + 1;
    const scheduled = savedScheduleByDate.get(today)
      ?? isScheduledDate(today, dayNumber, habit.cadence, habit.customDays);
    if (scheduled) known.add(today);
  }
  return {
    eligibleDays: known.size,
    successfulDays: [...known].filter((date) => checkinsByDate.get(date)?.completed).length,
  };
}

function rewardMilestones(habit: HabitRow, date: string, today: string) {
  const start = habit.journeyStartDate ?? toDateOnly(habit.createdAt);
  const calendarPosition = date > today || date < start
    ? 0
    : Math.min(22, dayDifference(start, date) + 1);
  return [1, 5, 10, 15, 22].map((days) => ({ days, reached: calendarPosition >= days }));
}

function successfulCheckinStatus(note: string | null, difficulty: string | null) {
  return note || difficulty ? "completed" as const : "pending_reflection" as const;
}

async function stateInTransaction(
  tx: DailyTransaction,
  habit: HabitRow,
  date: string,
  today: string,
  timezone: string,
  now: Date,
): Promise<DailyState> {
  const plan = await planForDate(tx, habit, date, today);
  const execution = await materializeExecution(tx, habit, plan, date, today, timezone, now);
  const checkin = await loadCheckin(tx, habit.id, date);
  const stats = await consistencyStats(tx, habit, today);
  return GetDailyHabitDayResponse.parse({
    habitId: habit.id,
    date,
    dayNumber: habit.journeyStartDate != null
      ? journeyDayNumber(date, habit.journeyStartDate)
      : execution?.dayNumber ?? plan.dayNumber,
    scheduled: execution?.scheduled ?? plan.scheduled,
    eligible: (execution?.scheduled ?? plan.scheduled) && date <= today,
    planRevision: execution?.planRevision ?? plan.planRevision,
    title: execution?.title ?? plan.title,
    executionType: execution?.executionType ?? plan.executionType,
    unit: execution?.unit ?? plan.unit,
    targetValue: execution?.targetValue ?? plan.targetValue,
    minimumValue: execution?.minimumValue ?? plan.minimumValue,
    busyDayValue: execution?.busyDayValue ?? plan.busyDayValue,
    successLimitValue: execution?.successLimitValue ?? plan.successLimitValue,
    goalType: execution?.goalType ?? plan.goalType,
    cueType: execution?.cueType ?? plan.cueType,
    cueTime: execution?.cueTime ?? plan.cueTime,
    cue: execution?.cue ?? plan.cue,
    startAction: execution?.startAction ?? plan.startAction,
    status: execution?.status ?? (checkin?.completed ? "completed" : "pending"),
    actualValue: execution?.actualValue ?? checkin?.value ?? null,
    actualSeconds: execution?.actualSeconds ?? null,
    elapsedSeconds: execution ? elapsedSecondsAt(execution, now) : 0,
    startedAt: execution?.startedAt ?? null,
    lastResumedAt: execution?.lastResumedAt ?? null,
    pausedAt: execution?.pausedAt ?? null,
    pausedSeconds: execution?.pausedSeconds ?? 0,
    finishedAt: execution?.finishedAt ?? null,
    missedReason: execution?.missedReason ?? checkin?.missedReason ?? null,
    note: execution?.note ?? checkin?.note ?? null,
    difficulty: execution?.difficulty ?? checkin?.difficulty ?? null,
    revision: execution?.revision ?? 0,
    adaptationDecision: execution?.adaptationDecision ?? null,
    checkin,
    successfulDays: stats.successfulDays,
    eligibleDays: stats.eligibleDays,
    rewardMilestones: rewardMilestones(habit, date, today),
  });
}

export async function getDailyHabitState(
  userId: string,
  habitId: number,
  date: string,
  now = new Date(),
) {
  const user = await db.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, userId)).then(([row]) => row);
  if (!user) throw new DailyServiceError("User not found", 404);
  const today = todayInTimezone(user.timezone, now);
  return db.transaction(async (tx) => {
    const habit = await lockUserAndHabit(tx, userId, habitId);
    return GetDailyHabitDayResponse.parse(await stateInTransaction(tx, habit, date, today, user.timezone, now));
  });
}

function isAlreadyApplied(row: HabitDailyExecutionRow, input: ActionInput): boolean {
  if (input.action === "start" && row.lastResumedAt != null) return true;
  if (input.action === "pause" && row.status === "paused") return true;
  if (input.action === "resume" && row.lastResumedAt != null) return true;
  if ((input.action === "finish" || input.action === "done") && row.status === "completed") return true;
  if (input.action === "update_progress" && row.actualValue != null && input.value !== undefined) {
    const expected = row.executionType === "duration" ? Math.round(input.value) / 60 : input.value;
    return row.actualValue === expected;
  }
  return false;
}

export async function changeDailyHabitExecution(
  userId: string,
  habitId: number,
  input: ActionInput,
  now = new Date(),
) {
  const user = await db.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, userId)).then(([row]) => row);
  if (!user) throw new DailyServiceError("User not found", 404);
  const today = todayInTimezone(user.timezone, now);
  const date = toDateOnly(input.date);
  return db.transaction(async (tx) => {
    const habit = await lockUserAndHabit(tx, userId, habitId);
    if (!habit.isActive) throw new DailyServiceError("Inactive habits cannot start daily executions", 409);
    const plan = await planForDate(tx, habit, date, today);
    if (date !== today) {
      throw new DailyServiceError("Daily execution actions are available only for today", 409);
    }
    const row = await materializeExecution(tx, habit, plan, date, today, user.timezone, now);
    if (!row || !row.scheduled) {
      throw new DailyServiceError("This date is not scheduled for daily execution", 409);
    }

    const requestFingerprint = JSON.stringify({
      action: input.action,
      expectedRevision: input.expectedRevision,
      value: input.value ?? null,
    });
    if (input.idempotencyKey) {
      const [prior] = await tx.select().from(habitDailyActionKeysTable).where(and(
        eq(habitDailyActionKeysTable.habitId, habit.id),
        eq(habitDailyActionKeysTable.date, date),
        eq(habitDailyActionKeysTable.idempotencyKey, input.idempotencyKey),
      ));
      if (prior && (prior.action !== input.action || prior.requestFingerprint !== requestFingerprint)) {
        throw new DailyServiceError("Idempotency key was already used for a different request", 409);
      }
      if (prior) {
        return ChangeDailyHabitExecutionResponse.parse({
          execution: await stateInTransaction(tx, habit, date, today, user.timezone, now),
          rewardDelta: { xp: 0, coins: 0 },
        });
      }
    }
    if (isAlreadyApplied(row, input)) {
      return ChangeDailyHabitExecutionResponse.parse({
        execution: await stateInTransaction(tx, habit, date, today, user.timezone, now),
        rewardDelta: { xp: 0, coins: 0 },
      });
    }
    if (input.expectedRevision !== row.revision) {
      throw new DailyServiceError("Daily execution changed; refresh and retry", 409);
    }
    let transition: ReturnType<typeof transitionDailyExecution>;
    try {
      transition = transitionDailyExecution({
        executionType: row.executionType,
        goalType: row.goalType,
        targetValue: row.targetValue,
        minimumValue: row.minimumValue,
        successLimitValue: row.successLimitValue,
      }, row, input, now);
    } catch (error) {
      if (error instanceof DailyExecutionTransitionError) {
        throw new DailyServiceError(error.message, 409);
      }
      throw error;
    }

    const existingCheckin = await loadCheckin(tx, habit.id, date);
    const shouldPersistSuccessfulValue = transition.shouldRecordSuccess
      || (existingCheckin?.completed
        && ["finish", "done", "update_progress"].includes(input.action));
    let rewardDelta = { xp: 0, coins: 0 };
    if (shouldPersistSuccessfulValue) {
      const checkinInput = CreateCheckinBody.parse({
        date: new Date(`${date}T00:00:00.000Z`),
        completed: true,
        value: transition.updates.actualValue,
      });
      let recorded;
      try {
        recorded = await recordCheckinInTransaction(tx, userId, habit.id, checkinInput, {
          targetValue: row.targetValue,
          minimumValue: row.minimumValue,
          successLimitValue: row.successLimitValue,
          goalType: row.goalType,
        });
      } catch (error) {
        if (error instanceof CheckinConflictError) throw new DailyServiceError(error.message, 409);
        throw error;
      }
      if (!recorded) throw new DailyServiceError("Habit not found", 404);
      if (!recorded.completed) {
        throw new DailyServiceError("A previously successful check-in cannot be downgraded", 409);
      }
      rewardDelta = recorded.rewardDelta;
      if (input.action === "done") {
        transition.updates.status = row.note || row.difficulty ? "completed" : "pending_reflection";
      } else if (row.status === "completed" && input.action === "update_progress") {
        transition.updates.status = "completed";
      }
    }

    await tx.update(habitDailyExecutionsTable).set({
      ...transition.updates,
      idempotencyKey: input.idempotencyKey ?? null,
      revision: row.revision + 1,
      updatedAt: now,
    }).where(eq(habitDailyExecutionsTable.id, row.id));
    if (input.idempotencyKey) {
      await tx.insert(habitDailyActionKeysTable).values({
        habitId: habit.id,
        date,
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        requestFingerprint,
      }).onConflictDoNothing();
    }
    return ChangeDailyHabitExecutionResponse.parse({
      execution: await stateInTransaction(tx, habit, date, today, user.timezone, now),
      rewardDelta,
    });
  });
}

export async function saveDailyHabitReflection(
  userId: string,
  habitId: number,
  date: string,
  input: ReflectionInput,
  now = new Date(),
) {
  const user = await db.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, userId)).then(([row]) => row);
  if (!user) throw new DailyServiceError("User not found", 404);
  const today = todayInTimezone(user.timezone, now);
  return db.transaction(async (tx) => {
    const habit = await lockUserAndHabit(tx, userId, habitId);
    const plan = await planForDate(tx, habit, date, today);
    const row = await materializeExecution(tx, habit, plan, date, today, user.timezone, now);
    if (!row || !row.scheduled || date > today) {
      throw new DailyServiceError("Reflection is available only for scheduled elapsed dates", 409);
    }
    const checkin = await loadCheckin(tx, habitId, date);
    const isCompleted = row.status === "completed" || Boolean(checkin?.completed);
    const nextReason = input.missedReason !== undefined ? input.missedReason : row.missedReason;
    if (isCompleted && input.missedReason != null) {
      throw new DailyServiceError("Missed-day reasons cannot be attached to a successful completion", 409);
    }
    if (!isCompleted && row.status !== "missed") {
      throw new DailyServiceError("Only completed or expired missed days can be reflected", 409);
    }
    if (!isCompleted && !nextReason) {
      throw new DailyServiceError("Select the real reason this scheduled day was missed", 409);
    }

    let rewardDelta = { xp: 0, coins: 0 };
    if (isCompleted) {
      if (!checkin?.completed) {
        throw new DailyServiceError("Completed execution is missing its successful check-in", 409);
      }
      const checkinInput = CreateCheckinBody.parse({
        date: new Date(`${date}T00:00:00.000Z`),
        completed: true,
        ...((row.actualValue ?? checkin.value) == null ? {} : { value: row.actualValue ?? checkin.value }),
        ...(input.note == null || input.note === undefined ? {} : { note: input.note }),
        ...(input.difficulty == null || input.difficulty === undefined ? {} : { difficulty: input.difficulty }),
      });
       const recorded = await recordCheckinInTransaction(tx, userId, habit.id, checkinInput, {
         targetValue: row.targetValue,
         minimumValue: row.minimumValue,
         successLimitValue: row.successLimitValue,
         goalType: row.goalType,
       });
      if (!recorded) throw new DailyServiceError("Habit not found", 404);
      rewardDelta = recorded.rewardDelta;
      const reflectionUpdates = {
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      };
      if (Object.keys(reflectionUpdates).length) {
        await tx.update(checkinsTable).set(reflectionUpdates).where(and(
          eq(checkinsTable.habitId, habitId),
          eq(checkinsTable.date, date),
          eq(checkinsTable.userId, userId),
        ));
      }
    } else if (checkin) {
      const checkinInput = CreateCheckinBody.parse({
        date: new Date(`${date}T00:00:00.000Z`),
        completed: false,
        ...((row.actualValue ?? checkin.value) == null ? {} : { value: row.actualValue ?? checkin.value }),
        ...(input.note == null || input.note === undefined ? {} : { note: input.note }),
        ...(input.difficulty == null || input.difficulty === undefined ? {} : { difficulty: input.difficulty }),
        ...(nextReason == null ? {} : { missedReason: nextReason }),
      });
      await recordCheckinInTransaction(tx, userId, habit.id, checkinInput, {
        targetValue: row.targetValue,
        minimumValue: row.minimumValue,
        successLimitValue: row.successLimitValue,
        goalType: row.goalType,
      });
      const reflectionUpdates = {
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
        ...(input.missedReason !== undefined ? { missedReason: input.missedReason } : {}),
      };
      if (Object.keys(reflectionUpdates).length) {
        await tx.update(checkinsTable).set(reflectionUpdates).where(and(
          eq(checkinsTable.habitId, habitId),
          eq(checkinsTable.date, date),
          eq(checkinsTable.userId, userId),
        ));
      }
    }

    const nextNote = input.note !== undefined ? input.note : row.note;
    const nextDifficulty = input.difficulty !== undefined ? input.difficulty : row.difficulty;
    const nextStatus = row.status === "missed"
      ? "missed"
      : row.status === "minimum_reached" || row.status === "target_reached"
        ? row.status
        : successfulCheckinStatus(nextNote, nextDifficulty);
    await tx.update(habitDailyExecutionsTable).set({
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
      ...(input.missedReason !== undefined ? { missedReason: input.missedReason } : {}),
      status: nextStatus,
      revision: row.revision + 1,
      updatedAt: now,
    }).where(eq(habitDailyExecutionsTable.id, row.id));
    return SaveDailyHabitReflectionResponse.parse({
      execution: await stateInTransaction(tx, habit, date, today, user.timezone, now),
      rewardDelta,
    });
  });
}

export async function recordDailyAdaptationDecision(
  userId: string,
  habitId: number,
  date: string,
  input: DecisionInput,
  now = new Date(),
) {
  const user = await db.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, userId)).then(([row]) => row);
  if (!user) throw new DailyServiceError("User not found", 404);
  const today = todayInTimezone(user.timezone, now);
  return db.transaction(async (tx) => {
    const habit = await lockUserAndHabit(tx, userId, habitId);
    const plan = await planForDate(tx, habit, date, today);
    const row = await materializeExecution(tx, habit, plan, date, today, user.timezone, now);
    const checkin = row ? await loadCheckin(tx, habit.id, date) : null;
    const isMissedDecision = date < today
      && row?.status === "missed"
      && Boolean(row.missedReason);
    const isHardSuccessDecision = date === today
      && Boolean(row?.scheduled && checkin?.completed)
      && (row?.difficulty === "hard" || row?.difficulty === "very_hard"
        || checkin?.difficulty === "hard" || checkin?.difficulty === "very_hard");
    if (!row || !row.scheduled || (!isMissedDecision && !isHardSuccessDecision)) {
      throw new DailyServiceError("Adaptation decisions require a reflected missed day or today's real hard successful check-in", 409);
    }
    if (row.adaptationDecision === input.decision) {
      return RecordDailyAdaptationDecisionResponse.parse(
        await stateInTransaction(tx, habit, date, today, user.timezone, now),
      );
    }
    if (input.decision === "accepted") {
      const [latest] = await tx.select({ revision: habitPlanRevisionsTable.revision })
        .from(habitPlanRevisionsTable).where(eq(habitPlanRevisionsTable.habitId, habit.id))
        .orderBy(desc(habitPlanRevisionsTable.revision)).limit(1);
      if (!latest || latest.revision <= row.planRevision) {
        throw new DailyServiceError("Apply the proposed future plan with the habit compare-and-set update before accepting it", 409);
      }
    }
    await tx.update(habitDailyExecutionsTable).set({
      adaptationDecision: input.decision,
      revision: row.revision + 1,
      updatedAt: now,
    }).where(eq(habitDailyExecutionsTable.id, row.id));
    return RecordDailyAdaptationDecisionResponse.parse(
      await stateInTransaction(tx, habit, date, today, user.timezone, now),
    );
  });
}

async function nonActionableOverviewState(
  tx: DailyTransaction,
  habit: HabitRow,
  date: string,
  today: string,
) {
  const stats = await consistencyStats(tx, habit, today);
  const [latest] = await tx.select({ revision: habitPlanRevisionsTable.revision })
    .from(habitPlanRevisionsTable)
    .where(eq(habitPlanRevisionsTable.habitId, habit.id))
    .orderBy(desc(habitPlanRevisionsTable.revision))
    .limit(1);
  const dayNumber = habit.journeyStartDate && habit.journeyLength
    ? date < habit.journeyStartDate ? 0 : habit.journeyLength + 1
    : 0;
  return GetDailyHabitDayResponse.parse({
    habitId: habit.id,
    date,
    dayNumber,
    scheduled: false,
    eligible: false,
    planRevision: latest?.revision ?? 0,
    title: habit.title,
    executionType: resolveExecutionType(habit.unit, habit.goalType, habit.executionType),
    unit: habit.unit,
    targetValue: habit.targetValue,
    minimumValue: effectiveMinimum(habit.targetValue, habit.minimumValue),
    busyDayValue: habit.busyDayValue,
    successLimitValue: habit.successLimitValue,
    goalType: habit.goalType,
    cueType: habit.cueType,
    cueTime: habit.cueTime,
    cue: habit.cue,
    startAction: habit.startAction,
    status: "pending",
    actualValue: null,
    actualSeconds: null,
    elapsedSeconds: 0,
    startedAt: null,
    lastResumedAt: null,
    pausedAt: null,
    pausedSeconds: 0,
    finishedAt: null,
    missedReason: null,
    note: null,
    difficulty: null,
    revision: 0,
    adaptationDecision: null,
    checkin: null,
    successfulDays: stats.successfulDays,
    eligibleDays: stats.eligibleDays,
    rewardMilestones: rewardMilestones(habit, date, today),
  });
}

export async function getDailyOverview(
  userId: string,
  date: string,
  now = new Date(),
) {
  const user = await db.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, userId)).then(([row]) => row);
  if (!user) throw new DailyServiceError("User not found", 404);
  const today = todayInTimezone(user.timezone, now);
  const habits = await db.select().from(habitsTable).where(and(
    eq(habitsTable.userId, userId),
    eq(habitsTable.isActive, true),
  ));
  const items = [];
  for (const selectedHabit of habits) {
    const item = await db.transaction(async (tx) => {
      const habit = await lockUserAndHabit(tx, userId, selectedHabit.id);
      if (habit.journeyStartDate && habit.journeyLength) {
        const savedDays = await tx.select().from(habitDaysTable).where(and(
          eq(habitDaysTable.habitId, habit.id),
          eq(habitDaysTable.scheduled, true),
          lte(habitDaysTable.date, addCalendarDays(today, -1)),
        ));
        const expiredDays = savedDays.filter((day) => isWithinJourneyWindow(
          day.date, habit.journeyStartDate!, habit.journeyLength!,
        ));
        for (const day of expiredDays) {
          const [revision] = await tx.select({ plan: habitPlanRevisionsTable.plan })
            .from(habitPlanRevisionsTable).where(and(
              eq(habitPlanRevisionsTable.habitId, habit.id),
              eq(habitPlanRevisionsTable.revision, day.planRevision),
            )).limit(1);
          const revisionPlan = revision?.plan as HabitPlanJson | undefined;
          const unit = day.unit ?? revisionPlan?.unit ?? habit.unit;
          const dayPlan: PlanSnapshot = {
            title: day.title ?? revisionPlan?.title ?? habit.title,
            dayNumber: journeyDayNumber(day.date, habit.journeyStartDate!),
            scheduled: day.scheduled,
            planRevision: day.planRevision,
            targetValue: day.targetValue,
            minimumValue: day.minimumValue,
            busyDayValue: day.busyDayValue,
            successLimitValue: day.successLimitValue,
            goalType: day.goalType,
            unit,
            executionType: day.executionType ?? revisionPlan?.executionType
              ?? resolveExecutionType(unit, day.goalType),
            cueType: day.cueType ?? revisionPlan?.cueType ?? null,
            cueTime: day.cueTime ?? revisionPlan?.cueTime ?? null,
            cue: day.cue ?? revisionPlan?.cue ?? null,
            startAction: day.startAction ?? revisionPlan?.startAction ?? null,
          };
          await materializeExecution(tx, habit, dayPlan, day.date, today, user.timezone, now);
        }
      }
      const journeyEnd = habit.journeyStartDate && habit.journeyLength
        ? addCalendarDays(habit.journeyStartDate, habit.journeyLength - 1)
        : null;
      const outsideJourney = habit.journeyStartDate && habit.journeyLength
        ? date < habit.journeyStartDate || date > journeyEnd!
        : date < toDateOnly(habit.createdAt);
      const execution = outsideJourney
        ? await nonActionableOverviewState(tx, habit, date, today)
        : await stateInTransaction(tx, habit, date, today, user.timezone, now);
      return {
        habitId: habit.id,
        title: execution.title,
        executionType: execution.executionType,
        scheduledToday: execution.scheduled,
        successfulDays: execution.successfulDays,
        eligibleDays: execution.eligibleDays,
        execution,
        rewardMilestones: execution.rewardMilestones,
      };
    });
    items.push(item);
  }
  return GetDailyOverviewResponse.parse({ date, timezone: user.timezone, habits: items });
}
