import { and, eq } from "drizzle-orm";
import {
  db,
  checkinsTable,
  habitDaysTable,
  habitsTable,
  journeyRewardsTable,
  objectUploadsTable,
  type HabitRow,
} from "@workspace/db";
import type { JourneyRewardInput } from "@workspace/api-zod";
import { ObjectStorageService } from "./objectStorage";
import { getObjectAclPolicy, setObjectAclPolicy } from "./objectAcl";
import { isWithinJourneyWindow } from "./habitJourney";
import { evaluateJourneyLifecycle } from "./journeyLifecycle";

type JourneyRewardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const objectStorageService = new ObjectStorageService();

export type JourneyLifecycleSnapshot = ReturnType<typeof evaluateJourneyLifecycle>;

export async function getJourneyLifecycle(
  tx: JourneyRewardTransaction,
  habit: HabitRow,
  today: string,
): Promise<JourneyLifecycleSnapshot> {
  const savedDays = await tx.select({
    date: habitDaysTable.date,
    scheduled: habitDaysTable.scheduled,
  }).from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id));
  const days = habit.journeyStartDate != null && habit.journeyLength != null
    ? savedDays.filter((day) => isWithinJourneyWindow(
      day.date, habit.journeyStartDate!, habit.journeyLength!,
    ))
    : savedDays;
  const successfulRows = await tx.select({
    date: checkinsTable.date,
  }).from(checkinsTable).where(and(
    eq(checkinsTable.habitId, habit.id),
    eq(checkinsTable.userId, habit.userId),
    eq(checkinsTable.completed, true),
  ));
  return evaluateJourneyLifecycle({
    startDate: habit.journeyStartDate,
    length: habit.journeyLength,
    today,
    scheduledDates: days.filter((day) => day.scheduled).map((day) => day.date),
    successfulDates: new Set(successfulRows.map((checkin) => checkin.date)),
    completedAt: habit.journeyCompletedAt,
  });
}

/**
 * Persist server-verified journey completion and its personal reward unlock in
 * the caller's transaction. Repeated reads and successful-transition retries
 * preserve the original timestamps and never award coins or XP.
 */
export async function synchronizeJourneyCompletion(
  tx: JourneyRewardTransaction,
  userId: string,
  habit: HabitRow,
  today: string,
  now = new Date(),
  lifecycle?: JourneyLifecycleSnapshot,
) {
  const resolved = lifecycle ?? await getJourneyLifecycle(tx, habit, today);
  let completedAt = habit.journeyCompletedAt;
  if (resolved.shouldCommitCompletion && completedAt == null) {
    completedAt = now;
    await tx.update(habitsTable).set({ journeyCompletedAt: completedAt }).where(and(
      eq(habitsTable.id, habit.id),
      eq(habitsTable.userId, userId),
    ));
  }

  let reward = null;
  if (habit.journeyStartDate != null && habit.journeyLength === 22) {
    const [attached] = await tx.select().from(journeyRewardsTable).where(and(
      eq(journeyRewardsTable.habitId, habit.id),
      eq(journeyRewardsTable.userId, userId),
    )).for("update").limit(1);
    reward = attached ?? null;
    if (reward && resolved.status === "completed" && reward.status === "pending") {
      const unlockedAt = reward.unlockedAt ?? now;
      const [updated] = await tx.update(journeyRewardsTable).set({
        status: "unlocked",
        unlockedAt,
        updatedAt: now,
      }).where(and(
        eq(journeyRewardsTable.id, reward.id),
        eq(journeyRewardsTable.userId, userId),
        eq(journeyRewardsTable.status, "pending"),
      )).returning();
      reward = updated ?? reward;
    }
  }
  return {
    lifecycle: resolved,
    completedAt: completedAt ?? resolved.completedAt,
    reward,
  };
}

export function journeyRewardResponse(
  reward: typeof journeyRewardsTable.$inferSelect,
  currentDay: number | null,
) {
  return {
    id: reward.id,
    habitId: reward.habitId,
    title: reward.title,
    type: reward.type,
    description: reward.description,
    imageUrl: reward.imageUrl,
    estimatedValue: reward.estimatedValue,
    status: reward.status,
    createdAt: reward.createdAt,
    updatedAt: reward.updatedAt,
    unlockedAt: reward.unlockedAt,
    claimedAt: reward.claimedAt,
    currentDay,
    daysRemaining: currentDay == null ? null : Math.max(0, 22 - currentDay),
  };
}

export async function prepareJourneyRewardImage(
  tx: JourneyRewardTransaction,
  userId: string,
  path: string | null | undefined,
): Promise<string | null> {
  if (path == null) return null;
  if (!path.startsWith("/objects/") || path.includes("?") || path.includes("#")
    || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Reward image must be a normalized private object path");
  }

  let objectFile;
  try {
    objectFile = await objectStorageService.getObjectEntityFile(path);
  } catch {
    throw new Error("Reward image object is not available");
  }
  const [provenance] = await tx.select().from(objectUploadsTable).where(eq(
    objectUploadsTable.objectPath,
    path,
  )).limit(1);
  if (provenance && provenance.userId !== userId) {
    throw new Error("Reward image upload was issued to another user");
  }

  const acl = await getObjectAclPolicy(objectFile);
  if (acl) {
    if (acl.owner !== userId || acl.visibility !== "private") {
      throw new Error("Reward image must be a private object owned by this user");
    }
    if (provenance) await markUploadAdopted(tx, path, userId);
    return path;
  }

  if (!provenance) {
    throw new Error("Reward image upload was not issued to this user");
  }

  await setObjectAclPolicy(objectFile, { owner: userId, visibility: "private" });
  await markUploadAdopted(tx, path, userId);
  return path;
}

async function markUploadAdopted(
  tx: JourneyRewardTransaction,
  objectPath: string,
  userId: string,
): Promise<void> {
  await tx.update(objectUploadsTable).set({
    unreferencedSince: null,
    lastCleanupAttemptAt: null,
  }).where(and(
    eq(objectUploadsTable.objectPath, objectPath),
    eq(objectUploadsTable.userId, userId),
  ));
}

export async function prepareJourneyRewardInput(
  tx: JourneyRewardTransaction,
  userId: string,
  input: JourneyRewardInput,
) {
  const title = input.title.trim();
  if (!title) throw new Error("Reward title cannot be blank");
  const imageUrl = await prepareJourneyRewardImage(tx, userId, input.imageObjectPath);
  return {
    title,
    type: input.type,
    description: input.description?.trim() || null,
    imageUrl,
    estimatedValue: input.estimatedValue ?? null,
  };
}
