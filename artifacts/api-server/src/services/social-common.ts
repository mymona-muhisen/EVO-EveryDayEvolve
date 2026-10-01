import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  db,
  habitsTable,
  journeyRewardsTable,
  memoriesTable,
  socialActivityEventsTable,
  socialBlocksTable,
  socialFriendRequestsTable,
  socialFriendshipsTable,
  socialNotificationsTable,
  socialShareRecipientsTable,
  socialSharesTable,
  usersTable,
  type SocialNotificationRow,
} from "@workspace/db";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SocialHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SocialHttpError";
  }
}

export type SocialResourceType =
  | "journey"
  | "memory"
  | "reward"
  | "character"
  | "achievements";
export type SharingVisibility = "private" | "friends" | "selected";
export type SocialNotificationType =
  | "friend_request_received"
  | "friend_request_accepted"
  | "challenge_invitation"
  | "challenge_accepted"
  | "challenge_declined"
  | "group_invitation"
  | "group_member_joined"
  | "encouragement_received"
  | "shared_milestone"
  | "group_milestone";

export interface SocialResourceInput {
  viewerUserId: string;
  ownerUserId: string;
  resourceType: SocialResourceType;
  resourceId: string;
}

export interface SocialSharingDto {
  resourceType: SocialResourceType;
  resourceId: string;
  visibility: SharingVisibility;
  selectedUserIds: string[];
}

function canonicalPair(userAId: string, userBId: string): [string, string] {
  return userAId < userBId ? [userAId, userBId] : [userBId, userAId];
}

export async function assertNoSocialBlock(
  tx: DbTransaction,
  userAId: string,
  userBId: string,
): Promise<void> {
  if (userAId === userBId) return;
  const [block] = await tx.select({ id: socialBlocksTable.id })
    .from(socialBlocksTable)
    .where(or(
      and(
        eq(socialBlocksTable.blockerUserId, userAId),
        eq(socialBlocksTable.blockedUserId, userBId),
      ),
      and(
        eq(socialBlocksTable.blockerUserId, userBId),
        eq(socialBlocksTable.blockedUserId, userAId),
      ),
    ))
    .limit(1);
  if (block) throw new SocialHttpError(404, "Social resource not found");
}

/** Pair locks serialize access checks against friendship removal and blocks. */
export async function lockSocialPair(
  tx: DbTransaction,
  userAId: string,
  userBId: string,
): Promise<void> {
  if (userAId === userBId) return;
  await tx.select({ id: usersTable.id }).from(usersTable)
    .where(or(eq(usersTable.id, userAId), eq(usersTable.id, userBId)))
    .orderBy(usersTable.id)
    .for("no key update");
}

/** Locks a set of users in one stable global order before a multi-user mutation. */
export async function lockSocialUsers(
  tx: DbTransaction,
  userIds: string[],
): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return;
  await tx.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.id, ids))
    .orderBy(usersTable.id)
    .for("no key update");
}

export async function areAcceptedSocialFriends(
  tx: DbTransaction,
  userAId: string,
  userBId: string,
): Promise<boolean> {
  if (userAId === userBId) return false;
  const [low, high] = canonicalPair(userAId, userBId);
  const [friendship] = await tx.select({ id: socialFriendshipsTable.id })
    .from(socialFriendshipsTable)
    .where(and(
      eq(socialFriendshipsTable.userLowId, low),
      eq(socialFriendshipsTable.userHighId, high),
    ))
    .limit(1);
  return Boolean(friendship);
}

async function resourceIsOwned(
  tx: DbTransaction,
  ownerUserId: string,
  resourceType: SocialResourceType,
  resourceId: string,
): Promise<boolean> {
  if (resourceType === "character" || resourceType === "achievements") {
    return resourceId === "profile"
      && Boolean((await tx.select({ id: usersTable.id }).from(usersTable)
        .where(eq(usersTable.id, ownerUserId)).limit(1))[0]);
  }
  if (!/^[1-9]\d*$/.test(resourceId)) return false;
  const id = Number(resourceId);
  if (!Number.isSafeInteger(id)) return false;
  if (resourceType === "journey") {
    return Boolean((await tx.select({ id: habitsTable.id }).from(habitsTable)
      .where(and(
        eq(habitsTable.id, id),
        eq(habitsTable.userId, ownerUserId),
        eq(habitsTable.journeyLength, 22),
        isNotNull(habitsTable.journeyStartDate),
      ))
      .limit(1))[0]);
  }
  if (resourceType === "memory") {
    return Boolean((await tx.select({ id: memoriesTable.id }).from(memoriesTable)
      .where(and(eq(memoriesTable.id, id), eq(memoriesTable.userId, ownerUserId)))
      .limit(1))[0]);
  }
  // Social "reward" IDs intentionally refer only to the journey_rewards
  // collection; the legacy coin-cost rewards table is a different feature.
  return Boolean((await tx.select({ id: journeyRewardsTable.id }).from(journeyRewardsTable)
    .where(and(
      eq(journeyRewardsTable.id, id),
      eq(journeyRewardsTable.userId, ownerUserId),
    ))
    .limit(1))[0]);
}

