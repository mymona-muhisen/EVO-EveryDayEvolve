import { and, eq, lte } from "drizzle-orm";
import {
  db,
  habitsTable,
  checkinsTable,
  habitDaysTable,
  usersTable,
} from "@workspace/db";
import { CreateCheckinBody, CreateCheckinResponse } from "@workspace/api-zod";
import type { z } from "zod";
import { grantRewards } from "./gamificationService";
import { coinsForCheckin, continuesStreak, xpForDifficulty } from "./rules";
import { toDateOnly, todayInTimezone } from "./dates";
import { effectiveMinimum, evaluateHabitCheckin } from "./aiRules";
import { addCalendarDays, HABIT_JOURNEY_LENGTH } from "./habitJourney";
import { synchronizeJourneyCompletion } from "./journeyRewardService";
import {
  activeSocialShareRecipientIds,
  appendSocialActivityOnce,
  insertSocialNotificationOnce,
} from "../services/social-common";
import { recordSharedGroupActivityOnce } from "../services/social-circles";

export class CheckinConflictError extends Error {}
type CheckinTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  return db.transaction((tx) => recordCheckinInTransaction(tx, userId, habitId, input));
}

/**
 * Transaction-aware check-in entry point for workflows (such as daily habit
 * completion) that must commit execution state and rewards together.
 */
