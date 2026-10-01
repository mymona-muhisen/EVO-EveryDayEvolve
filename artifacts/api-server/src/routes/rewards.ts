import { Router, type IRouter } from "express";
import { eq, and, gte, sql } from "drizzle-orm";
import {
  db, rewardsTable, usersTable, coinTransactionsTable, habitsTable, habitDaysTable, checkinsTable,
} from "@workspace/db";
import {
  ListRewardsResponse,
  CreateRewardBody,
  CreateRewardResponse,
  UpdateRewardParams,
  UpdateRewardBody,
  UpdateRewardResponse,
  DeleteRewardParams,
  RedeemRewardParams,
  RedeemRewardResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { todayInTimezone } from "../lib/dates";
import { HABIT_JOURNEY_LENGTH, isWithinJourneyWindow } from "../lib/habitJourney";
import { evaluateJourneyLifecycle } from "../lib/journeyLifecycle";
import {
  journeysAssociatedWithReward, markJourneyRewardRequired, preserveJourneyRewardGate,
} from "../lib/journeyRewardGate";
import { synchronizeJourneyCompletion } from "../lib/journeyRewardService";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/rewards", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const rewards = await db
    .select()
    .from(rewardsTable)
    .where(eq(rewardsTable.userId, req.userId!))
    .orderBy(rewardsTable.createdAt);

  res.json(ListRewardsResponse.parse(rewards));
});

router.post("/rewards", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const parsed = CreateRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!owner) return { kind: "habit_not_found" } as const;
    const [habit] = parsed.data.habitId == null
      ? []
      : await tx.select().from(habitsTable).where(and(
        eq(habitsTable.id, parsed.data.habitId),
        eq(habitsTable.userId, req.userId!),
      )).for("update");
    if (parsed.data.habitId != null && !habit) return { kind: "habit_not_found" } as const;
    const [reward] = await tx
      .insert(rewardsTable)
      .values({
        userId: req.userId!,
        habitId: parsed.data.habitId ?? null,
        title: parsed.data.title,
        emoji: parsed.data.emoji,
        coinCost: parsed.data.coinCost,
      })
      .returning();
    if (habit) {
      await preserveJourneyRewardGate(tx, req.userId!, habit, todayInTimezone(user.timezone));
    }
    return { kind: "ok", reward } as const;
  });
  if (result.kind === "habit_not_found") {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.status(201).json(CreateRewardResponse.parse(result.reward));
});

router.patch("/rewards/:rewardId", async (req, res): Promise<void> => {
  const params = UpdateRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [reward] = await db
    .update(rewardsTable)
    .set(parsed.data)
    .where(and(eq(rewardsTable.id, params.data.rewardId), eq(rewardsTable.userId, req.userId!)))
    .returning();

  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  res.json(UpdateRewardResponse.parse(reward));
});

router.delete("/rewards/:rewardId", async (req, res): Promise<void> => {
  const params = DeleteRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [reward] = await db
    .delete(rewardsTable)
    .where(and(eq(rewardsTable.id, params.data.rewardId), eq(rewardsTable.userId, req.userId!)))
    .returning();

  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/rewards/:rewardId/redeem", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = RedeemRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!user) return { kind: "not_found" } as const;
    const [reward] = await tx.select().from(rewardsTable).where(and(
      eq(rewardsTable.id, params.data.rewardId),
      eq(rewardsTable.userId, req.userId!),
    )).for("update");
    if (!reward) return { kind: "not_found" } as const;
    if (reward.isRedeemed) return { kind: "redeemed" } as const;

    // A reward selected by one or more explicit 22-day journeys stays locked
    // until at least one selected journey has valid final-day eligibility.
    // Legacy and unselected rewards retain their previous redeem behavior.
    const selectedJourneys = await journeysAssociatedWithReward(tx, req.userId!, reward.id);
    const definedJourneys = selectedJourneys.filter((habit) =>
      habit.journeyStartDate != null && habit.journeyLength === HABIT_JOURNEY_LENGTH);
    let qualifyingJourneyFound = false;
    const today = todayInTimezone(user.timezone);
    for (const habit of definedJourneys) {
      const [days, checkins] = await Promise.all([
        tx.select().from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id)),
        tx.select().from(checkinsTable).where(eq(checkinsTable.habitId, habit.id)),
      ]);
      const journeyDays = days.filter((day) => isWithinJourneyWindow(
        day.date, habit.journeyStartDate!, habit.journeyLength!,
      ));
      const lifecycle = evaluateJourneyLifecycle({
        startDate: habit.journeyStartDate,
        length: habit.journeyLength,
        today,
        scheduledDates: journeyDays.filter((day) => day.scheduled).map((day) => day.date),
        successfulDates: new Set(checkins.filter((checkin) => checkin.completed).map((checkin) => checkin.date)),
        completedAt: habit.journeyCompletedAt,
      });
      await synchronizeJourneyCompletion(
        tx, req.userId!, habit, today, new Date(), lifecycle,
      );
      await markJourneyRewardRequired(
        tx, req.userId!, reward.id, lifecycle.status === "completed",
      );
      if (lifecycle.status === "completed") qualifyingJourneyFound = true;
    }
    if (definedJourneys.length > 0) {
      // An association discovered here may predate the API-side selection hook.
      // Persist the requirement, and persist unlock evidence only for a real
      // qualifying journey. Link removal cannot erase either value.
      await markJourneyRewardRequired(tx, req.userId!, reward.id, qualifyingJourneyFound);
    }
    const [gate] = await tx.select({
      journeyRequired: rewardsTable.journeyRequired,
      journeyUnlockedAt: rewardsTable.journeyUnlockedAt,
    }).from(rewardsTable).where(and(
      eq(rewardsTable.id, reward.id),
      eq(rewardsTable.userId, req.userId!),
    ));
    if (gate?.journeyRequired && gate.journeyUnlockedAt == null) {
      return { kind: "locked" } as const;
    }

    const [spendResult] = await tx.update(usersTable)
      .set({ coins: sql`${usersTable.coins} - ${reward.coinCost}` })
      .where(and(eq(usersTable.id, req.userId!), gte(usersTable.coins, reward.coinCost)))
      .returning();
    if (!spendResult) return { kind: "insufficient" } as const;
    await tx.insert(coinTransactionsTable).values({
      userId: req.userId!,
      amount: -reward.coinCost,
      reason: "reward_redemption",
    });
    const redeemedAt = new Date();
    const [updated] = await tx.update(rewardsTable)
      .set({ isRedeemed: true, redeemedAt })
      .where(and(
        eq(rewardsTable.id, reward.id),
        eq(rewardsTable.userId, req.userId!),
        eq(rewardsTable.isRedeemed, false),
      ))
      .returning();
    if (!updated) throw new Error("Reward redemption lost its locked reward row");
    return { kind: "ok" as const, reward: updated, coinsRemaining: spendResult.coins };
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Reward not found" });
    return;
  }
  if (result.kind === "redeemed") {
    res.status(400).json({ error: "Reward already redeemed" });
    return;
  }
  if (result.kind === "locked") {
    res.status(400).json({ error: "Complete a selected 22-day journey before redeeming this reward" });
    return;
  }
  if (result.kind === "insufficient") {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }
  res.json(RedeemRewardResponse.parse({ reward: result.reward, coinsRemaining: result.coinsRemaining }));
});

export default router;
