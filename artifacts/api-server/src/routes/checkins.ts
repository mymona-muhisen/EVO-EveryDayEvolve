import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, habitsTable, checkinsTable } from "@workspace/db";
import {
  ListHabitCheckinsQueryParams,
  ListHabitCheckinsResponse,
  CreateCheckinParams,
  CreateCheckinBody,
  CreateCheckinResponse,
  RecoverStreakParams,
  RecoverStreakResponse,
  UpdateCheckinReflectionParams,
  UpdateCheckinReflectionBody,
  UpdateCheckinReflectionResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { grantRewards, spendCoins } from "../lib/gamificationService";
import {
  coinsForCheckin,
  continuesStreak,
  recoverStreakCost,
  xpForDifficulty,
} from "../lib/rules";
import { toDateOnly, coerceQueryDates } from "../lib/dates";
import { effectiveMinimum, evaluateHabitCheckin } from "../lib/aiRules";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/checkins", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListHabitCheckinsQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["from", "to"]),
  );
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, query.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const conditions = [eq(checkinsTable.habitId, query.data.habitId)];
  if (query.data.from) conditions.push(gte(checkinsTable.date, toDateOnly(query.data.from)));
  if (query.data.to) conditions.push(lte(checkinsTable.date, toDateOnly(query.data.to)));

  const checkins = await db
    .select()
    .from(checkinsTable)
    .where(and(...conditions))
    .orderBy(checkinsTable.date);

  res.json(ListHabitCheckinsResponse.parse(checkins));
});

router.post("/habits/:habitId/checkins", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = CreateCheckinParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateCheckinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

  const date = toDateOnly(parsed.data.date);
  const { value, note, moodRating, difficulty, missedReason } = parsed.data;

  const [existing] = await db
    .select()
    .from(checkinsTable)
    .where(and(eq(checkinsTable.habitId, habit.id), eq(checkinsTable.date, date)));
  const isNewDay = !existing;
  const targetSnapshot = existing?.targetSnapshot ?? habit.targetValue;
  const minimumSnapshot = existing?.minimumSnapshot
    ?? effectiveMinimum(habit.targetValue, habit.minimumValue);
  const successLimitSnapshot = existing?.successLimitSnapshot ?? habit.successLimitValue;
  const evaluation = evaluateHabitCheckin({
    goalType: habit.goalType,
    targetValue: targetSnapshot,
    minimumValue: minimumSnapshot,
    successLimitValue: successLimitSnapshot,
    value,
    legacyCompleted: parsed.data.completed,
  });
  const { completed, targetCompleted } = evaluation;
  if (existing?.completed && !completed) {
    res.status(409).json({ error: "A successful check-in cannot be changed to incomplete" });
    return;
  }

  let newStreak = habit.currentStreak;
  let longestStreak = habit.longestStreak;
  let coinsEarned = existing?.coinsEarned ?? 0;
  let bonusCoins = 0;
  let lastBrokenStreak = habit.lastBrokenStreak;
  let streakBrokenAt = habit.streakBrokenAt;
  let lastCheckinDate = habit.lastCheckinDate;

  if (isNewDay || (completed && !existing?.completed)) {
    if (completed) {
      const continues = continuesStreak(habit.cadence, habit.lastCheckinDate, date, habit.customDays);
      newStreak = continues ? habit.currentStreak + 1 : 1;
      longestStreak = Math.max(longestStreak, newStreak);
      const { base, bonus } = coinsForCheckin(habit.difficulty, newStreak);
      coinsEarned = base + bonus;
      bonusCoins = bonus;
      lastBrokenStreak = null;
      streakBrokenAt = null;
      lastCheckinDate = date;
    } else if (habit.currentStreak > 0) {
      lastBrokenStreak = habit.currentStreak;
      streakBrokenAt = date;
      newStreak = 0;
    }
  }

  const [checkin] = await db
    .insert(checkinsTable)
    .values({
      habitId: habit.id,
      userId: req.userId!,
      date,
      completed,
      value: value ?? null,
      note: note ?? null,
      moodRating: moodRating ?? null,
      difficulty: difficulty ?? null,
      missedReason: missedReason ?? null,
      targetSnapshot,
      minimumSnapshot,
      successLimitSnapshot,
      targetCompleted,
      rewardGranted: false,
      coinsEarned: 0,
    })
    .onConflictDoUpdate({
      target: [checkinsTable.habitId, checkinsTable.date],
      set: {
        completed,
        value: value ?? null,
        note: note ?? null,
        moodRating: moodRating ?? null,
        difficulty: difficulty ?? null,
        missedReason: missedReason ?? null,
        targetCompleted,
      },
    })
    .returning();

  const [updatedHabit] = await db
    .update(habitsTable)
    .set({
      currentStreak: newStreak,
      longestStreak,
      lastCheckinDate,
      lastBrokenStreak,
      streakBrokenAt,
    })
    .where(eq(habitsTable.id, habit.id))
    .returning();

  const alreadyRewarded = Boolean(existing?.rewardGranted || (existing?.coinsEarned ?? 0) > 0);
  let rewardClaimed = false;
  if (completed && !alreadyRewarded) {
    const [claimed] = await db.update(checkinsTable)
      .set({ rewardGranted: true, coinsEarned })
      .where(and(eq(checkinsTable.id, checkin.id), eq(checkinsTable.rewardGranted, false)))
      .returning({ id: checkinsTable.id });
    rewardClaimed = Boolean(claimed);
  }

  if (rewardClaimed) {
    const baseCoins = coinsEarned - bonusCoins;
    await grantRewards(req.userId!, {
      xp: xpForDifficulty(habit.difficulty),
      coins: baseCoins,
      reason: "checkin",
    });
    if (bonusCoins > 0) {
      await grantRewards(req.userId!, { coins: bonusCoins, reason: "streak_bonus" });
    }
  }

  res.status(201).json(
    CreateCheckinResponse.parse({
      ...checkin,
      completed,
      targetCompleted,
      coinsEarned: rewardClaimed ? coinsEarned : checkin.coinsEarned,
      newStreak,
      habit: updatedHabit,
    }),
  );
});

