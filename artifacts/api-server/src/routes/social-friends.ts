import { Router, type IRouter, type RequestHandler } from "express";
import { and, desc, eq, ilike, inArray, isNull, lt, lte, or } from "drizzle-orm";
import {
  db,
  groupMembersTable,
  groupReactionsTable,
  habitsTable,
  habitDaysTable,
  checkinsTable,
  memoriesTable,
  journeyRewardsTable,
  journeyMilestonesTable,
  userJourneyMilestonesTable,
  characterItemsTable,
  userCharacterItemsTable,
  socialActivityEventsTable,
  socialBlocksTable,
  socialChallengeMembersTable,
  socialChallengesTable,
  socialEncouragementsTable,
  socialFriendRequestsTable,
  socialFriendshipsTable,
  socialGroupActivityEventsTable,
  socialGroupJourneySharesTable,
  socialGroupInvitationsTable,
  socialNotificationsTable,
  socialReportsTable,
  socialShareRecipientsTable,
  socialSharesTable,
  usersTable,
} from "@workspace/db";
import {
  CancelSocialFriendRequestParams,
  CancelSocialFriendRequestResponse,
  CreateSocialBlockBody,
  CreateSocialBlockResponse,
  CreateSocialReportBody,
  CreateSocialReportResponse,
  CreateSocialEncouragementBody,
  CreateSocialEncouragementResponse,
  GetSocialMemoryPhotoParams,
  GetSocialProfileParams,
  GetSocialProfileResponse,
  GetSocialResourceSharingParams,
  GetSocialResourceSharingResponse,
  GetSocialMeResponse,
  ListIncomingSocialFriendRequestsResponse,
  ListOutgoingSocialFriendRequestsResponse,
  ListSocialActivityQueryParams,
  ListSocialActivityResponse,
  ListSocialBlocksResponse,
  ListSocialFriendsResponse,
  ListSocialNotificationsQueryParams,
  ListSocialNotificationsResponse,
  MarkAllSocialNotificationsReadResponse,
  MarkSocialNotificationReadParams,
  MarkSocialNotificationReadResponse,
  RemoveSocialBlockParams,
  RemoveSocialBlockResponse,
  RemoveSocialFriendParams,
  RemoveSocialFriendResponse,
  RespondToSocialFriendRequestBody,
  RespondToSocialFriendRequestParams,
  RespondToSocialFriendRequestResponse,
  SearchSocialUsersQueryParams,
  SearchSocialUsersResponse,
  SendSocialFriendRequestBody,
  SendSocialFriendRequestResponse,
  UpdateSocialMeBody,
  UpdateSocialMeResponse,
  UpdateSocialResourceSharingBody,
  UpdateSocialResourceSharingParams,
  UpdateSocialResourceSharingResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { todayInTimezone } from "../lib/dates";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import {
  areAcceptedSocialFriends,
  assertNoSocialBlock,
  canViewSocialResource,
  insertSocialNotificationOnce,
  lockSocialPair,
  requireViewSocialResource,
  selectedRecipientIds,
  setOwnedSocialResourceSharing,
  SocialHttpError,
  type DbTransaction,
  type SocialResourceType,
  type SharingVisibility,
} from "../services/social-common";

const router: IRouter = Router();
router.use(requireAuth);

const objectStorageService = new ObjectStorageService();
type SocialUser = {
  id: string;
  username: string | null;
  displayName: string;
  avatarEmoji: string;
};

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error: unknown) => {
      if (error instanceof SocialHttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

function canonicalPair(userAId: string, userBId: string): [string, string] {
  return userAId < userBId ? [userAId, userBId] : [userBId, userAId];
}

function userSummary(user: SocialUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarEmoji: user.avatarEmoji,
  };
}

async function loadUser(tx: DbTransaction | typeof db, userId: string): Promise<SocialUser | null> {
  const [user] = await tx.select({
    id: usersTable.id,
    username: usersTable.username,
    displayName: usersTable.displayName,
    avatarEmoji: usersTable.avatarEmoji,
  }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user ?? null;
}

async function requestDto(tx: DbTransaction, request: typeof socialFriendRequestsTable.$inferSelect) {
  const [sender, recipient] = await Promise.all([
    loadUser(tx, request.senderUserId),
    loadUser(tx, request.recipientUserId),
  ]);
  if (!sender || !recipient) throw new Error("Friend request user could not be loaded");
  return {
    id: request.id,
    sender: userSummary(sender),
    recipient: userSummary(recipient),
    status: request.status,
    createdAt: request.createdAt,
    respondedAt: request.respondedAt,
  };
}

async function sharingDto(
  tx: DbTransaction,
  ownerUserId: string,
  resourceType: SocialResourceType,
  resourceId: string,
) {
  const [share] = await tx.select({
    visibility: socialSharesTable.visibility,
  }).from(socialSharesTable).where(and(
    eq(socialSharesTable.ownerUserId, ownerUserId),
    eq(socialSharesTable.resourceType, resourceType),
    eq(socialSharesTable.resourceId, resourceId),
  )).limit(1);
  return {
    resourceType,
    resourceId,
    visibility: share?.visibility ?? "private" as const,
    selectedUserIds: await selectedRecipientIds(tx, ownerUserId, resourceType, resourceId),
  };
}

export async function journeySummary(
  tx: DbTransaction,
  habit: typeof habitsTable.$inferSelect,
) {
  const [owner] = await tx.select({
    timezone: usersTable.timezone,
  }).from(usersTable).where(eq(usersTable.id, habit.userId)).limit(1);
  const today = todayInTimezone(owner?.timezone ?? "UTC");
  const elapsedScheduledDays = await tx.select({
    dayNumber: habitDaysTable.dayNumber,
  }).from(habitDaysTable).where(and(
    eq(habitDaysTable.habitId, habit.id),
    eq(habitDaysTable.scheduled, true),
    lte(habitDaysTable.date, today),
  ));
  const successes = await tx.select({
    dayNumber: habitDaysTable.dayNumber,
  }).from(habitDaysTable).innerJoin(checkinsTable, and(
    eq(checkinsTable.habitId, habitDaysTable.habitId),
    eq(checkinsTable.date, habitDaysTable.date),
    eq(checkinsTable.completed, true),
    eq(checkinsTable.userId, habit.userId),
  )).where(and(
    eq(habitDaysTable.habitId, habit.id),
    eq(habitDaysTable.scheduled, true),
    lte(habitDaysTable.date, today),
  ));
  return {
    journeyId: habit.id,
    title: habit.title,
    emoji: habit.emoji,
    category: habit.category,
    progressDay: successes.reduce((current, item) => Math.max(current, item.dayNumber), 0),
    journeyLength: 22 as const,
    successfulDayCount: successes.length,
    consistencyPercentage: elapsedScheduledDays.length === 0
      ? null
      : successes.length / elapsedScheduledDays.length * 100,
    completed: habit.journeyCompletedAt != null,
  };
}

function limitSearch(userId: string, key: string): boolean {
  const now = Date.now();
  const current = searchLimits.get(`${userId}:${key}`);
  if (!current || current.resetAt <= now) {
    searchLimits.set(`${userId}:${key}`, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count++;
  return current.count <= 30;
}

const searchLimits = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of searchLimits) {
    if (limit.resetAt <= now) searchLimits.delete(key);
  }
}, 60_000).unref();

router.get("/social/me", asyncRoute(async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const response = await db.transaction(async (tx) => GetSocialMeResponse.parse({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarEmoji: user.avatarEmoji,
    characterSharing: await sharingDto(tx, user.id, "character", "profile"),
    achievementsSharing: await sharingDto(tx, user.id, "achievements", "profile"),
  }));
  res.json(response);
}));

