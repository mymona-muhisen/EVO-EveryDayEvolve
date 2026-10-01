import { and, eq } from "drizzle-orm";
import {
  habitDaysTable,
  habitPlanRevisionsTable,
  habitsTable,
  socialChallengeMembersTable,
  socialChallengesTable,
  usersTable,
  type SocialChallengeHabitTemplate,
} from "@workspace/db";
import { HABIT_JOURNEY_LENGTH, makeJourneyDays, resolveExecutionType, snapshotPlan } from "../lib/habitJourney";
import { todayInTimezone } from "../lib/dates";
import { SocialHttpError, lockSocialPair } from "./social-common";

export type ChallengeHabitTransaction = Parameters<Parameters<typeof import("@workspace/db").db.transaction>[0]>[0];

export interface ChallengeHabitOverrides {
  targetValue?: number;
  minimumValue?: number;
  difficulty?: SocialChallengeHabitTemplate["difficulty"];
  cadence?: SocialChallengeHabitTemplate["cadence"];
  customDays?: number[];
}

export function validateChallengeHabitPlan(
  template: SocialChallengeHabitTemplate,
  overrides: ChallengeHabitOverrides,
): {
  targetValue: number;
  minimumValue: number;
  cadence: SocialChallengeHabitTemplate["cadence"];
  customDays: number[] | null;
  executionType: SocialChallengeHabitTemplate["executionType"];
  successLimitValue: number | null;
} {
  const targetValue = overrides.targetValue ?? template.suggestedTargetValue;
  const minimumValue = overrides.minimumValue ?? template.suggestedMinimumValue;
  const cadence = overrides.cadence ?? template.cadence;
  const customDays = cadence === "custom_days"
    ? overrides.customDays ?? template.customDays ?? null
    : null;

  if (!Number.isFinite(targetValue) || !Number.isFinite(minimumValue)
    || targetValue < 0 || minimumValue < 0 || minimumValue > targetValue) {
    throw new SocialHttpError(400, "Minimum and target values are invalid");
  }
  if (template.goalType === "build" && (targetValue <= 0 || minimumValue <= 0)) {
    throw new SocialHttpError(400, "Build habits require positive target and minimum values");
  }
  if (cadence === "custom_days"
    && (!customDays?.length || new Set(customDays).size !== customDays.length
      || customDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new SocialHttpError(400, "Custom cadence requires at least one valid weekday");
  }

  const executionType = resolveExecutionType(template.unit, template.goalType, template.executionType);
  if ((template.goalType === "quit" && executionType !== "limit")
    || (template.goalType === "build" && executionType === "limit")) {
    throw new SocialHttpError(400, "The challenge habit has an incompatible execution type");
  }
  return {
    targetValue,
    minimumValue,
    cadence,
    customDays,
    executionType,
    successLimitValue: template.goalType === "quit" ? targetValue : null,
  };
}

/**
 * Creates a clean, independently owned 22-day challenge habit.  The caller
 * locks the member row first; a populated habitId is treated as a completed
 * idempotent acceptance and never creates a second journey.
 */
export async function createChallengeHabit(
  tx: ChallengeHabitTransaction,
  challengeId: number,
  userId: string,
  overrides: ChallengeHabitOverrides,
): Promise<{ habitId: number; journeyStartDate: string }> {
  const [challenge] = await tx.select().from(socialChallengesTable)
    .where(eq(socialChallengesTable.id, challengeId)).limit(1);
  if (!challenge || challenge.status !== "active") {
    throw new SocialHttpError(404, "Challenge not found");
  }
  // Blocking locks the two user rows before revoking pending member rows.
  // Acquire the same stable pair locks before this member row to avoid
  // inversion with a concurrent block transaction.
  await lockSocialPair(tx, userId, challenge.creatorUserId);
  const [member] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).for("update").limit(1);
  if (!member) throw new SocialHttpError(404, "Challenge invitation not found");
  if (member.status === "accepted" && member.habitId != null && member.journeyStartDate) {
    return { habitId: member.habitId, journeyStartDate: member.journeyStartDate };
  }
  if (member.status !== "invited") throw new SocialHttpError(409, "Challenge invitation is no longer pending");

  const [user] = await tx.select().from(usersTable)
    .where(eq(usersTable.id, userId)).for("update").limit(1);
  if (!user) throw new SocialHttpError(404, "User not found");

  const planInput = validateChallengeHabitPlan(challenge.habitTemplate, overrides);
  const startDate = todayInTimezone(user.timezone);
  const template = challenge.habitTemplate;
  const title = template.title;
  const [habit] = await tx.insert(habitsTable).values({
    userId,
    title,
    emoji: template.emoji,
    category: template.category as typeof habitsTable.$inferInsert.category,
    cadence: planInput.cadence,
    customDays: planInput.customDays,
    unit: template.unit,
    executionType: planInput.executionType,
    targetValue: planInput.targetValue,
    minimumValue: planInput.minimumValue,
    busyDayValue: null,
    // A quit-plan baseline is intentionally synthetic: source baseline data is
    // not part of the challenge template and must not be shared.
    baselineValue: template.goalType === "quit" ? planInput.targetValue : null,
    successLimitValue: planInput.successLimitValue,
    cueType: null,
    cueTime: null,
    cue: null,
    startAction: null,
    friction: null,
    minimumFloor: null,
    journeyStartDate: startDate,
    journeyLength: HABIT_JOURNEY_LENGTH,
    rewardId: null,
    difficulty: overrides.difficulty ?? template.difficulty,
    goalType: template.goalType,
    milestones: [],
  }).returning();
  if (!habit) throw new SocialHttpError(500, "Could not create challenge journey");

  const plan = snapshotPlan({
    title,
    cadence: planInput.cadence,
    customDays: planInput.customDays,
    targetValue: planInput.targetValue,
    minimumValue: planInput.minimumValue,
    busyDayValue: null,
    successLimitValue: planInput.successLimitValue,
    minimumFloor: null,
    goalType: template.goalType,
    unit: template.unit,
    executionType: planInput.executionType,
    cueType: null,
    cueTime: null,
    cue: null,
    startAction: null,
    friction: null,
  });
  await tx.insert(habitDaysTable).values(makeJourneyDays(
    habit.id,
    startDate,
    HABIT_JOURNEY_LENGTH,
    {
      title,
      cadence: planInput.cadence,
      customDays: planInput.customDays,
      targetValue: planInput.targetValue,
      minimumValue: planInput.minimumValue,
      busyDayValue: null,
      successLimitValue: planInput.successLimitValue,
      goalType: template.goalType,
      unit: template.unit,
      executionType: planInput.executionType,
      cueType: null,
      cueTime: null,
      cue: null,
      startAction: null,
      planRevision: 1,
    },
  ));
  await tx.insert(habitPlanRevisionsTable).values({
    habitId: habit.id,
    revision: 1,
    effectiveFrom: startDate,
    plan,
  });

  const updated = await tx.update(socialChallengeMembersTable).set({
    status: "accepted",
    habitId: habit.id,
    targetValueSnapshot: planInput.targetValue,
    minimumValueSnapshot: planInput.minimumValue,
    cadenceSnapshot: planInput.cadence,
    customDaysSnapshot: planInput.customDays,
    timezoneSnapshot: user.timezone,
    journeyStartDate: startDate,
    acceptedAt: new Date(),
  }).where(and(
    eq(socialChallengeMembersTable.id, member.id),
    eq(socialChallengeMembersTable.status, "invited"),
  )).returning({ id: socialChallengeMembersTable.id });
  if (!updated.length) {
    throw new SocialHttpError(409, "Challenge invitation was accepted concurrently");
  }
  return { habitId: habit.id, journeyStartDate: startDate };
}