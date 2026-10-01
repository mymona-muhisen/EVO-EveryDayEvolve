import {
  and,
  asc,
  eq,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  journeyRewardsTable,
  memoriesTable,
  objectUploadsTable,
  groupsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BATCH_SIZE = 100;
const RETRY_INTERVAL_MS = 6 * CLEANUP_INTERVAL_MS;
const CANONICAL_UPLOAD_PATH = String.raw`^/objects/uploads/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`;
const CANONICAL_DERIVED_IMAGE_PATH = String.raw`^/objects/memory-images/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$`;
type CleanupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const objectStorageService = new ObjectStorageService();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupInFlight = false;

export interface PrivateUploadCleanupResult {
  scanned: number;
  observed: number;
  deleted: number;
  missing: number;
  referenced: number;
  protected: number;
  failed: number;
}

/**
 * Processes at most 100 provenance rows per call. Only canonical upload and
 * generated memory-image paths are candidates; the bucket is never enumerated.
 */
export async function cleanupUnreferencedPrivateUploads(
  options: { now?: Date; batchSize?: number } = {},
): Promise<PrivateUploadCleanupResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(
    1,
    Math.min(MAX_BATCH_SIZE, Math.trunc(options.batchSize ?? MAX_BATCH_SIZE)),
  );
  const dueBefore = new Date(now.getTime() - GRACE_PERIOD_MS);
  const retryBefore = new Date(now.getTime() - RETRY_INTERVAL_MS);
  const rewardReferences = db.select({ id: journeyRewardsTable.id })
    .from(journeyRewardsTable)
    .where(eq(journeyRewardsTable.imageUrl, objectUploadsTable.objectPath));
  const memoryReferences = db.select({ id: memoriesTable.id })
    .from(memoriesTable)
    .where(eq(memoriesTable.photoObjectPath, objectUploadsTable.objectPath));
  const groupCoverReferences = db.select({ id: groupsTable.id })
    .from(groupsTable)
    .where(eq(groupsTable.coverObjectPath, objectUploadsTable.objectPath));

  const candidates = await db.select().from(objectUploadsTable).where(and(
    sql`(${objectUploadsTable.objectPath} ~ ${CANONICAL_UPLOAD_PATH}
      OR ${objectUploadsTable.objectPath} ~ ${CANONICAL_DERIVED_IMAGE_PATH})`,
    or(
      lt(objectUploadsTable.unreferencedSince, dueBefore),
      and(
        isNull(objectUploadsTable.unreferencedSince),
        notExists(rewardReferences),
        notExists(memoryReferences),
        notExists(groupCoverReferences),
      ),
    ),
    or(
      isNull(objectUploadsTable.lastCleanupAttemptAt),
      lt(objectUploadsTable.lastCleanupAttemptAt, retryBefore),
    ),
  )).orderBy(
    asc(objectUploadsTable.unreferencedSince),
    asc(objectUploadsTable.createdAt),
    asc(objectUploadsTable.objectPath),
  ).limit(batchSize);

  const result: PrivateUploadCleanupResult = {
    scanned: candidates.length,
    observed: 0,
    deleted: 0,
    missing: 0,
    referenced: 0,
    protected: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const status = await db.transaction((tx) =>
        processCandidate(tx, candidate.objectPath, candidate.userId, now, dueBefore),
      );
      result[status]++;
    } catch (error) {
      result.failed++;
      logger.warn(
        { err: error, objectPath: candidate.objectPath },
        "Private upload cleanup failed; retaining provenance for retry",
      );
    }
  }

  return result;
}

async function processCandidate(
  tx: CleanupTransaction,
  objectPath: string,
  userId: string,
  now: Date,
  dueBefore: Date,
): Promise<"observed" | "deleted" | "missing" | "referenced" | "protected" | "failed"> {
  const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.id, userId)).for("update");
  if (!owner) return "referenced";

  const [upload] = await tx.select().from(objectUploadsTable)
    .where(and(
      eq(objectUploadsTable.objectPath, objectPath),
      eq(objectUploadsTable.userId, userId),
    )).for("update").limit(1);
  if (!upload) return "referenced";

  const referenced = await hasAnyReference(tx, objectPath);
  if (referenced) {
    if (upload.unreferencedSince != null) {
      await tx.update(objectUploadsTable).set({
        unreferencedSince: null,
        lastCleanupAttemptAt: null,
      }).where(eq(objectUploadsTable.objectPath, objectPath));
    }
    return "referenced";
  }

  if (upload.unreferencedSince == null) {
    await tx.update(objectUploadsTable).set({
      unreferencedSince: now,
      lastCleanupAttemptAt: now,
    }).where(eq(objectUploadsTable.objectPath, objectPath));
    return "observed";
  }
  if (upload.unreferencedSince > dueBefore) {
    return "observed";
  }

  let deletion: "deleted" | "missing" | "protected";
  try {
    deletion = await objectStorageService.deletePrivateUploadIfSafe(objectPath, userId);
  } catch (error) {
    await tx.update(objectUploadsTable).set({
      lastCleanupAttemptAt: now,
    }).where(eq(objectUploadsTable.objectPath, objectPath));
    logger.warn(
      { err: error, objectPath },
      "Private upload delete failed; retaining provenance for retry",
    );
    return "failed";
  }

  if (deletion === "protected") {
    await tx.update(objectUploadsTable).set({
      lastCleanupAttemptAt: now,
    }).where(eq(objectUploadsTable.objectPath, objectPath));
    logger.warn(
      { objectPath },
      "Private upload cleanup skipped an object with unsafe or public storage metadata",
    );
    return "protected";
  }

  await tx.delete(objectUploadsTable).where(and(
    eq(objectUploadsTable.objectPath, objectPath),
    eq(objectUploadsTable.userId, userId),
  ));
  return deletion;
}

async function hasAnyReference(
  tx: CleanupTransaction,
  objectPath: string,
): Promise<boolean> {
  const [reward] = await tx.select({ id: journeyRewardsTable.id })
    .from(journeyRewardsTable)
    .where(eq(journeyRewardsTable.imageUrl, objectPath))
    .limit(1);
  if (reward) return true;
  const [memory] = await tx.select({ id: memoriesTable.id })
    .from(memoriesTable)
    .where(eq(memoriesTable.photoObjectPath, objectPath))
    .limit(1);
  if (memory) return true;
  const [groupCover] = await tx.select({ id: groupsTable.id })
    .from(groupsTable)
    .where(eq(groupsTable.coverObjectPath, objectPath))
    .limit(1);
  return Boolean(groupCover);
}

export function startPrivateUploadCleanupScheduler(): void {
  if (cleanupTimer) return;

  const run = async (): Promise<void> => {
    if (cleanupInFlight) {
      logger.warn("Skipping overlapping private upload cleanup run");
      return;
    }
    cleanupInFlight = true;
    try {
      const result = await cleanupUnreferencedPrivateUploads();
      logger.info(result, "Private upload cleanup run completed");
    } catch (error) {
      logger.error({ err: error }, "Private upload cleanup run failed");
    } finally {
      cleanupInFlight = false;
    }
  };

  void run();
  cleanupTimer = setInterval(() => void run(), CLEANUP_INTERVAL_MS);
}