router.patch("/social/me", asyncRoute(async (req, res): Promise<void> => {
  const parsed = UpdateSocialMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  try {
    const [updated] = await db.update(usersTable).set({
      username: parsed.data.username,
    }).where(eq(usersTable.id, req.userId!)).returning({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      avatarEmoji: usersTable.avatarEmoji,
    });
    if (!updated) throw new SocialHttpError(404, "User not found");
    const response = await db.transaction(async (tx) => UpdateSocialMeResponse.parse({
      ...updated,
      characterSharing: await sharingDto(tx, updated.id, "character", "profile"),
      achievementsSharing: await sharingDto(tx, updated.id, "achievements", "profile"),
    }));
    res.json(response);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "23505")) {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }
    throw error;
  }
}));

router.get("/social/users/search", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = SearchSocialUsersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const address = req.ip ?? "unknown";
  if (!limitSearch(req.userId!, address)) {
    res.status(429).json({ error: "Username search rate limit exceeded" });
    return;
  }
  const escaped = parsed.data.q.replace(/[\\%_]/g, "\\$&");
  const matches = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    displayName: usersTable.displayName,
    avatarEmoji: usersTable.avatarEmoji,
  }).from(usersTable).where(ilike(usersTable.username, `${escaped}%`))
    .orderBy(usersTable.username).limit(parsed.data.limit + 1);
  const candidates = matches.filter((user) => user.id !== req.userId).slice(0, parsed.data.limit);
  const ids = candidates.map((user) => user.id);
  const [friendships, requests, blocks] = ids.length ? await Promise.all([
    db.select().from(socialFriendshipsTable).where(or(
      and(
        eq(socialFriendshipsTable.userLowId, req.userId!),
        inArray(socialFriendshipsTable.userHighId, ids),
      ),
      and(
        eq(socialFriendshipsTable.userHighId, req.userId!),
        inArray(socialFriendshipsTable.userLowId, ids),
      ),
    )),
    db.select().from(socialFriendRequestsTable).where(and(
      eq(socialFriendRequestsTable.status, "pending"),
      or(
        and(
          eq(socialFriendRequestsTable.senderUserId, req.userId!),
          inArray(socialFriendRequestsTable.recipientUserId, ids),
        ),
        and(
          eq(socialFriendRequestsTable.recipientUserId, req.userId!),
          inArray(socialFriendRequestsTable.senderUserId, ids),
        ),
      ),
    )),
    db.select().from(socialBlocksTable).where(or(
      and(
        eq(socialBlocksTable.blockerUserId, req.userId!),
        inArray(socialBlocksTable.blockedUserId, ids),
      ),
      and(
        eq(socialBlocksTable.blockedUserId, req.userId!),
        inArray(socialBlocksTable.blockerUserId, ids),
      ),
    )),
  ]) : [[], [], []];
  const friendIds = new Set(friendships.map((friendship) =>
    friendship.userLowId === req.userId ? friendship.userHighId : friendship.userLowId));
  const blockedIds = new Set(blocks.map((block) =>
    block.blockerUserId === req.userId ? block.blockedUserId : block.blockerUserId));
  const requestByUser = new Map(requests.map((request) => [
    request.senderUserId === req.userId ? request.recipientUserId : request.senderUserId,
    request,
  ]));
  res.json(SearchSocialUsersResponse.parse(candidates.map((candidate) => ({
    ...userSummary(candidate),
    relationship: blockedIds.has(candidate.id)
      ? "blocked"
      : friendIds.has(candidate.id)
        ? "friend"
        : requestByUser.get(candidate.id)?.senderUserId === req.userId
          ? "pending_outgoing"
          : requestByUser.has(candidate.id)
            ? "pending_incoming"
            : "none",
  }))));
}));

router.get("/social/friends", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const friendships = await db.select().from(socialFriendshipsTable).where(or(
    eq(socialFriendshipsTable.userLowId, req.userId!),
    eq(socialFriendshipsTable.userHighId, req.userId!),
  )).orderBy(desc(socialFriendshipsTable.createdAt));
  const rows = [];
  for (const friendship of friendships) {
    const friendId = friendship.userLowId === req.userId
      ? friendship.userHighId
      : friendship.userLowId;
    const friend = await loadUser(db, friendId);
    if (friend) rows.push({ ...userSummary(friend), friendsSince: friendship.createdAt });
  }
  res.json(ListSocialFriendsResponse.parse(rows));
}));

router.get("/social/friend-requests/incoming", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const rows = await db.select().from(socialFriendRequestsTable).where(and(
    eq(socialFriendRequestsTable.recipientUserId, req.userId!),
    eq(socialFriendRequestsTable.status, "pending"),
  )).orderBy(desc(socialFriendRequestsTable.createdAt));
  res.json(ListIncomingSocialFriendRequestsResponse.parse(await Promise.all(
    rows.map((row) => db.transaction((tx) => requestDto(tx, row))),
  )));
}));