export async function canViewSocialResource(
  tx: DbTransaction,
  input: SocialResourceInput,
): Promise<boolean> {
  try {
    await assertNoSocialBlock(tx, input.viewerUserId, input.ownerUserId);
  } catch (error) {
    if (error instanceof SocialHttpError) return false;
    throw error;
  }
  if (!await resourceIsOwned(tx, input.ownerUserId, input.resourceType, input.resourceId)) {
    return false;
  }
  if (input.viewerUserId === input.ownerUserId) return true;
  const [share] = await tx.select({
    id: socialSharesTable.id,
    visibility: socialSharesTable.visibility,
  }).from(socialSharesTable).where(and(
    eq(socialSharesTable.ownerUserId, input.ownerUserId),
    eq(socialSharesTable.resourceType, input.resourceType),
    eq(socialSharesTable.resourceId, input.resourceId),
  )).limit(1);
  if (!share || share.visibility === "private") return false;
  const isFriend = await areAcceptedSocialFriends(tx, input.viewerUserId, input.ownerUserId);
  if (!isFriend) return false;
  if (share.visibility === "friends") return true;
  const [recipient] = await tx.select({ id: socialShareRecipientsTable.id })
    .from(socialShareRecipientsTable).where(and(
      eq(socialShareRecipientsTable.shareId, share.id),
      eq(socialShareRecipientsTable.recipientUserId, input.viewerUserId),
    )).limit(1);
  return Boolean(recipient);
}

export async function requireViewSocialResource(
  tx: DbTransaction,
  input: SocialResourceInput,
): Promise<void> {
  if (!await canViewSocialResource(tx, input)) {
    throw new SocialHttpError(404, "Social resource not found");
  }
}

export async function setOwnedSocialResourceSharing(
  tx: DbTransaction,
  input: {
    ownerUserId: string;
    resourceType: SocialResourceType;
    resourceId: string;
    visibility: SharingVisibility;
    selectedUserIds?: string[];
  },
): Promise<SocialSharingDto> {
  if (!await resourceIsOwned(
    tx,
    input.ownerUserId,
    input.resourceType,
    input.resourceId,
  )) {
    throw new SocialHttpError(404, "Social resource not found");
  }
  const selectedUserIds = input.visibility === "selected"
    ? input.selectedUserIds ?? []
    : [];
  if (selectedUserIds.length > 100 || new Set(selectedUserIds).size !== selectedUserIds.length) {
    throw new SocialHttpError(400, "Selected recipients must be unique (maximum 100)");
  }
  if (selectedUserIds.includes(input.ownerUserId)) {
    throw new SocialHttpError(400, "You cannot select yourself as a recipient");
  }
  selectedUserIds.sort();
  await lockSocialUsers(tx, [input.ownerUserId, ...selectedUserIds]);
  for (const recipientUserId of selectedUserIds) {
    await assertNoSocialBlock(tx, input.ownerUserId, recipientUserId);
    if (!await areAcceptedSocialFriends(tx, input.ownerUserId, recipientUserId)) {
      throw new SocialHttpError(400, "Selected recipients must be accepted friends");
    }
  }

  // Serialize updates for the same owner without relying on a prior ACL row.
  if (input.visibility !== "selected") {
    await lockSocialUsers(tx, [input.ownerUserId]);
  }
  await tx.insert(socialSharesTable).values({
    ownerUserId: input.ownerUserId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    visibility: input.visibility,
  }).onConflictDoNothing();
  const [share] = await tx.select().from(socialSharesTable).where(and(
    eq(socialSharesTable.ownerUserId, input.ownerUserId),
    eq(socialSharesTable.resourceType, input.resourceType),
    eq(socialSharesTable.resourceId, input.resourceId),
  )).for("update").limit(1);
  if (!share) throw new Error("Sharing preference could not be loaded");
  const [updated] = await tx.update(socialSharesTable).set({
    visibility: input.visibility,
    updatedAt: new Date(),
  }).where(eq(socialSharesTable.id, share.id)).returning();
  await tx.delete(socialShareRecipientsTable)
    .where(eq(socialShareRecipientsTable.shareId, share.id));
  if (selectedUserIds.length) {
    await tx.insert(socialShareRecipientsTable).values(
      selectedUserIds.map((recipientUserId) => ({
        shareId: share.id,
        recipientUserId,
      })),
    );
  }
  return {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    visibility: updated.visibility,
    selectedUserIds,
  };
}

