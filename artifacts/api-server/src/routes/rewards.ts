import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, rewardsTable } from "@workspace/db";
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
import { spendCoins } from "../lib/gamificationService";

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
  await ensureUser(req.userId!);
  const parsed = CreateRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [reward] = await db
    .insert(rewardsTable)
    .values({
      userId: req.userId!,
      habitId: parsed.data.habitId ?? null,
      title: parsed.data.title,
      emoji: parsed.data.emoji,
      coinCost: parsed.data.coinCost,
    })
    .returning();

  res.status(201).json(CreateRewardResponse.parse(reward));
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

  const [reward] = await db
    .select()
    .from(rewardsTable)
    .where(and(eq(rewardsTable.id, params.data.rewardId), eq(rewardsTable.userId, req.userId!)));
  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }
  if (reward.isRedeemed) {
    res.status(400).json({ error: "Reward already redeemed" });
    return;
  }

  const spendResult = await spendCoins(req.userId!, reward.coinCost, "reward_redemption");
  if (!spendResult) {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }

  const [updated] = await db
    .update(rewardsTable)
    .set({ isRedeemed: true, redeemedAt: new Date() })
    .where(eq(rewardsTable.id, reward.id))
    .returning();

  res.json(RedeemRewardResponse.parse({ reward: updated, coinsRemaining: spendResult.coins }));
});

export default router;