router.get("/social/friend-requests/outgoing", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const rows = await db.select().from(socialFriendRequestsTable).where(and(
    eq(socialFriendRequestsTable.senderUserId, req.userId!),
    eq(socialFriendRequestsTable.status, "pending"),
  )).orderBy(desc(socialFriendRequestsTable.createdAt));
  res.json(ListOutgoingSocialFriendRequestsResponse.parse(await Promise.all(
    rows.map((row) => db.transaction((tx) => requestDto(tx, row))),
  )));
}));

router.post("/social/friend-requests", asyncRoute(async (req, res): Promise<void> => {
  const parsed = SendSocialFriendRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  if (req.userId === parsed.data.recipientUserId) {
    res.status(400).json({ error: "You cannot send a friend request to yourself" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      await lockSocialPair(tx, req.userId!, parsed.data.recipientUserId);
      await assertNoSocialBlock(tx, req.userId!, parsed.data.recipientUserId);
      const recipient = await loadUser(tx, parsed.data.recipientUserId);
      if (!recipient) throw new SocialHttpError(404, "User not found");
      const [low, high] = canonicalPair(req.userId!, parsed.data.recipientUserId);
      const [friendship] = await tx.select({ id: socialFriendshipsTable.id })
        .from(socialFriendshipsTable).where(and(
          eq(socialFriendshipsTable.userLowId, low),
          eq(socialFriendshipsTable.userHighId, high),
        )).limit(1);
      if (friendship) throw new SocialHttpError(409, "You are already friends");
      const [existing] = await tx.select({ id: socialFriendRequestsTable.id })
        .from(socialFriendRequestsTable).where(and(
          eq(socialFriendRequestsTable.pairUserLowId, low),
          eq(socialFriendRequestsTable.pairUserHighId, high),
          eq(socialFriendRequestsTable.status, "pending"),
        )).limit(1);
      if (existing) throw new SocialHttpError(409, "A friend request is already pending");
      const [request] = await tx.insert(socialFriendRequestsTable).values({
        senderUserId: req.userId!,
        recipientUserId: recipient.id,
        pairUserLowId: low,
        pairUserHighId: high,
      }).returning();
      if (!request) throw new Error("Friend request insert returned no row");
      await insertSocialNotificationOnce(tx, {
        recipientUserId: recipient.id,
        actorUserId: req.userId!,
        type: "friend_request_received",
        eventKey: `friend-request:${request.id}:received`,
        friendRequestId: request.id,
      });
      return requestDto(tx, request);
    });
    res.status(201).json(SendSocialFriendRequestResponse.parse(result));
  } catch (error) {
    if (hasDatabaseErrorCode(error, "23505")) {
      res.status(409).json({ error: "A friend request is already pending" });
      return;
    }
    throw error;
  }
}));

router.post(
  "/social/friend-requests/:requestId/respond",
  asyncRoute(async (req, res): Promise<void> => {
    const params = RespondToSocialFriendRequestParams.safeParse(req.params);
    const body = RespondToSocialFriendRequestBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    await ensureUser(req.userId!);
    const dto = await db.transaction(async (tx) => {
      const [requestSnapshot] = await tx.select({
        senderUserId: socialFriendRequestsTable.senderUserId,
      }).from(socialFriendRequestsTable).where(and(
        eq(socialFriendRequestsTable.id, params.data.requestId),
        eq(socialFriendRequestsTable.recipientUserId, req.userId!),
      ));
      if (!requestSnapshot) throw new SocialHttpError(404, "Friend request not found");
      await lockSocialPair(tx, requestSnapshot.senderUserId, req.userId!);
      const [request] = await tx.select().from(socialFriendRequestsTable).where(and(
        eq(socialFriendRequestsTable.id, params.data.requestId),
        eq(socialFriendRequestsTable.recipientUserId, req.userId!),
      )).for("update").limit(1);
      if (!request) throw new SocialHttpError(404, "Friend request not found");
      const targetStatus = body.data.decision === "accept" ? "accepted" : "declined";
      if (request.status !== "pending") {
        if (request.status === targetStatus) return requestDto(tx, request);
        throw new SocialHttpError(409, "Friend request is no longer pending");
      }
      await assertNoSocialBlock(tx, request.senderUserId, req.userId!);
      const [updated] = await tx.update(socialFriendRequestsTable).set({
        status: targetStatus,
        respondedAt: new Date(),
      }).where(and(
        eq(socialFriendRequestsTable.id, request.id),
        eq(socialFriendRequestsTable.status, "pending"),
      )).returning();
      if (!updated) throw new SocialHttpError(409, "Friend request is no longer pending");
      if (body.data.decision === "accept") {
        await tx.insert(socialFriendshipsTable).values({
          userLowId: request.pairUserLowId,
          userHighId: request.pairUserHighId,
          createdFromRequestId: request.id,
        }).onConflictDoNothing();
        await insertSocialNotificationOnce(tx, {
          recipientUserId: request.senderUserId,
          actorUserId: req.userId!,
          type: "friend_request_accepted",
          eventKey: `friend-request:${request.id}:accepted`,
          friendRequestId: request.id,
        });
      }
      return requestDto(tx, updated);
    });
    res.json(RespondToSocialFriendRequestResponse.parse(dto));
  }),
);

router.delete(
  "/social/friend-requests/:requestId",
  asyncRoute(async (req, res): Promise<void> => {
    const params = CancelSocialFriendRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await ensureUser(req.userId!);
    await db.transaction(async (tx) => {
      const [snapshot] = await tx.select({
        recipientUserId: socialFriendRequestsTable.recipientUserId,
      }).from(socialFriendRequestsTable).where(and(
        eq(socialFriendRequestsTable.id, params.data.requestId),
        eq(socialFriendRequestsTable.senderUserId, req.userId!),
      )).limit(1);
      if (!snapshot) throw new SocialHttpError(404, "Pending friend request not found");
      await lockSocialPair(tx, req.userId!, snapshot.recipientUserId);
      const [canceled] = await tx.update(socialFriendRequestsTable).set({
        status: "canceled",
        respondedAt: new Date(),
      }).where(and(
        eq(socialFriendRequestsTable.id, params.data.requestId),
        eq(socialFriendRequestsTable.senderUserId, req.userId!),
        eq(socialFriendRequestsTable.status, "pending"),
      )).returning({ id: socialFriendRequestsTable.id });
      if (!canceled) throw new SocialHttpError(404, "Pending friend request not found");
    });
    CancelSocialFriendRequestResponse.parse(undefined);
    res.sendStatus(204);
  }),
);