router.patch("/habits/:habitId/checkins/:date", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = UpdateCheckinReflectionParams.safeParse(
    coerceQueryDates(req.params as Record<string, unknown>, ["date"]),
  );
  const parsed = UpdateCheckinReflectionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [habit] = await db.select({ id: habitsTable.id })
    .from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  const [checkin] = await db.update(checkinsTable)
    .set({
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.moodRating !== undefined ? { moodRating: parsed.data.moodRating } : {}),
      ...(parsed.data.difficulty !== undefined ? { difficulty: parsed.data.difficulty } : {}),
      ...(parsed.data.missedReason !== undefined ? { missedReason: parsed.data.missedReason } : {}),
    })
    .where(and(
      eq(checkinsTable.habitId, params.data.habitId),
      eq(checkinsTable.userId, req.userId!),
      eq(checkinsTable.date, toDateOnly(params.data.date)),
    ))
    .returning();
  if (!checkin) {
    res.status(404).json({ error: "Check-in not found" });
    return;
  }
  res.json(UpdateCheckinReflectionResponse.parse(checkin));
});

router.post("/habits/:habitId/recover-streak", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = RecoverStreakParams.safeParse(req.params);
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

  if (habit.lastBrokenStreak == null) {
    res.status(400).json({ error: "No broken streak to recover" });
    return;
  }

  const cost = recoverStreakCost(habit.lastBrokenStreak);
  const spendResult = await spendCoins(req.userId!, cost, "streak_recovery");
  if (!spendResult) {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }

  const [updatedHabit] = await db
    .update(habitsTable)
    .set({
      currentStreak: habit.lastBrokenStreak,
      lastBrokenStreak: null,
      streakBrokenAt: null,
    })
    .where(eq(habitsTable.id, habit.id))
    .returning();

  res.json(RecoverStreakResponse.parse({ habit: updatedHabit, coinsSpent: cost }));
});

export default router;
