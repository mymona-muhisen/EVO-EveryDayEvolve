import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, habitsTable, checkinsTable, usersTable } from "@workspace/db";
import {
  ListHabitCheckinsQueryParams,
  ListHabitCheckinsResponse,
  CreateCheckinParams,
  CreateCheckinBody,
  RecoverStreakParams,
  RecoverStreakResponse,
  UpdateCheckinReflectionParams,
  UpdateCheckinReflectionBody,
  UpdateCheckinReflectionResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { spendCoins } from "../lib/gamificationService";
import { recoverStreakCost } from "../lib/rules";
import { toDateOnly, coerceQueryDates } from "../lib/dates";
import { CheckinConflictError, recordCheckin } from "../lib/checkinService";

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

  try {
    const result = await recordCheckin(req.userId!, params.data.habitId, parsed.data);
    if (!result) {
      res.status(404).json({ error: "Habit not found" });
      return;
    }
    res.status(201).json(result);
  } catch (error) {
    if (!(error instanceof CheckinConflictError)) throw error;
    res.status(409).json({ error: error.message });
  }
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
  const checkin = await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!user) return { error: "User not found" } as const;
    const [habit] = await tx.select({ id: habitsTable.id }).from(habitsTable)
      .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)))
      .for("update");
    if (!habit) return { error: "Habit not found" } as const;
    const [row] = await tx.select({ id: checkinsTable.id }).from(checkinsTable).where(and(
      eq(checkinsTable.habitId, params.data.habitId),
      eq(checkinsTable.userId, req.userId!),
      eq(checkinsTable.date, toDateOnly(params.data.date)),
    )).for("update");
    if (!row) return { error: "Check-in not found" } as const;
    const [updated] = await tx.update(checkinsTable)
      .set({
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        ...(parsed.data.moodRating !== undefined ? { moodRating: parsed.data.moodRating } : {}),
        ...(parsed.data.difficulty !== undefined ? { difficulty: parsed.data.difficulty } : {}),
        ...(parsed.data.missedReason !== undefined ? { missedReason: parsed.data.missedReason } : {}),
      })
      .where(eq(checkinsTable.id, row.id))
      .returning();
    return { checkin: updated } as const;
  });
  if ("error" in checkin) {
    res.status(404).json({ error: checkin.error });
    return;
  }
  res.json(UpdateCheckinReflectionResponse.parse(checkin.checkin));
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