export async function appendSocialActivityOnce(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    eventType: "successful_day" | "milestone" | "journey_completed";
    journeyId: number;
    idempotencyKey: string;
  },
): Promise<number> {
  const [inserted] = await tx.insert(socialActivityEventsTable).values({
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    journeyId: input.journeyId,
    idempotencyKey: input.idempotencyKey,
  }).onConflictDoNothing().returning({ id: socialActivityEventsTable.id });
  if (inserted) return inserted.id;
  const [existing] = await tx.select({ id: socialActivityEventsTable.id })
    .from(socialActivityEventsTable).where(and(
      eq(socialActivityEventsTable.actorUserId, input.actorUserId),
      eq(socialActivityEventsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
  if (!existing) throw new Error("Activity idempotency conflict had no existing row");
  return existing.id;
}

/** Explicit event-time journey audience, excluding stale friendships and either-direction blocks. */
export async function activeSocialShareRecipientIds(
  tx: DbTransaction,
  ownerUserId: string,
  resourceType: SocialResourceType,
  resourceId: string,
): Promise<string[]> {
  const [share] = await tx.select({
    id: socialSharesTable.id,
    visibility: socialSharesTable.visibility,
  }).from(socialSharesTable).where(and(
    eq(socialSharesTable.ownerUserId, ownerUserId),
    eq(socialSharesTable.resourceType, resourceType),
    eq(socialSharesTable.resourceId, resourceId),
  )).limit(1);
  if (!share || share.visibility === "private") return [];
  const friendships = await tx.select({
    userLowId: socialFriendshipsTable.userLowId,
    userHighId: socialFriendshipsTable.userHighId,
  }).from(socialFriendshipsTable).where(or(
    eq(socialFriendshipsTable.userLowId, ownerUserId),
    eq(socialFriendshipsTable.userHighId, ownerUserId),
  ));
  const friendIds = friendships.map((friendship) =>
    friendship.userLowId === ownerUserId ? friendship.userHighId : friendship.userLowId);
  if (!friendIds.length) return [];
  const candidates = share.visibility === "friends"
    ? friendIds
    : (await tx.select({
      recipientUserId: socialShareRecipientsTable.recipientUserId,
    }).from(socialShareRecipientsTable).where(and(
      eq(socialShareRecipientsTable.shareId, share.id),
      inArray(socialShareRecipientsTable.recipientUserId, friendIds),
    ))).map((row) => row.recipientUserId);
  if (!candidates.length) return [];
  const blocks = await tx.select({
    blockerUserId: socialBlocksTable.blockerUserId,
    blockedUserId: socialBlocksTable.blockedUserId,
  }).from(socialBlocksTable).where(or(
    and(
      eq(socialBlocksTable.blockerUserId, ownerUserId),
      inArray(socialBlocksTable.blockedUserId, candidates),
    ),
    and(
      inArray(socialBlocksTable.blockerUserId, candidates),
      eq(socialBlocksTable.blockedUserId, ownerUserId),
    ),
  ));
  const blockedIds = new Set(blocks.map((block) =>
    block.blockerUserId === ownerUserId ? block.blockedUserId : block.blockerUserId));
  return [...new Set(candidates.filter((candidate) => !blockedIds.has(candidate)))].sort();
}

export async function insertSocialNotificationOnce(
  tx: DbTransaction,
  input: {
    recipientUserId: string;
    actorUserId?: string | null;
    type: SocialNotificationType;
    eventKey: string;
    friendRequestId?: number;
    groupInvitationId?: number;
    groupId?: number;
    challengeId?: number;
    encouragementId?: number;
    safeData?: Record<string, string | number | boolean | null>;
  },
): Promise<SocialNotificationRow> {
  const [inserted] = await tx.insert(socialNotificationsTable).values({
    recipientUserId: input.recipientUserId,
    actorUserId: input.actorUserId ?? null,
    type: input.type,
    eventKey: input.eventKey,
    friendRequestId: input.friendRequestId ?? null,
    groupInvitationId: input.groupInvitationId ?? null,
    groupId: input.groupId ?? null,
    challengeId: input.challengeId ?? null,
    encouragementId: input.encouragementId ?? null,
    safeData: input.safeData,
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [existing] = await tx.select().from(socialNotificationsTable).where(and(
    eq(socialNotificationsTable.recipientUserId, input.recipientUserId),
    eq(socialNotificationsTable.eventKey, input.eventKey),
  )).limit(1);
  if (!existing) throw new Error("Notification idempotency conflict had no existing row");
  return existing;
}

export async function selectedRecipientIds(
  tx: DbTransaction,
  ownerUserId: string,
  resourceType: SocialResourceType,
  resourceId: string,
): Promise<string[]> {
  const [share] = await tx.select({ id: socialSharesTable.id })
    .from(socialSharesTable).where(and(
      eq(socialSharesTable.ownerUserId, ownerUserId),
      eq(socialSharesTable.resourceType, resourceType),
      eq(socialSharesTable.resourceId, resourceId),
    )).limit(1);
  if (!share) return [];
  const rows = await tx.select({
    id: socialShareRecipientsTable.recipientUserId,
  }).from(socialShareRecipientsTable).where(eq(socialShareRecipientsTable.shareId, share.id));
  return rows.map((row) => row.id);
}