router.delete("/social/friends/:friendUserId", asyncRoute(async (req, res): Promise<void> => {
  const params = RemoveSocialFriendParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await ensureUser(req.userId!);
  if (params.data.friendUserId === req.userId) {
    res.status(400).json({ error: "You cannot remove yourself" });
    return;
  }
  const [low, high] = canonicalPair(req.userId!, params.data.friendUserId);
  const [removed] = await db.transaction(async (tx) => {
    await lockSocialPair(tx, req.userId!, params.data.friendUserId);
    return tx.delete(socialFriendshipsTable).where(and(
      eq(socialFriendshipsTable.userLowId, low),
      eq(socialFriendshipsTable.userHighId, high),
    )).returning({ id: socialFriendshipsTable.id });
  });
  if (!removed) throw new SocialHttpError(404, "Friendship not found");
  RemoveSocialFriendResponse.parse(undefined);
  res.sendStatus(204);
}));

router.get("/social/blocks", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const rows = await db.select({
    id: usersTable.id,
    username: usersTable.username,
    displayName: usersTable.displayName,
    avatarEmoji: usersTable.avatarEmoji,
  }).from(socialBlocksTable).innerJoin(
    usersTable,
    eq(usersTable.id, socialBlocksTable.blockedUserId),
  ).where(eq(socialBlocksTable.blockerUserId, req.userId!))
    .orderBy(desc(socialBlocksTable.createdAt));
  res.json(ListSocialBlocksResponse.parse(rows.map(userSummary)));
}));

