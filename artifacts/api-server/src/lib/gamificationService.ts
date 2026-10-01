import { eq, and, gt, lte, gte, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  coinTransactionsTable,
  journeyMilestonesTable,
  userJourneyMilestonesTable,
  type UserRow,
} from "@workspace/db";
import { applyXp } from "./rules";

export type CoinReason =
  | "checkin"
  | "streak_bonus"
  | "streak_recovery"
  | "reward_redemption"
  | "item_purchase"
  | "challenge_bonus"
  | "manual";

export type RewardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Grants XP and/or coins to a user, logs the coin transaction, and grants
 * any journey milestones newly crossed by the resulting level (each
 * milestone's rewardCoins are paid out exactly once, guarded by a unique
 * constraint on user_journey_milestones).
 */
export async function grantRewards(
  userId: string,
  opts: { xp?: number; coins?: number; reason: CoinReason },
  tx?: RewardTransaction,
): Promise<UserRow> {
  // Reuse the caller's transaction so the check-in, streak and reward commit
  // together. Standalone callers get the same atomicity.
  if (!tx) return db.transaction((transaction) => grantRewards(userId, opts, transaction));

  const [user] = await tx
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .for("update");
  if (!user) throw new Error(`User ${userId} not found`);

  const xpGained = opts.xp ?? 0;
  const coinsGained = opts.coins ?? 0;
  const { level, xp } = applyXp(user.level, user.xp, xpGained);

  const [updated] = await tx
    .update(usersTable)
    .set({ level, xp, coins: sql`${usersTable.coins} + ${coinsGained}` })
    .where(eq(usersTable.id, userId))
    .returning();

  if (coinsGained !== 0) {
    await tx
      .insert(coinTransactionsTable)
      .values({ userId, amount: coinsGained, reason: opts.reason });
  }

  if (level > user.level) {
    await grantJourneyMilestones(tx, userId, user.level, level);
    const [final] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    return final;
  }

  return updated;
}

/**
 * Atomically spends coins if the user can afford it. Returns null (no
 * mutation) when the balance is insufficient.
 */
export async function spendCoins(
  userId: string,
  amount: number,
  reason: Extract<
    CoinReason,
    "streak_recovery" | "reward_redemption" | "item_purchase"
  >,
): Promise<UserRow | null> {
  const [updated] = await db
    .update(usersTable)
    .set({ coins: sql`${usersTable.coins} - ${amount}` })
    .where(and(eq(usersTable.id, userId), gte(usersTable.coins, amount)))
    .returning();
  if (!updated) return null;

  await db
    .insert(coinTransactionsTable)
    .values({ userId, amount: -amount, reason });
  return updated;
}

async function grantJourneyMilestones(
  tx: RewardTransaction,
  userId: string,
  oldLevel: number,
  newLevel: number,
): Promise<void> {
  const crossed = await tx
    .select()
    .from(journeyMilestonesTable)
    .where(
      and(
        gt(journeyMilestonesTable.levelRequired, oldLevel),
        lte(journeyMilestonesTable.levelRequired, newLevel),
      ),
    );

  for (const milestone of crossed) {
    const [inserted] = await tx
      .insert(userJourneyMilestonesTable)
      .values({ userId, milestoneId: milestone.id })
      .onConflictDoNothing()
      .returning();

    if (inserted && milestone.rewardCoins > 0) {
      await tx
        .update(usersTable)
        .set({ coins: sql`${usersTable.coins} + ${milestone.rewardCoins}` })
        .where(eq(usersTable.id, userId));
      await tx.insert(coinTransactionsTable).values({
        userId,
        amount: milestone.rewardCoins,
        reason: "manual",
      });
    }
  }
}
