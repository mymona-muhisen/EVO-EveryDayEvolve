import { and, eq } from "drizzle-orm";
import { db, checkinsTable, habitDaysTable, habitsTable, rewardsTable } from "@workspace/db";
import { HABIT_JOURNEY_LENGTH, isWithinJourneyWindow } from "./habitJourney";
import { evaluateJourneyLifecycle } from "./journeyLifecycle";
import {
  getJourneyLifecycle,
  synchronizeJourneyCompletion,
} from "./journeyRewardService";

type JourneyGateTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function journeysAssociatedWithReward(
  tx: JourneyGateTransaction,
  userId: string,
  rewardId: number,
): Promise<(typeof habitsTable.$inferSelect)[]> {
  const [reward] = await tx.select({ habitId: rewardsTable.habitId }).from(rewardsTable).where(and(
    eq(rewardsTable.id, rewardId),
    eq(rewardsTable.userId, userId),
  )).limit(1);
  if (!reward) return [];

  const [forwardLinked, reverseLinked] = await Promise.all([
    tx.select().from(habitsTable).where(and(
      eq(habitsTable.userId, userId),
      eq(habitsTable.rewardId, rewardId),
    )),
    reward.habitId == null
      ? Promise.resolve([])
      : tx.select().from(habitsTable).where(and(
        eq(habitsTable.id, reward.habitId),
        eq(habitsTable.userId, userId),
      )),
  ]);
  return [...new Map([...forwardLinked, ...reverseLinked].map((habit) => [habit.id, habit])).values()];
}

async function rewardsAssociatedWithHabit(
  tx: JourneyGateTransaction,
  userId: string,
  habit: typeof habitsTable.$inferSelect,
): Promise<number[]> {
  const reverseLinked = await tx.select({ id: rewardsTable.id }).from(rewardsTable).where(and(
    eq(rewardsTable.habitId, habit.id),
    eq(rewardsTable.userId, userId),
  ));
  return [...new Set([
    ...(habit.rewardId == null ? [] : [habit.rewardId]),
    ...reverseLinked.map((reward) => reward.id),
  ])];
}

export async function markJourneyRewardRequired(
  tx: JourneyGateTransaction,
  userId: string,
  rewardId: number,
  journeyCompleted: boolean,
): Promise<void> {
  const [reward] = await tx.select({
    isRedeemed: rewardsTable.isRedeemed,
    journeyUnlockedAt: rewardsTable.journeyUnlockedAt,
  }).from(rewardsTable).where(and(
    eq(rewardsTable.id, rewardId),
    eq(rewardsTable.userId, userId),
  )).for("update");
  if (!reward || reward.isRedeemed) return;
  await tx.update(rewardsTable).set({
    journeyRequired: true,
    ...(journeyCompleted && reward.journeyUnlockedAt == null
      ? { journeyUnlockedAt: new Date() }
      : {}),
  }).where(and(
    eq(rewardsTable.id, rewardId),
    eq(rewardsTable.userId, userId),
    eq(rewardsTable.isRedeemed, false),
  ));
}

export async function preserveJourneyRewardGate(
  tx: JourneyGateTransaction,
  userId: string,
  habit: typeof habitsTable.$inferSelect,
  today: string,
): Promise<void> {
  const rewardIds = await rewardsAssociatedWithHabit(tx, userId, habit);
  if (habit.journeyStartDate != null && habit.journeyLength === HABIT_JOURNEY_LENGTH) {
    const lifecycle = await getJourneyLifecycle(tx, habit, today);
    await synchronizeJourneyCompletion(tx, userId, habit, today, new Date(), lifecycle);
  }
  if (!rewardIds.length
    || habit.journeyStartDate == null
    || habit.journeyLength !== HABIT_JOURNEY_LENGTH) return;
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
  if (lifecycle.shouldCommitCompletion) {
    await tx.update(habitsTable).set({ journeyCompletedAt: new Date() }).where(and(
      eq(habitsTable.id, habit.id),
      eq(habitsTable.userId, userId),
    ));
  }
  for (const rewardId of rewardIds) {
    await markJourneyRewardRequired(tx, userId, rewardId, lifecycle.status === "completed");
  }
}