router.post("/social/blocks", asyncRoute(async (req, res): Promise<void> => {
  const parsed = CreateSocialBlockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const blockedUserId = parsed.data.blockedUserId;
  if (blockedUserId === req.userId) {
    res.status(400).json({ error: "You cannot block yourself" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const blockedUser = await loadUser(tx, blockedUserId);
    if (!blockedUser) throw new SocialHttpError(404, "User not found");
    await lockSocialPair(tx, req.userId!, blockedUserId);
    const [block] = await tx.insert(socialBlocksTable).values({
      blockerUserId: req.userId!,
      blockedUserId,
    }).onConflictDoNothing().returning();
    const [existingBlock] = block ? [block] : await tx.select()
      .from(socialBlocksTable).where(and(
        eq(socialBlocksTable.blockerUserId, req.userId!),
        eq(socialBlocksTable.blockedUserId, blockedUserId),
      )).limit(1);

    const [low, high] = canonicalPair(req.userId!, blockedUserId);
    await tx.delete(socialFriendshipsTable).where(and(
      eq(socialFriendshipsTable.userLowId, low),
      eq(socialFriendshipsTable.userHighId, high),
    ));
    await tx.update(socialFriendRequestsTable).set({
      status: "canceled",
      respondedAt: new Date(),
    }).where(and(
      eq(socialFriendRequestsTable.pairUserLowId, low),
      eq(socialFriendRequestsTable.pairUserHighId, high),
      eq(socialFriendRequestsTable.status, "pending"),
    ));
    const selectedShares = await tx.select({
      shareId: socialSharesTable.id,
      ownerUserId: socialSharesTable.ownerUserId,
      recipientUserId: socialShareRecipientsTable.recipientUserId,
    }).from(socialShareRecipientsTable).innerJoin(
      socialSharesTable,
      eq(socialSharesTable.id, socialShareRecipientsTable.shareId),
    ).where(or(
      and(
        eq(socialSharesTable.ownerUserId, req.userId!),
        eq(socialShareRecipientsTable.recipientUserId, blockedUserId),
      ),
      and(
        eq(socialSharesTable.ownerUserId, blockedUserId),
        eq(socialShareRecipientsTable.recipientUserId, req.userId!),
      ),
    ));
    for (const selected of selectedShares) {
      await tx.delete(socialShareRecipientsTable).where(and(
        eq(socialShareRecipientsTable.shareId, selected.shareId),
        eq(socialShareRecipientsTable.recipientUserId, selected.recipientUserId),
      ));
    }
    await tx.update(socialGroupInvitationsTable).set({
      status: "canceled",
      respondedAt: new Date(),
    }).where(and(
      eq(socialGroupInvitationsTable.status, "pending"),
      or(
        and(
          eq(socialGroupInvitationsTable.inviterUserId, req.userId!),
          eq(socialGroupInvitationsTable.inviteeUserId, blockedUserId),
        ),
        and(
          eq(socialGroupInvitationsTable.inviterUserId, blockedUserId),
          eq(socialGroupInvitationsTable.inviteeUserId, req.userId!),
        ),
      ),
    ));
    const createdChallenges = await tx.select({ id: socialChallengesTable.id })
      .from(socialChallengesTable).where(eq(socialChallengesTable.creatorUserId, req.userId!));
    if (createdChallenges.length) {
      await tx.update(socialChallengeMembersTable).set({ status: "declined" })
        .where(and(
          inArray(socialChallengeMembersTable.challengeId, createdChallenges.map((row) => row.id)),
          eq(socialChallengeMembersTable.userId, blockedUserId),
          eq(socialChallengeMembersTable.status, "invited"),
        ));
    }
    const blockedChallenges = await tx.select({ id: socialChallengesTable.id })
      .from(socialChallengesTable).where(eq(socialChallengesTable.creatorUserId, blockedUserId));
    if (blockedChallenges.length) {
      await tx.update(socialChallengeMembersTable).set({ status: "declined" })
        .where(and(
          inArray(socialChallengeMembersTable.challengeId, blockedChallenges.map((row) => row.id)),
          eq(socialChallengeMembersTable.userId, req.userId!),
          eq(socialChallengeMembersTable.status, "invited"),
        ));
    }
    return { block: existingBlock, blockedUser };
  });
  res.status(201).json(CreateSocialBlockResponse.parse({
    id: result.block.id,
    blockedUser: userSummary(result.blockedUser),
    createdAt: result.block.createdAt,
  }));
}));

router.delete("/social/blocks/:blockedUserId", asyncRoute(async (req, res): Promise<void> => {
  const params = RemoveSocialBlockParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const [removed] = await db.transaction(async (tx) => {
    await lockSocialPair(tx, req.userId!, params.data.blockedUserId);
    return tx.delete(socialBlocksTable).where(and(
      eq(socialBlocksTable.blockerUserId, req.userId!),
      eq(socialBlocksTable.blockedUserId, params.data.blockedUserId),
    )).returning({ id: socialBlocksTable.id });
  });
  if (!removed) throw new SocialHttpError(404, "Block not found");
  RemoveSocialBlockResponse.parse(undefined);
  res.sendStatus(204);
}));

router.post("/social/reports", asyncRoute(async (req, res): Promise<void> => {
  const parsed = CreateSocialReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  if (parsed.data.reportedUserId === req.userId) {
    res.status(400).json({ error: "You cannot report yourself" });
    return;
  }
  const reported = await loadUser(db, parsed.data.reportedUserId);
  if (!reported) throw new SocialHttpError(404, "User not found");
  const [report] = await db.insert(socialReportsTable).values({
    reporterUserId: req.userId!,
    reportedUserId: reported.id,
    reason: parsed.data.reason,
    details: parsed.data.details ?? null,
  }).returning();
  res.status(201).json(CreateSocialReportResponse.parse({
    id: report.id,
    status: report.status,
    createdAt: report.createdAt,
  }));
}));

router.get("/social/profiles/:userId", asyncRoute(async (req, res): Promise<void> => {
  const params = GetSocialProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const profile = await db.transaction(async (tx) => {
    const owner = await loadUser(tx, params.data.userId);
    if (!owner) throw new SocialHttpError(404, "Profile not found");
    await assertNoSocialBlock(tx, req.userId!, owner.id);
    const characterAllowed = await canViewSocialResource(tx, {
      viewerUserId: req.userId!,
      ownerUserId: owner.id,
      resourceType: "character",
      resourceId: "profile",
    });
    const achievementsAllowed = await canViewSocialResource(tx, {
      viewerUserId: req.userId!,
      ownerUserId: owner.id,
      resourceType: "achievements",
      resourceId: "profile",
    });
    const character = characterAllowed
      ? await tx.select({
        slot: characterItemsTable.slot,
        name: characterItemsTable.name,
        emoji: characterItemsTable.emoji,
      }).from(userCharacterItemsTable).innerJoin(
        characterItemsTable,
        eq(characterItemsTable.id, userCharacterItemsTable.itemId),
      ).where(and(
        eq(userCharacterItemsTable.userId, owner.id),
        eq(userCharacterItemsTable.equipped, true),
      ))
      : [];
    const achievements = achievementsAllowed
      ? await tx.select({
        title: journeyMilestonesTable.title,
        description: journeyMilestonesTable.description,
        emoji: journeyMilestonesTable.emoji,
        reachedAt: userJourneyMilestonesTable.reachedAt,
      }).from(userJourneyMilestonesTable).innerJoin(
        journeyMilestonesTable,
        eq(journeyMilestonesTable.id, userJourneyMilestonesTable.milestoneId),
      ).where(eq(userJourneyMilestonesTable.userId, owner.id))
        .orderBy(desc(userJourneyMilestonesTable.reachedAt))
      : [];

    const journeys = await tx.select().from(habitsTable).where(and(
      eq(habitsTable.userId, owner.id),
      eq(habitsTable.journeyLength, 22),
    ));
    const visibleJourneySummaries = [];
    for (const habit of journeys) {
      if (habit.journeyStartDate == null || !await canViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: owner.id,
        resourceType: "journey",
        resourceId: String(habit.id),
      })) continue;
      visibleJourneySummaries.push(await journeySummary(tx, habit));
    }

    const memoryRows = await tx.select().from(memoriesTable)
      .where(eq(memoriesTable.userId, owner.id))
      .orderBy(desc(memoriesTable.date), desc(memoriesTable.createdAt));
    const sharedMemories = [];
    for (const memory of memoryRows) {
      if (!memory.photoObjectPath || !await canViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: owner.id,
        resourceType: "memory",
        resourceId: String(memory.id),
      })) continue;
      sharedMemories.push({
        id: memory.id,
        caption: memory.caption,
        date: new Date(`${memory.date}T00:00:00.000Z`),
        photoUrl: `/api/social/memories/${memory.id}/photo`,
      });
    }

    const rewards = await tx.select().from(journeyRewardsTable)
      .where(eq(journeyRewardsTable.userId, owner.id))
      .orderBy(desc(journeyRewardsTable.createdAt));
    const sharedRewards = [];
    for (const reward of rewards) {
      if (!await canViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: owner.id,
        resourceType: "reward",
        resourceId: String(reward.id),
      })) continue;
      sharedRewards.push({
        id: reward.id,
        title: reward.title,
        emoji: reward.type === "physical" ? "🎁" : "✨",
      });
    }
    return GetSocialProfileResponse.parse({
      user: userSummary(owner),
      character,
      achievements,
      visibleJourneySummaries,
      sharedMemories,
      sharedRewards,
    });
  });
  res.json(profile);
}));

router.get(
  "/social/sharing/:resourceType/:resourceId",
  asyncRoute(async (req, res): Promise<void> => {
    const params = GetSocialResourceSharingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await ensureUser(req.userId!);
    const response = await db.transaction(async (tx) => {
      await requireViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: req.userId!,
        resourceType: params.data.resourceType,
        resourceId: params.data.resourceId,
      });
      return GetSocialResourceSharingResponse.parse(await sharingDto(
        tx,
        req.userId!,
        params.data.resourceType,
        params.data.resourceId,
      ));
    });
    res.json(response);
  }),
);

router.patch(
  "/social/sharing/:resourceType/:resourceId",
  asyncRoute(async (req, res): Promise<void> => {
    const params = UpdateSocialResourceSharingParams.safeParse(req.params);
    const body = UpdateSocialResourceSharingBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (body.data.visibility === "selected"
      && (body.data.selectedUserIds === undefined || body.data.selectedUserIds.length === 0)) {
      res.status(400).json({ error: "Selected visibility requires at least one selected recipient" });
      return;
    }
    await ensureUser(req.userId!);
    const response = await db.transaction(async (tx) => UpdateSocialResourceSharingResponse.parse(
      await setOwnedSocialResourceSharing(tx, {
        ownerUserId: req.userId!,
        resourceType: params.data.resourceType,
        resourceId: params.data.resourceId,
        visibility: body.data.visibility as SharingVisibility,
        selectedUserIds: body.data.selectedUserIds,
      }),
    ));
    res.json(response);
  }),
);

