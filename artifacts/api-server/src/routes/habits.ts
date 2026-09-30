import { Router, type IRouter } from "express";
import { eq, and, desc, or, isNull } from "drizzle-orm";
import { db, habitsTable, checkinsTable } from "@workspace/db";
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
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { effectiveMinimum, missedScheduledDays, proposeHabitAdaptation } from "../lib/aiRules";
import { habitAdaptationMessages } from "../lib/aiMessages";

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
  await ensureUser(req.userId!);
  const parsed = CreateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const minimumValue = parsed.data.minimumValue ?? parsed.data.targetValue;
  if (minimumValue > parsed.data.targetValue) {
    res.status(400).json({ error: "Minimum value cannot exceed target value" });
    return;
  }
  if (parsed.data.busyDayValue !== undefined
    && parsed.data.busyDayValue > minimumValue) {
    res.status(400).json({ error: "Busy-day value must be positive and no greater than the minimum value" });
    return;
  }

  const [habit] = await db
    .insert(habitsTable)
    .values({
      userId: req.userId!,
      ...parsed.data,
      minimumValue,
      busyDayValue: parsed.data.busyDayValue ?? null,
      baselineValue: parsed.data.baselineValue ?? null,
      successLimitValue: parsed.data.successLimitValue ?? null,
      customDays: parsed.data.customDays ?? null,
      milestones: parsed.data.milestones ?? [],
    })
    .returning();

  res.status(201).json(CreateHabitResponse.parse(habit));
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

router.get("/habits/:habitId/adaptation", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
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
  }).from(checkinsTable)
    .where(eq(checkinsTable.habitId, habit.id))
    .orderBy(desc(checkinsTable.date));
  const currentMinimum = effectiveMinimum(habit.targetValue, habit.minimumValue);
  const proposal = proposeHabitAdaptation({
    targetValue: habit.targetValue,
    minimumValue: currentMinimum,
    busyDayValue: habit.busyDayValue,
    checkins: history.reverse(),
  });
  const today = new Date().toISOString().slice(0, 10);
  const missedDays = missedScheduledDays(
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
      || proposal.busyDayValue !== habit.busyDayValue,
    expectedTargetValue: habit.targetValue,
    expectedMinimumValue: currentMinimum,
    phrasing,
    coachMessage: phrasing.explanation,
    missedDays,
  });
});

router.patch("/habits/:habitId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
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

  const { expectedTargetValue, expectedMinimumValue, ...changes } = parsed.data;
  if (changes.targetValue !== undefined && (!Number.isFinite(changes.targetValue) || changes.targetValue <= 0)) {
    res.status(400).json({ error: "Target value must be positive" });
    return;
  }
  if (expectedTargetValue !== undefined && (changes.targetValue === undefined || !Number.isFinite(expectedTargetValue) || expectedTargetValue <= 0)) {
    res.status(400).json({ error: "Expected target value requires a target update and must be positive" });
    return;
  }
  if (changes.minimumValue !== undefined && (!Number.isFinite(changes.minimumValue) || changes.minimumValue <= 0)) {
    res.status(400).json({ error: "Minimum value must be positive" });
    return;
  }
  if (expectedMinimumValue !== undefined && (changes.minimumValue === undefined || !Number.isFinite(expectedMinimumValue) || expectedMinimumValue <= 0)) {
    res.status(400).json({ error: "Expected minimum value requires a minimum update and must be positive" });
    return;
  }
  if (changes.targetValue !== undefined && changes.minimumValue !== undefined && changes.minimumValue > changes.targetValue) {
    res.status(400).json({ error: "Minimum value cannot exceed target value" });
    return;
  }
  const [before] = await db.select({
    id: habitsTable.id,
    targetValue: habitsTable.targetValue,
    minimumValue: habitsTable.minimumValue,
    busyDayValue: habitsTable.busyDayValue,
  }).from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (before) {
    if (changes.targetValue !== undefined && changes.minimumValue === undefined) {
      changes.minimumValue = Math.min(
        effectiveMinimum(before.targetValue, before.minimumValue),
        changes.targetValue,
      );
      if (before.busyDayValue != null) {
        changes.busyDayValue = Math.min(before.busyDayValue, changes.minimumValue);
      }
    }
    if (changes.minimumValue !== undefined && before.busyDayValue != null
      && changes.busyDayValue === undefined) {
      changes.busyDayValue = Math.min(before.busyDayValue, changes.minimumValue);
    }
    const nextTarget = changes.targetValue ?? before.targetValue;
    const nextMinimum = changes.minimumValue ?? effectiveMinimum(before.targetValue, before.minimumValue);
    if (nextMinimum > nextTarget) {
      res.status(400).json({ error: "Minimum value cannot exceed target value" });
      return;
    }
  }
  if (changes.busyDayValue !== undefined && changes.busyDayValue !== null) {
    const minimum = changes.minimumValue
      ?? (before ? effectiveMinimum(before.targetValue, before.minimumValue) : undefined);
    if (minimum !== undefined && changes.busyDayValue > minimum) {
      res.status(400).json({ error: "Busy-day value must be positive and no greater than the minimum value" });
      return;
    }
  }

  const [habit] = await db
    .update(habitsTable)
    .set(changes)
    .where(and(
      eq(habitsTable.id, params.data.habitId),
      eq(habitsTable.userId, req.userId!),
      ...(expectedTargetValue === undefined ? [] : [eq(habitsTable.targetValue, expectedTargetValue)]),
      ...(expectedMinimumValue === undefined ? [] : [or(
        eq(habitsTable.minimumValue, expectedMinimumValue),
        and(isNull(habitsTable.minimumValue), eq(habitsTable.targetValue, expectedMinimumValue)),
      )!]),
    ))
    .returning();

  if (!habit) {
    if (expectedTargetValue !== undefined || expectedMinimumValue !== undefined) {
      const [existing] = await db.select({ id: habitsTable.id }).from(habitsTable)
        .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));
      if (existing) {
        res.status(409).json({ error: "Habit target changed since the suggestion was made; request a new suggestion" });
        return;
      }
    }
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.json(UpdateHabitResponse.parse(habit));
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