export async function recordCheckinInTransaction(
  tx: CheckinTransaction,
  userId: string,
  habitId: number,
  input: z.infer<typeof CreateCheckinBody>,
  snapshot?: {
    targetValue: number;
    minimumValue: number;
    successLimitValue: number | null;
    goalType: "build" | "quit";
  },
) {
    const [user] = await tx.select({ id: usersTable.id, timezone: usersTable.timezone }).from(usersTable)
      // Serialize balance/progress writes without blocking another check-in's
      // notification foreign-key check on this unchanged user ID.
      .where(eq(usersTable.id, userId)).for("no key update");
    if (!user) throw new Error("User not found");
    const [habit] = await tx.select().from(habitsTable)
      .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)))
      .for("update");
    if (!habit) return null;

    const date = toDateOnly(input.date);
    const today = todayInTimezone(user.timezone);
    if (habit.journeyStartDate != null && habit.journeyLength != null && date > today) {
      throw new CheckinConflictError("Future journey dates cannot be completed early.");
    }
    const { value, note, moodRating, difficulty, missedReason } = input;
    const [dayPlan] = await tx.select().from(habitDaysTable)
      .where(and(eq(habitDaysTable.habitId, habit.id), eq(habitDaysTable.date, date)));
    const hasJourneyStart = habit.journeyStartDate != null;
    const hasJourneyLength = habit.journeyLength != null;
    if (hasJourneyStart !== hasJourneyLength) {
      throw new Error(`Habit ${habit.id} has an incomplete journey definition`);
    }
    if (hasJourneyStart && hasJourneyLength) {
      const journeyEnd = addCalendarDays(habit.journeyStartDate!, habit.journeyLength! - 1);
      if (date < habit.journeyStartDate! || date > journeyEnd) {
        throw new CheckinConflictError("This date is outside the habit's 22-day journey.");
      }
      if (!dayPlan) {
        throw new Error(`Habit ${habit.id} is missing its journey plan for ${date}`);
      }
      if (!dayPlan.scheduled) {
        throw new CheckinConflictError("This is a rest day; check-ins are not accepted for it.");
      }
    }
    const [existing] = await tx.select().from(checkinsTable)
      .where(and(eq(checkinsTable.habitId, habit.id), eq(checkinsTable.date, date)))
      .for("update");
    const isHistoricalJourneyDate = habit.journeyStartDate != null
      && habit.journeyLength === HABIT_JOURNEY_LENGTH
      && date < today;
    if (isHistoricalJourneyDate && (!existing
      || (input.completed !== undefined && input.completed !== existing.completed)
      || (input.value !== undefined && input.value !== existing.value))) {
      throw new CheckinConflictError(
        "Past journey check-ins cannot be created or change completion/actual values.",
      );
    }
    // Omitted fields in a value-only retry are not reflection clears.
    const effectiveValue = value !== undefined ? value : existing?.value ?? null;
    const effectiveNote = note !== undefined ? note : existing?.note ?? null;
    const effectiveMoodRating = moodRating !== undefined ? moodRating : existing?.moodRating ?? null;
    const effectiveDifficulty = difficulty !== undefined ? difficulty : existing?.difficulty ?? null;
    const effectiveMissedReason = missedReason !== undefined ? missedReason : existing?.missedReason ?? null;
    const targetSnapshot = existing?.targetSnapshot ?? snapshot?.targetValue ?? dayPlan?.targetValue ?? habit.targetValue;
    const minimumSnapshot = existing?.minimumSnapshot
      ?? snapshot?.minimumValue ?? dayPlan?.minimumValue ?? effectiveMinimum(habit.targetValue, habit.minimumValue);
    const successLimitSnapshot = existing?.successLimitSnapshot
      ?? snapshot?.successLimitValue ?? dayPlan?.successLimitValue ?? habit.successLimitValue;
    const goalTypeSnapshot = existing?.goalTypeSnapshot ?? snapshot?.goalType ?? dayPlan?.goalType ?? habit.goalType;
    const evaluated = evaluateHabitCheckin({
      goalType: goalTypeSnapshot,
      targetValue: targetSnapshot,
      minimumValue: minimumSnapshot,
      successLimitValue: successLimitSnapshot,
      value: effectiveValue,
      legacyCompleted: input.completed ?? existing?.completed,
    });
    const { completed, targetCompleted } = isHistoricalJourneyDate && existing
      ? { completed: existing.completed, targetCompleted: existing.targetCompleted }
      : evaluated;
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
    let xpEarned = existing?.xpEarned ?? null;
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
          xpEarned = xpForDifficulty(habit.difficulty);
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
      value: effectiveValue,
      note: effectiveNote,
      moodRating: effectiveMoodRating,
      difficulty: effectiveDifficulty,
      missedReason: effectiveMissedReason,
      targetSnapshot,
      minimumSnapshot,
      successLimitSnapshot,
      goalTypeSnapshot,
      targetCompleted,
      rewardGranted: shouldReward,
      coinsEarned,
      xpEarned,
    }).onConflictDoUpdate({
      target: [checkinsTable.habitId, checkinsTable.date],
      set: {
        completed,
        value: effectiveValue,
        note: effectiveNote,
        moodRating: effectiveMoodRating,
        difficulty: effectiveDifficulty,
        missedReason: effectiveMissedReason,
        targetSnapshot,
        minimumSnapshot,
        successLimitSnapshot,
        targetCompleted,
        goalTypeSnapshot,
        ...(shouldReward ? { rewardGranted: true, coinsEarned } : {}),
        ...(shouldReward ? { xpEarned } : {}),
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
        xp: xpEarned!,
        coins: coinsEarned - bonusCoins,
        reason: "checkin",
      }, tx);
      if (bonusCoins > 0) {
        await grantRewards(userId, { coins: bonusCoins, reason: "streak_bonus" }, tx);
      }
    }
    const journeyState = await synchronizeJourneyCompletion(tx, userId, updatedHabit, today);
    if (newlyCompleted && updatedHabit.journeyLength === HABIT_JOURNEY_LENGTH && dayPlan?.scheduled) {
      const activeRecipients = await activeSocialShareRecipientIds(
        tx,
        userId,
        "journey",
        String(updatedHabit.id),
      );
      if (activeRecipients.length) {
        await appendSocialActivityOnce(tx, {
          actorUserId: userId,
          eventType: "successful_day",
          journeyId: updatedHabit.id,
          idempotencyKey: `successful-day:${updatedHabit.id}:${date}`,
        });
      }
      const successfulRows = await tx.select({ date: checkinsTable.date })
        .from(checkinsTable).innerJoin(habitDaysTable, and(
          eq(habitDaysTable.habitId, checkinsTable.habitId),
          eq(habitDaysTable.date, checkinsTable.date),
          eq(habitDaysTable.scheduled, true),
        )).where(and(
          eq(checkinsTable.habitId, updatedHabit.id),
          eq(checkinsTable.userId, userId),
          eq(checkinsTable.completed, true),
          lte(habitDaysTable.date, today),
        ));
      if (activeRecipients.length && [5, 10, 15, 22].includes(successfulRows.length)) {
        const eventId = await appendSocialActivityOnce(tx, {
          actorUserId: userId,
          eventType: "milestone",
          journeyId: updatedHabit.id,
          idempotencyKey: `milestone:${updatedHabit.id}:${successfulRows.length}`,
        });
        for (const recipientUserId of activeRecipients) {
          await insertSocialNotificationOnce(tx, {
            recipientUserId,
            actorUserId: userId,
            type: "shared_milestone",
            eventKey: `social-activity:${eventId}`,
          });
        }
      }
      if (activeRecipients.length && journeyState.completedAt) {
        await appendSocialActivityOnce(tx, {
          actorUserId: userId,
          eventType: "journey_completed",
          journeyId: updatedHabit.id,
          idempotencyKey: `journey-completed:${updatedHabit.id}`,
        });
      }
      if (dayPlan?.scheduled) {
          await recordSharedGroupActivityOnce(tx, {
            actorUserId: userId,
            eventType: "successful_day",
            journeyId: updatedHabit.id,
            idempotencyKey: `successful-day:${updatedHabit.id}:${date}`,
          });
          if ([5, 10, 15, 22].includes(successfulRows.length)) {
            await recordSharedGroupActivityOnce(tx, {
              actorUserId: userId,
              eventType: "milestone",
              journeyId: updatedHabit.id,
              idempotencyKey: `milestone:${updatedHabit.id}:${successfulRows.length}`,
            });
          }
          if (journeyState.completedAt) {
            await recordSharedGroupActivityOnce(tx, {
              actorUserId: userId,
              eventType: "journey_completed",
              journeyId: updatedHabit.id,
              idempotencyKey: `journey-completed:${updatedHabit.id}`,
            });
          }
      }
    }

    // Validate before COMMIT; a response-schema failure must not persist a
    // reward while reporting failure to the client.
    const response = CreateCheckinResponse.parse({
      ...checkin,
      newStreak,
      habit: {
        ...updatedHabit,
        journeyCompletedAt: journeyState.completedAt,
      },
    });
    return {
      ...response,
      rewardDelta: shouldReward
        ? { xp: xpEarned!, coins: coinsEarned }
        : { xp: 0, coins: 0 },
    };
}