router.get(
  "/social/memories/:memoryId/photo",
  asyncRoute(async (req, res): Promise<void> => {
    const params = GetSocialMemoryPhotoParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await ensureUser(req.userId!);
    const memory = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(memoriesTable).where(eq(memoriesTable.id, params.data.memoryId))
        .limit(1);
      if (!row || !row.photoObjectPath) throw new SocialHttpError(404, "Memory photo not found");
      await requireViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: row.userId,
        resourceType: "memory",
        resourceId: String(row.id),
      });
      return row;
    });
    try {
      // Verify the existing same-owner private storage ACL/provenance without
      // ever modifying its object metadata. Generic storage remains owner-only.
      const { objectFile, metadata } = await objectStorageService.getOwnedPrivateObjectEntity(
        memory.photoObjectPath!,
        memory.userId,
      );
      const contentType = String(metadata.contentType ?? "application/octet-stream");
      if (!contentType.startsWith("image/")) {
        res.status(404).json({ error: "Memory photo not found" });
        return;
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
      const stream = objectFile.createReadStream();
      stream.on("error", () => {
        if (!res.headersSent) res.status(404).json({ error: "Memory photo unavailable" });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Memory photo not found" });
        return;
      }
      if (error instanceof SocialHttpError) throw error;
      res.status(404).json({ error: "Memory photo unavailable" });
    }
  }),
);

router.get("/social/activity", asyncRoute(async (req, res): Promise<void> => {
  const parsed = ListSocialActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const response = await db.transaction(async (tx) => {
    const conditions = parsed.data.beforeId === undefined
      ? []
      : [lt(socialActivityEventsTable.id, parsed.data.beforeId)];
    const events = await tx.select().from(socialActivityEventsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(socialActivityEventsTable.id))
      .limit(parsed.data.limit * 5);
    const result = [];
    for (const event of events) {
      if (event.journeyId == null || event.actorUserId === req.userId) continue;
      if (!await areAcceptedSocialFriends(tx, req.userId!, event.actorUserId)) continue;
      const [habit] = await tx.select().from(habitsTable).where(and(
        eq(habitsTable.id, event.journeyId),
        eq(habitsTable.userId, event.actorUserId),
        eq(habitsTable.journeyLength, 22),
      )).limit(1);
      if (!habit || !habit.journeyStartDate) continue;
      const allowed = await canViewSocialResource(tx, {
        viewerUserId: req.userId!,
        ownerUserId: event.actorUserId,
        resourceType: "journey",
        resourceId: String(habit.id),
      });
      if (!allowed) continue;
      const actor = await loadUser(tx, event.actorUserId);
      if (!actor) continue;
      const journey = await journeySummary(tx, habit);
      const keyMilestone = event.eventType === "milestone"
        ? Number(event.idempotencyKey.split(":").at(-1))
        : null;
      const activityDate = event.eventType === "successful_day"
        ? event.idempotencyKey.split(":").at(-1)
        : null;
      const activityDay = activityDate
        ? (await tx.select({ dayNumber: habitDaysTable.dayNumber })
          .from(habitDaysTable).where(and(
            eq(habitDaysTable.habitId, habit.id),
            eq(habitDaysTable.date, activityDate),
          )).limit(1))[0]?.dayNumber ?? null
        : null;
      result.push({
        id: event.id,
        actor: userSummary(actor),
        eventType: event.eventType,
        journey,
        progressDay: event.eventType === "successful_day"
          ? activityDay
          : event.eventType === "milestone" ? journey.progressDay : 22,
        milestoneTitle: event.eventType === "milestone"
          ? `${keyMilestone} successful days`
          : null,
        createdAt: event.createdAt,
      });
      if (result.length >= parsed.data.limit) break;
    }
    return ListSocialActivityResponse.parse(result);
  });
  res.json(response);
}));

router.post("/social/encouragements", asyncRoute(async (req, res): Promise<void> => {
  const parsed = CreateSocialEncouragementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const input = parsed.data;
  const now = new Date();
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const result = await db.transaction(async (tx) => {
    const sender = await loadUser(tx, req.userId!);
    const receiver = await loadUser(tx, input.receiverUserId);
    if (!sender || !receiver) throw new SocialHttpError(404, "User not found");
    await lockSocialPair(tx, sender.id, receiver.id);
    await assertNoSocialBlock(tx, sender.id, receiver.id);
    const [prior] = await tx.select().from(socialEncouragementsTable).where(and(
      eq(socialEncouragementsTable.senderUserId, sender.id),
      eq(socialEncouragementsTable.requestId, input.requestId),
    )).limit(1);
    if (prior) {
      if (prior.receiverUserId !== receiver.id || prior.journeyId !== (input.journeyId ?? null)
        || prior.type !== input.type || prior.template !== input.template
        || prior.message !== (input.message ?? null)) {
        throw new SocialHttpError(409, "Request ID was already used for different encouragement");
      }
      return { row: prior, sender, receiver };
    }
    if (!await areAcceptedSocialFriends(tx, sender.id, receiver.id)) {
      throw new SocialHttpError(404, "Friend not found");
    }
    if (input.journeyId !== undefined && !await canViewSocialResource(tx, {
      viewerUserId: sender.id,
      ownerUserId: receiver.id,
      resourceType: "journey",
      resourceId: String(input.journeyId),
    })) {
      throw new SocialHttpError(404, "Shared journey not found");
    }
    const [inserted] = await tx.insert(socialEncouragementsTable).values({
      senderUserId: sender.id,
      receiverUserId: receiver.id,
      journeyId: input.journeyId ?? null,
      type: input.type,
      template: input.template,
      message: input.message ?? null,
      requestId: input.requestId,
      cooldownBucket: bucket,
    }).onConflictDoNothing().returning();
    if (!inserted) {
      const [retry] = await tx.select().from(socialEncouragementsTable).where(and(
        eq(socialEncouragementsTable.senderUserId, sender.id),
        eq(socialEncouragementsTable.requestId, input.requestId),
      )).limit(1);
      if (retry) {
        if (retry.receiverUserId !== receiver.id || retry.journeyId !== (input.journeyId ?? null)
          || retry.type !== input.type || retry.template !== input.template
          || retry.message !== (input.message ?? null)) {
          throw new SocialHttpError(409, "Request ID was already used for different encouragement");
        }
        return { row: retry, sender, receiver };
      }
      throw new SocialHttpError(409, "You can send one encouragement to this friend per minute");
    }
    await insertSocialNotificationOnce(tx, {
      recipientUserId: receiver.id,
      actorUserId: sender.id,
      type: "encouragement_received",
      eventKey: `encouragement:${inserted.id}:received`,
      encouragementId: inserted.id,
    });
    return { row: inserted, sender, receiver };
  });
  res.status(201).json(CreateSocialEncouragementResponse.parse({
    id: result.row.id,
    sender: userSummary(result.sender),
    receiver: userSummary(result.receiver),
    journeyId: result.row.journeyId,
    type: result.row.type,
    template: result.row.template,
    message: result.row.message,
    createdAt: result.row.createdAt,
  }));
}));

