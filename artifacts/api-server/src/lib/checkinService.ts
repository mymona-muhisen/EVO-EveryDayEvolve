import { and, eq } from "drizzle-orm";
import { db, habitsTable, checkinsTable, usersTable } from "@workspace/db";
import { CreateCheckinBody, CreateCheckinResponse } from "@workspace/api-zod";
import type { z } from "zod";
import { grantRewards } from "./gamificationService";
import { coinsForCheckin, continuesStreak, xpForDifficulty } from "./rules";
import { toDateOnly } from "./dates";
import { effectiveMinimum, evaluateHabitCheckin } from "./aiRules";

export class CheckinConflictError extends Error {}

/**
 * A check-in and all its effects are one commit. Lock the user before the
 * habit: different habits share XP/milestones, and first-time check-ins do not
 * yet have a row to lock. This order must be kept by transaction callers.
 */
export async function recordCheckin(
  userId: string,
  habitId: number,
  input: z.infer<typeof CreateCheckinBody>,
) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, userId)).for("update");
    if (!user) throw new Error("User not found");
    const [habit] = await tx.select().from(habitsTable)
      .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)))
      .for("update");
    if (!habit) return null;

    const date = toDateOnly(input.date);
    const { value, note, moodRating, difficulty, missedReason } = input;
    const [existing] = await tx.select().from(checkinsTable)
      .where(and(eq(checkinsTable.habitId, habit.id), eq(checkinsTable.date, date)));
    const targetSnapshot = existing?.targetSnapshot ?? habit.targetValue;
    const minimumSnapshot = existing?.minimumSnapshot
      ?? effectiveMinimum(habit.targetValue, habit.minimumValue);
    const successLimitSnapshot = existing?.successLimitSnapshot ?? habit.successLimitValue;
    const { completed, targetCompleted } = evaluateHabitCheckin({
      goalType: habit.goalType,
      targetValue: targetSnapshot,
      minimumValue: minimumSnapshot,
      successLimitValue: successLimitSnapshot,
      value,
      legacyCompleted: input.completed,
    });
    if (existing?.completed && !completed) {
      throw new CheckinConflictError("A successful check-in cannot be changed to incomplete");
    }

    // Historical successful rows are not repair candidates: their reward may
    // have been paid by older code without recording the flag. Only a newly
    // successful day can create a reward. Positive legacy coins also count as
    // paid even when rewardGranted is false.
    const newlyCompleted = completed && !existing?.completed;
    const alreadyRewarded = Boolean(existing?.rewardGranted || (existing?.coinsEarned ?? 0) > 0);
    const shouldReward = newlyCompleted && !alreadyRewarded;
    let newStreak = habit.currentStreak;
    let longestStreak = habit.longestStreak;
    let coinsEarned = existing?.coinsEarned ?? 0;
    let bonusCoins = 0;
    let lastBrokenStreak = habit.lastBrokenStreak;
    let streakBrokenAt = habit.streakBrokenAt;
    let lastCheckinDate = habit.lastCheckinDate;

    if (!existing || newlyCompleted) {
      if (completed) {
        const continues = continuesStreak(habit.cadence, habit.lastCheckinDate, date, habit.customDays);
        newStreak = continues ? habit.currentStreak + 1 : 1;
        longestStreak = Math.max(longestStreak, newStreak);
        if (shouldReward) {
          const { base, bonus } = coinsForCheckin(habit.difficulty, newStreak);
          coinsEarned = base + bonus;
          bonusCoins = bonus;
        }
        lastBrokenStreak = null;
        streakBrokenAt = null;
        lastCheckinDate = date;
      } else if (habit.currentStreak > 0) {
        lastBrokenStreak = habit.currentStreak;
        streakBrokenAt = date;
        newStreak = 0;
      }
    }

    const [checkin] = await tx.insert(checkinsTable).values({
      habitId: habit.id,
      userId,
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
      rewardGranted: shouldReward,
      coinsEarned,
    }).onConflictDoUpdate({
      target: [checkinsTable.habitId, checkinsTable.date],
      set: {
        completed,
        value: value ?? null,
        note: note ?? null,
        moodRating: moodRating ?? null,
        difficulty: difficulty ?? null,
        missedReason: missedReason ?? null,
        targetCompleted,
        ...(shouldReward ? { rewardGranted: true, coinsEarned } : {}),
      },
    }).returning();

    const [updatedHabit] = await tx.update(habitsTable).set({
      currentStreak: newStreak,
      longestStreak,
      lastCheckinDate,
      lastBrokenStreak,
      streakBrokenAt,
    }).where(eq(habitsTable.id, habit.id)).returning();

    if (shouldReward) {
      await grantRewards(userId, {
        xp: xpForDifficulty(habit.difficulty),
        coins: coinsEarned - bonusCoins,
        reason: "checkin",
      }, tx);
      if (bonusCoins > 0) {
        await grantRewards(userId, { coins: bonusCoins, reason: "streak_bonus" }, tx);
      }
    }

    // Validate before COMMIT; a response-schema failure must not persist a
    // reward while reporting failure to the client.
    return CreateCheckinResponse.parse({
      ...checkin,
      newStreak,
      habit: updatedHabit,
    });
  });
}