type VisibleNotification = Awaited<ReturnType<typeof visibleNotification>>;

async function visibleNotification(tx: DbTransaction, row: typeof socialNotificationsTable.$inferSelect) {
  let encouragementTemplate: string | null = null;
  let encouragementMessage: string | null = null;
  const actor = row.actorUserId ? await loadUser(tx, row.actorUserId) : null;
  if (row.actorUserId) {
    try {
      await assertNoSocialBlock(tx, row.recipientUserId, row.actorUserId);
    } catch (error) {
      if (error instanceof SocialHttpError) return null;
      throw error;
    }
  }
  if (row.type === "friend_request_received" || row.type === "friend_request_accepted") {
    if (!row.friendRequestId) return null;
    const [request] = await tx.select().from(socialFriendRequestsTable).where(eq(
      socialFriendRequestsTable.id,
      row.friendRequestId,
    )).limit(1);
    if (!request || ![request.senderUserId, request.recipientUserId].includes(row.recipientUserId)) return null;
    if (row.type === "friend_request_received" && request.status !== "pending") return null;
    if (row.type === "friend_request_accepted"
      && (request.status !== "accepted" || !await areAcceptedSocialFriends(
        tx,
        request.senderUserId,
        request.recipientUserId,
      ))) return null;
  } else if (row.type === "encouragement_received") {
    if (!actor) return null;
    if (row.encouragementId != null) {
      const [encouragement] = await tx.select().from(socialEncouragementsTable)
        .where(and(
          eq(socialEncouragementsTable.id, row.encouragementId),
          eq(socialEncouragementsTable.receiverUserId, row.recipientUserId),
        )).limit(1);
      if (!encouragement || encouragement.senderUserId !== actor.id
        || !await areAcceptedSocialFriends(tx, row.recipientUserId, actor.id)) return null;
      // An optional journey is owned by the receiver of this encouragement.
      if (encouragement.journeyId != null && !await canViewSocialResource(tx, {
        viewerUserId: actor.id,
        ownerUserId: row.recipientUserId,
        resourceType: "journey",
        resourceId: String(encouragement.journeyId),
      })) return null;
      encouragementTemplate = encouragement.template;
      encouragementMessage = encouragement.message;
    } else {
      const safeData = row.safeData;
      const reactionId = safeData && typeof safeData === "object"
        ? Number((safeData as Record<string, unknown>).groupReactionId)
        : NaN;
      if (!row.groupId || !Number.isSafeInteger(reactionId)) return null;
      const [reaction] = await tx.select().from(groupReactionsTable).where(and(
        eq(groupReactionsTable.id, reactionId),
        eq(groupReactionsTable.groupId, row.groupId),
        eq(groupReactionsTable.fromUserId, actor.id),
      )).limit(1);
      if (!reaction || (reaction.toUserId != null && reaction.toUserId !== row.recipientUserId)) return null;
      const members = await tx.select({ userId: groupMembersTable.userId })
        .from(groupMembersTable).where(and(
          eq(groupMembersTable.groupId, row.groupId),
          inArray(groupMembersTable.userId, [actor.id, row.recipientUserId]),
        ));
      if (new Set(members.map((member) => member.userId)).size !== 2) return null;
      encouragementTemplate = reaction.templateCode;
      encouragementMessage = reaction.message;
    }
  } else if (row.type === "shared_milestone") {
    const eventId = Number(row.eventKey.replace(/^social-activity:/, ""));
    if (!Number.isSafeInteger(eventId)) return null;
    const [event] = await tx.select().from(socialActivityEventsTable)
      .where(eq(socialActivityEventsTable.id, eventId)).limit(1);
    if (!event || event.eventType !== "milestone" || event.journeyId == null || !actor
      || !await areAcceptedSocialFriends(tx, row.recipientUserId, actor.id)
      || !await canViewSocialResource(tx, {
        viewerUserId: row.recipientUserId,
        ownerUserId: actor.id,
        resourceType: "journey",
        resourceId: String(event.journeyId),
      })) return null;
  } else if (row.type === "group_milestone") {
    const match = /^group-progress:(\d+):(.+)$/.exec(row.eventKey);
    if (!match || !actor || row.groupId !== Number(match[1])) return null;
    const groupId = Number(match[1]);
    const [event] = await tx.select().from(socialGroupActivityEventsTable).where(and(
      eq(socialGroupActivityEventsTable.groupId, groupId),
      eq(socialGroupActivityEventsTable.idempotencyKey, match[2]),
      eq(socialGroupActivityEventsTable.actorUserId, actor.id),
    )).limit(1);
    if (!event || event.journeyId == null || event.eventType === "member_joined") return null;
    const memberships = await tx.select({ userId: groupMembersTable.userId })
      .from(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, groupId),
        inArray(groupMembersTable.userId, [actor.id, row.recipientUserId]),
      ));
    const [share] = await tx.select({ id: socialGroupJourneySharesTable.id })
      .from(socialGroupJourneySharesTable).where(and(
        eq(socialGroupJourneySharesTable.groupId, groupId),
        eq(socialGroupJourneySharesTable.userId, actor.id),
        eq(socialGroupJourneySharesTable.habitId, event.journeyId),
      )).limit(1);
    const [habit] = await tx.select({
      id: habitsTable.id,
      journeyLength: habitsTable.journeyLength,
      journeyStartDate: habitsTable.journeyStartDate,
    }).from(habitsTable).where(and(
      eq(habitsTable.id, event.journeyId),
      eq(habitsTable.userId, actor.id),
    )).limit(1);
    if (new Set(memberships.map((member) => member.userId)).size !== 2
      || !share || !habit || habit.journeyLength !== 22 || !habit.journeyStartDate) return null;
  } else if (row.groupInvitationId != null || row.groupId != null) {
    const groupId = row.groupId ?? (await tx.select({
      groupId: socialGroupInvitationsTable.groupId,
    }).from(socialGroupInvitationsTable)
      .where(eq(socialGroupInvitationsTable.id, row.groupInvitationId!))
      .limit(1))[0]?.groupId;
    if (groupId == null) return null;
    if (row.groupInvitationId != null) {
      const [invitation] = await tx.select().from(socialGroupInvitationsTable)
        .where(and(
          eq(socialGroupInvitationsTable.id, row.groupInvitationId),
          eq(socialGroupInvitationsTable.inviteeUserId, row.recipientUserId),
          eq(socialGroupInvitationsTable.status, "pending"),
        )).limit(1);
      if (!invitation) return null;
    } else {
      const [membership] = await tx.select({ userId: groupMembersTable.userId })
        .from(groupMembersTable).where(and(
          eq(groupMembersTable.groupId, groupId),
          eq(groupMembersTable.userId, row.recipientUserId),
        )).limit(1);
      if (!membership) return null;
    }
  } else if (row.challengeId != null) {
    if (row.type !== "challenge_invitation" && !actor) return null;
    const [challenge] = await tx.select({ creatorUserId: socialChallengesTable.creatorUserId })
      .from(socialChallengesTable).where(eq(
        socialChallengesTable.id,
        row.challengeId,
      )).limit(1);
    if (!challenge) return null;
    const memberStatus = row.type === "challenge_invitation" ? "invited"
      : row.type === "challenge_accepted" ? "accepted" : "declined";
    const targetUserId = row.type === "challenge_invitation"
      ? row.recipientUserId
      : actor?.id;
    const [member] = await tx.select({ id: socialChallengeMembersTable.id })
      .from(socialChallengeMembersTable).where(and(
        eq(socialChallengeMembersTable.challengeId, row.challengeId),
        eq(socialChallengeMembersTable.userId, targetUserId!),
        eq(socialChallengeMembersTable.status, memberStatus),
      )).limit(1);
    if (!member) return null;
    if (row.type !== "challenge_invitation" && challenge.creatorUserId !== row.recipientUserId) return null;
    if (row.type !== "challenge_invitation") {
      const [creatorMember] = await tx.select({ id: socialChallengeMembersTable.id })
        .from(socialChallengeMembersTable).where(and(
          eq(socialChallengeMembersTable.challengeId, row.challengeId),
          eq(socialChallengeMembersTable.userId, row.recipientUserId),
          eq(socialChallengeMembersTable.status, "accepted"),
        )).limit(1);
      if (!creatorMember) return null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    actor: actor ? userSummary(actor) : null,
    friendRequestId: row.friendRequestId,
    groupInvitationId: row.groupInvitationId,
    groupId: row.groupId,
    challengeId: row.challengeId,
    encouragementId: row.encouragementId,
    encouragementTemplate,
    encouragementMessage,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

router.get("/social/notifications", asyncRoute(async (req, res): Promise<void> => {
  const parsed = ListSocialNotificationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureUser(req.userId!);
  const conditions = [eq(socialNotificationsTable.recipientUserId, req.userId!)];
  if (parsed.data.unreadOnly) conditions.push(isNull(socialNotificationsTable.readAt));
  if (parsed.data.beforeId !== undefined) conditions.push(lt(socialNotificationsTable.id, parsed.data.beforeId));
  const rows = await db.select().from(socialNotificationsTable).where(and(...conditions))
    .orderBy(desc(socialNotificationsTable.id)).limit(parsed.data.limit * 3);
  const result: NonNullable<VisibleNotification>[] = [];
  for (const row of rows) {
    const visible = await db.transaction((tx) => visibleNotification(tx, row));
    if (visible) result.push(visible);
    if (result.length >= parsed.data.limit) break;
  }
  res.json(ListSocialNotificationsResponse.parse(result));
}));

router.patch(
  "/social/notifications/:notificationId/read",
  asyncRoute(async (req, res): Promise<void> => {
    const params = MarkSocialNotificationReadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await ensureUser(req.userId!);
    const dto = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(socialNotificationsTable).where(and(
        eq(socialNotificationsTable.id, params.data.notificationId),
        eq(socialNotificationsTable.recipientUserId, req.userId!),
      )).for("update").limit(1);
      if (!row || !await visibleNotification(tx, row)) {
        throw new SocialHttpError(404, "Notification not found");
      }
      if (!row.readAt) {
        await tx.update(socialNotificationsTable).set({ readAt: new Date() })
          .where(eq(socialNotificationsTable.id, row.id));
      }
      const [updated] = await tx.select().from(socialNotificationsTable)
        .where(eq(socialNotificationsTable.id, row.id)).limit(1);
      const visible = updated && await visibleNotification(tx, updated);
      if (!visible) throw new SocialHttpError(404, "Notification not found");
      return MarkSocialNotificationReadResponse.parse(visible);
    });
    res.json(dto);
  }),
);

router.patch("/social/notifications/read-all", asyncRoute(async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const unread = await db.select().from(socialNotificationsTable).where(and(
    eq(socialNotificationsTable.recipientUserId, req.userId!),
    isNull(socialNotificationsTable.readAt),
  ));
  const readableIds: number[] = [];
  for (const row of unread) {
    if (await db.transaction((tx) => visibleNotification(tx, row))) readableIds.push(row.id);
  }
  if (readableIds.length) {
    await db.update(socialNotificationsTable).set({ readAt: new Date() }).where(and(
      eq(socialNotificationsTable.recipientUserId, req.userId!),
      inArray(socialNotificationsTable.id, readableIds),
    ));
  }
  res.json(MarkAllSocialNotificationsReadResponse.parse({ updatedCount: readableIds.length }));
}));

export default router;