import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import {
  checkinsTable,
  db,
  groupMembersTable,
  groupReactionsTable,
  groupsTable,
  habitDaysTable,
  habitsTable,
  socialChallengeMembersTable,
  socialChallengesTable,
  socialGroupActivityEventsTable,
  socialGroupInvitationsTable,
  socialGroupJourneySharesTable,
  socialBlocksTable,
  characterItemsTable,
  userCharacterItemsTable,
  usersTable,
  type SocialChallengeHabitTemplate,
} from "@workspace/db";
import { todayInTimezone } from "../lib/dates";
import {
  canViewSocialResource,
  SocialHttpError,
  areAcceptedSocialFriends,
  assertNoSocialBlock,
  insertSocialNotificationOnce,
  lockSocialPair,
} from "./social-common";
import {
  createChallengeHabit,
  validateChallengeHabitPlan,
  type ChallengeHabitOverrides,
  type ChallengeHabitTransaction,
} from "./challengeHabitService";

export type SocialCircleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type GroupRole = "owner" | "member";
type SocialChallengeMember = typeof socialChallengeMembersTable.$inferSelect;
type UserSummary = { id: string; username: string | null; displayName: string; avatarEmoji: string };

export const GROUP_CHEER_EMOJI: Record<string, string> = {
  nice_work: "👏",
  keep_going: "💪",
  great_job: "🎉",
  you_got_this: "✨",
  keep_moving: "🔥",
};

export async function requireSocialGroupMember(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
): Promise<GroupRole> {
  const [membership] = await tx.select({ role: groupMembersTable.role })
    .from(groupMembersTable).where(and(
      eq(groupMembersTable.groupId, groupId),
      eq(groupMembersTable.userId, userId),
    )).for("share").limit(1);
  if (!membership) throw new SocialHttpError(404, "Group not found");
  return membership.role;
}

async function getGroupOr404(tx: SocialCircleTransaction, groupId: number) {
  const [group] = await tx.select().from(groupsTable)
    .where(eq(groupsTable.id, groupId)).limit(1);
  if (!group) throw new SocialHttpError(404, "Group not found");
  return group;
}

async function lockGroup(tx: SocialCircleTransaction, groupId: number): Promise<void> {
  const [group] = await tx.select({ id: groupsTable.id }).from(groupsTable)
    .where(eq(groupsTable.id, groupId)).for("update").limit(1);
  if (!group) throw new SocialHttpError(404, "Group not found");
}

async function lockSocialUsers(
  tx: SocialCircleTransaction,
  userIds: string[],
): Promise<void> {
  const orderedIds = [...new Set(userIds)].sort();
  if (!orderedIds.length) return;
  await tx.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.id, orderedIds))
    .orderBy(usersTable.id)
    // Serialize social writes without blocking notification FK key-share checks.
    .for("no key update");
}

async function areSocialUsersBlocked(
  tx: SocialCircleTransaction,
  userAId: string,
  userBId: string,
): Promise<boolean> {
  if (userAId === userBId) return false;
  const [block] = await tx.select({ id: socialBlocksTable.id })
    .from(socialBlocksTable).where(or(
      and(
        eq(socialBlocksTable.blockerUserId, userAId),
        eq(socialBlocksTable.blockedUserId, userBId),
      ),
      and(
        eq(socialBlocksTable.blockerUserId, userBId),
        eq(socialBlocksTable.blockedUserId, userAId),
      ),
    )).limit(1);
  return Boolean(block);
}

async function getUserSummary(tx: SocialCircleTransaction, userId: string): Promise<UserSummary> {
  const [user] = await tx.select({
    id: usersTable.id,
    username: usersTable.username,
    displayName: usersTable.displayName,
    avatarEmoji: usersTable.avatarEmoji,
  }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new SocialHttpError(404, "User not found");
  return user;
}

function groupSummary(group: Awaited<ReturnType<typeof getGroupOr404>>, memberCount: number, role: GroupRole) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    goalDescription: group.goalDescription,
    privacy: "invite_only" as const,
    memberCount,
    maxMembers: group.maxMembers,
    role,
    coverUrl: group.coverObjectPath ? `/social/groups/${group.id}/cover` : null,
    createdAt: group.createdAt,
  };
}

export async function listSocialGroups(tx: SocialCircleTransaction, userId: string) {
  const memberships = await tx.select({
    groupId: groupMembersTable.groupId,
    role: groupMembersTable.role,
  }).from(groupMembersTable).where(eq(groupMembersTable.userId, userId));
  const result = [];
  for (const membership of memberships) {
    const [group] = await tx.select().from(groupsTable)
      .where(eq(groupsTable.id, membership.groupId)).limit(1);
    if (!group) continue;
    const [count] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(groupMembersTable).where(eq(groupMembersTable.groupId, group.id));
    result.push(groupSummary(group, count?.count ?? 0, membership.role));
  }
  return result;
}

function newInviteCode(): string {
  // Retained only for the legacy schema column; never returned by social APIs.
  return randomBytes(24).toString("hex").toUpperCase();
}

export async function createSocialGroup(
  tx: SocialCircleTransaction,
  userId: string,
  input: { name: string; description?: string; goalDescription?: string; maxMembers: number },
) {
  const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new SocialHttpError(404, "User not found");
  let inviteCode = newInviteCode();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [collision] = await tx.select({ id: groupsTable.id }).from(groupsTable)
      .where(eq(groupsTable.inviteCode, inviteCode)).limit(1);
    if (!collision) break;
    inviteCode = newInviteCode();
  }
  const [group] = await tx.insert(groupsTable).values({
    name: input.name,
    description: input.description ?? null,
    goalDescription: input.goalDescription ?? "",
    maxMembers: input.maxMembers,
    inviteCode,
    startDate: todayInTimezone(user.timezone),
    endDate: null,
    createdBy: userId,
  }).returning();
  if (!group) throw new SocialHttpError(500, "Could not create group");
  const [ownerMembership] = await tx.insert(groupMembersTable)
    .values({ groupId: group.id, userId, role: "owner" })
    .returning({ joinedAt: groupMembersTable.joinedAt });
  await tx.insert(socialGroupActivityEventsTable).values({
    groupId: group.id,
    actorUserId: userId,
    eventType: "member_joined",
    journeyId: null,
    idempotencyKey: `member-joined:${group.id}:${userId}:owner`,
  }).onConflictDoNothing();
  return {
    ...groupSummary(group, 1, "owner"),
    members: [{
      user: await getUserSummary(tx, userId),
      role: "owner" as const,
      joinedAt: ownerMembership?.joinedAt ?? group.createdAt,
      sharedJourneys: [],
    }],
  };
}

async function groupJourneyProgress(
  tx: SocialCircleTransaction,
  viewerUserId: string,
  groupId: number,
  ownerUserId: string,
  habitId: number,
) {
  const [habit] = await tx.select().from(habitsTable).where(and(
    eq(habitsTable.id, habitId),
    eq(habitsTable.userId, ownerUserId),
  )).limit(1);
  if (!habit || habit.journeyStartDate == null || habit.journeyLength !== 22) return null;
  const [membership] = await tx.select({ id: groupMembersTable.id }).from(groupMembersTable)
    .where(and(
      eq(groupMembersTable.groupId, groupId),
      eq(groupMembersTable.userId, viewerUserId),
    )).limit(1);
  if (!membership) return null;
  const [share] = await tx.select({ id: socialGroupJourneySharesTable.id })
    .from(socialGroupJourneySharesTable).where(and(
      eq(socialGroupJourneySharesTable.groupId, groupId),
      eq(socialGroupJourneySharesTable.userId, ownerUserId),
      eq(socialGroupJourneySharesTable.habitId, habitId),
    )).limit(1);
  if (!share) return null;
  if (viewerUserId !== ownerUserId) {
    await assertNoSocialBlock(tx, viewerUserId, ownerUserId);
  }

  const [owner] = await tx.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, ownerUserId)).limit(1);
  if (!owner) return null;
  const today = todayInTimezone(owner.timezone);
  const savedDays = await tx.select({
    date: habitDaysTable.date,
    scheduled: habitDaysTable.scheduled,
  }).from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id));
  const windowDays = savedDays.filter((day) =>
    day.date >= habit.journeyStartDate! && day.date < addDay(habit.journeyStartDate!, 22),
  );
  if (windowDays.length !== 22) return null;
  const eligibleDays = windowDays.filter((day) => day.scheduled && day.date <= today);
  const successful = eligibleDays.length
    ? await tx.select({ date: checkinsTable.date }).from(checkinsTable).where(and(
      eq(checkinsTable.habitId, habit.id),
      eq(checkinsTable.completed, true),
      inArray(checkinsTable.date, eligibleDays.map((day) => day.date)),
    ))
    : [];
  const successCount = successful.length;
  const scheduledCount = windowDays.filter((day) => day.scheduled).length;
  const allScheduledSucceeded = scheduledCount > 0
    && windowDays.filter((day) => day.scheduled)
      .every((day) => successful.some((item) => item.date === day.date));
  const progressDay = Math.max(0, Math.min(22,
    today < habit.journeyStartDate ? 0 : Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${habit.journeyStartDate}T00:00:00Z`)) / 86_400_000,
    ) + 1,
  ));
  return {
    journeyId: habit.id,
    title: habit.title,
    emoji: habit.emoji,
    progressDay,
    journeyLength: 22 as const,
    successfulDayCount: successCount,
    completed: habit.journeyCompletedAt != null || allScheduledSucceeded,
  };
}

function addDay(date: string, count: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

export async function getSocialGroup(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
) {
  const role = await requireSocialGroupMember(tx, groupId, userId);
  const group = await getGroupOr404(tx, groupId);
  const rows = await tx.select({
    userId: groupMembersTable.userId,
    role: groupMembersTable.role,
    joinedAt: groupMembersTable.joinedAt,
  }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId))
    .orderBy(asc(groupMembersTable.joinedAt)).for("share");
  const count = rows.length;
  const members = [];
  for (const row of rows) {
    let blocked = false;
    if (row.userId !== userId) {
      try {
        await assertNoSocialBlock(tx, userId, row.userId);
      } catch {
        blocked = true;
      }
    }
    if (blocked) continue;
    const shares = await tx.select({ habitId: socialGroupJourneySharesTable.habitId })
      .from(socialGroupJourneySharesTable).where(and(
        eq(socialGroupJourneySharesTable.groupId, groupId),
        eq(socialGroupJourneySharesTable.userId, row.userId),
      ));
    const sharedJourneys = [];
    for (const share of shares) {
      const progress = await groupJourneyProgress(tx, userId, groupId, row.userId, share.habitId);
      if (progress) sharedJourneys.push(progress);
    }
    members.push({
      user: await getUserSummary(tx, row.userId),
      role: row.role,
      joinedAt: row.joinedAt,
      sharedJourneys,
    });
  }
  return { ...groupSummary(group, count, role), members };
}

export async function inviteUsersToSocialGroup(
  tx: SocialCircleTransaction,
  groupId: number,
  inviterUserId: string,
  inviteeUserIds: string[],
) {
  const uniqueInvitees = [...new Set(inviteeUserIds)];
  if (uniqueInvitees.includes(inviterUserId)) throw new SocialHttpError(400, "You cannot invite yourself");
  await lockSocialUsers(tx, [inviterUserId, ...uniqueInvitees]);
  const [group] = await tx.select().from(groupsTable).where(eq(groupsTable.id, groupId))
    .for("update").limit(1);
  if (!group) throw new SocialHttpError(404, "Group not found");
  await requireSocialGroupMember(tx, groupId, inviterUserId);
  const [memberCountRow] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  const [pendingCountRow] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(socialGroupInvitationsTable).where(and(
      eq(socialGroupInvitationsTable.groupId, groupId),
      eq(socialGroupInvitationsTable.status, "pending"),
    ));
  const membershipByUser = new Set((await tx.select({ userId: groupMembersTable.userId })
    .from(groupMembersTable).where(and(
      eq(groupMembersTable.groupId, groupId),
      inArray(groupMembersTable.userId, uniqueInvitees),
    ))).map((row) => row.userId));
  const pendingByUser = new Set((await tx.select({ userId: socialGroupInvitationsTable.inviteeUserId })
    .from(socialGroupInvitationsTable).where(and(
      eq(socialGroupInvitationsTable.groupId, groupId),
      eq(socialGroupInvitationsTable.status, "pending"),
      inArray(socialGroupInvitationsTable.inviteeUserId, uniqueInvitees),
    ))).map((row) => row.userId));
  const candidates = uniqueInvitees.filter((id) => !membershipByUser.has(id) && !pendingByUser.has(id));
  if ((memberCountRow?.count ?? 0) + (pendingCountRow?.count ?? 0) + candidates.length > group.maxMembers) {
    throw new SocialHttpError(409, "Group member limit would be exceeded");
  }
  const result = [];
  for (const inviteeUserId of uniqueInvitees) {
    if (membershipByUser.has(inviteeUserId)) throw new SocialHttpError(409, "That user is already a group member");
    if (await areSocialUsersBlocked(tx, inviterUserId, inviteeUserId)) {
      throw new SocialHttpError(404, "Social resource not found");
    }
    if (!await areAcceptedSocialFriends(tx, inviterUserId, inviteeUserId)) {
      throw new SocialHttpError(403, "Group invitations are limited to accepted friends");
    }
    const [invitee] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, inviteeUserId)).limit(1);
    if (!invitee) throw new SocialHttpError(404, "Invitee not found");
    let [invitation] = await tx.insert(socialGroupInvitationsTable).values({
      groupId,
      inviterUserId,
      inviteeUserId,
    }).onConflictDoNothing().returning();
    if (!invitation) {
      [invitation] = await tx.select().from(socialGroupInvitationsTable).where(and(
        eq(socialGroupInvitationsTable.groupId, groupId),
        eq(socialGroupInvitationsTable.inviteeUserId, inviteeUserId),
        eq(socialGroupInvitationsTable.status, "pending"),
      )).limit(1);
    }
    if (!invitation) continue;
    if (invitation.inviterUserId !== inviterUserId) {
      throw new SocialHttpError(409, "That user already has a pending group invitation");
    }
    await insertSocialNotificationOnce(tx, {
      recipientUserId: inviteeUserId,
      actorUserId: inviterUserId,
      type: "group_invitation",
      eventKey: `group-invitation:${invitation.id}`,
      groupInvitationId: invitation.id,
      groupId,
      safeData: { groupName: group.name },
    });
    result.push({
      ...invitation,
      groupName: group.name,
      inviter: await getUserSummary(tx, inviterUserId),
      invitee: await getUserSummary(tx, inviteeUserId),
    });
  }
  return result;
}

export async function listIncomingSocialGroupInvitations(
  tx: SocialCircleTransaction,
  userId: string,
) {
  const invitations = await tx.select().from(socialGroupInvitationsTable).where(and(
    eq(socialGroupInvitationsTable.inviteeUserId, userId),
    eq(socialGroupInvitationsTable.status, "pending"),
  )).orderBy(desc(socialGroupInvitationsTable.createdAt));
  const result = [];
  for (const invitation of invitations) {
    const [group] = await tx.select().from(groupsTable)
      .where(eq(groupsTable.id, invitation.groupId)).limit(1);
    const [member] = await tx.select({ id: groupMembersTable.id }).from(groupMembersTable)
      .where(and(
        eq(groupMembersTable.groupId, invitation.groupId),
        eq(groupMembersTable.userId, invitation.inviterUserId),
      )).limit(1);
    if (!group || !member) continue;
    try {
      await assertNoSocialBlock(tx, userId, invitation.inviterUserId);
    } catch {
      continue;
    }
    result.push({
      ...invitation,
      groupName: group.name,
      inviter: await getUserSummary(tx, invitation.inviterUserId),
      invitee: await getUserSummary(tx, userId),
    });
  }
  return result;
}

export async function respondToSocialGroupInvitation(
  tx: SocialCircleTransaction,
  invitationId: number,
  userId: string,
  decision: "accept" | "decline",
) {
  const [invitationSnapshot] = await tx.select().from(socialGroupInvitationsTable)
    .where(and(
      eq(socialGroupInvitationsTable.id, invitationId),
      eq(socialGroupInvitationsTable.inviteeUserId, userId),
    )).limit(1);
  if (!invitationSnapshot) throw new SocialHttpError(404, "Invitation not found");
  await lockSocialUsers(tx, [userId, invitationSnapshot.inviterUserId]);
  const [group] = await tx.select().from(groupsTable)
    .where(eq(groupsTable.id, invitationSnapshot.groupId)).for("update").limit(1);
  if (!group) throw new SocialHttpError(404, "Group not found");
  const [invitation] = await tx.select().from(socialGroupInvitationsTable)
    .where(and(
      eq(socialGroupInvitationsTable.id, invitationId),
      eq(socialGroupInvitationsTable.inviteeUserId, userId),
    )).for("update").limit(1);
  if (!invitation) throw new SocialHttpError(404, "Invitation not found");
  if (invitation.groupId !== invitationSnapshot.groupId
    || invitation.inviterUserId !== invitationSnapshot.inviterUserId) {
    throw new SocialHttpError(409, "Invitation changed while responding");
  }
  const [inviterMembership] = await tx.select({ id: groupMembersTable.id })
    .from(groupMembersTable).where(and(
      eq(groupMembersTable.groupId, group.id),
      eq(groupMembersTable.userId, invitation.inviterUserId),
    )).limit(1);
  if (!inviterMembership) throw new SocialHttpError(404, "Invitation not found");
  if (await areSocialUsersBlocked(tx, userId, invitation.inviterUserId)) {
    throw new SocialHttpError(404, "Social resource not found");
  }
  const [existingMembership] = await tx.select({ id: groupMembersTable.id })
    .from(groupMembersTable).where(and(
      eq(groupMembersTable.groupId, group.id),
      eq(groupMembersTable.userId, userId),
    )).limit(1);
  if (invitation.status === "accepted" && existingMembership) {
    return {
      ...invitation,
      groupName: group.name,
      inviter: await getUserSummary(tx, invitation.inviterUserId),
      invitee: await getUserSummary(tx, userId),
    };
  }
  if (invitation.status !== "pending") throw new SocialHttpError(409, "Invitation is no longer pending");
  if (!await areAcceptedSocialFriends(tx, userId, invitation.inviterUserId)) {
    throw new SocialHttpError(403, "This invitation is no longer available");
  }
  if (decision === "accept") {
    const [count] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(groupMembersTable).where(eq(groupMembersTable.groupId, group.id));
    if (!existingMembership && (count?.count ?? 0) >= group.maxMembers) {
      throw new SocialHttpError(409, "Group is full");
    }
    await tx.insert(groupMembersTable).values({
      groupId: group.id,
      userId,
      role: "member",
    }).onConflictDoNothing();
    await tx.insert(socialGroupActivityEventsTable).values({
      groupId: group.id,
      actorUserId: userId,
      eventType: "member_joined",
      journeyId: null,
      idempotencyKey: `member-joined:${group.id}:${userId}:${invitation.id}`,
    }).onConflictDoNothing();
    const members = await tx.select({ userId: groupMembersTable.userId })
      .from(groupMembersTable).where(eq(groupMembersTable.groupId, group.id));
    for (const member of members) {
      if (member.userId === userId) continue;
      if (await areSocialUsersBlocked(tx, member.userId, userId)) continue;
      await insertSocialNotificationOnce(tx, {
        recipientUserId: member.userId,
        actorUserId: userId,
        type: "group_member_joined",
        eventKey: `group-member-joined:${group.id}:${userId}:${invitation.id}`,
        groupId: group.id,
      });
    }
  }
  const [updated] = await tx.update(socialGroupInvitationsTable).set({
    status: decision === "accept" ? "accepted" : "declined",
    respondedAt: new Date(),
  }).where(and(
    eq(socialGroupInvitationsTable.id, invitationId),
    eq(socialGroupInvitationsTable.status, "pending"),
  )).returning();
  const response = updated ?? invitation;
  return {
    ...response,
    groupName: group.name,
    inviter: await getUserSummary(tx, invitation.inviterUserId),
    invitee: await getUserSummary(tx, userId),
  };
}

export async function leaveSocialGroup(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
): Promise<void> {
  const [group] = await tx.select().from(groupsTable).where(eq(groupsTable.id, groupId))
    .for("update").limit(1);
  if (!group) throw new SocialHttpError(404, "Group not found");
  const [membership] = await tx.select().from(groupMembersTable).where(and(
    eq(groupMembersTable.groupId, groupId),
    eq(groupMembersTable.userId, userId),
  )).for("update").limit(1);
  if (!membership) throw new SocialHttpError(404, "Group not found");
  const members = await tx.select().from(groupMembersTable)
    .where(eq(groupMembersTable.groupId, groupId));
  if (membership.role === "owner" && members.length === 1) {
    await tx.delete(groupsTable).where(eq(groupsTable.id, groupId));
    return;
  }
  await tx.delete(socialGroupJourneySharesTable).where(and(
    eq(socialGroupJourneySharesTable.groupId, groupId),
    eq(socialGroupJourneySharesTable.userId, userId),
  ));
  await tx.delete(socialGroupInvitationsTable).where(and(
    eq(socialGroupInvitationsTable.groupId, groupId),
    eq(socialGroupInvitationsTable.inviterUserId, userId),
    eq(socialGroupInvitationsTable.status, "pending"),
  ));
  await tx.delete(groupMembersTable).where(and(
    eq(groupMembersTable.groupId, groupId),
    eq(groupMembersTable.userId, userId),
  ));
  if (membership.role === "owner") {
    const [nextOwner] = await tx.select({ userId: groupMembersTable.userId })
      .from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId))
      .orderBy(asc(groupMembersTable.joinedAt)).limit(1);
    if (nextOwner) {
      await tx.update(groupMembersTable).set({ role: "owner" }).where(and(
        eq(groupMembersTable.groupId, groupId),
        eq(groupMembersTable.userId, nextOwner.userId),
      ));
    }
  }
}

export async function listMyGroupJourneyShares(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
) {
  await requireSocialGroupMember(tx, groupId, userId);
  const shares = await tx.select({ habitId: socialGroupJourneySharesTable.habitId })
    .from(socialGroupJourneySharesTable).where(and(
      eq(socialGroupJourneySharesTable.groupId, groupId),
      eq(socialGroupJourneySharesTable.userId, userId),
    ));
  const result = [];
  for (const share of shares) {
    const progress = await groupJourneyProgress(tx, userId, groupId, userId, share.habitId);
    if (progress) result.push({ groupId, journey: progress });
  }
  return result;
}

export async function shareMyJourneyWithGroup(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
  habitId: number,
) {
  await lockGroup(tx, groupId);
  await requireSocialGroupMember(tx, groupId, userId);
  const [habit] = await tx.select({
    id: habitsTable.id,
    journeyStartDate: habitsTable.journeyStartDate,
  }).from(habitsTable).where(and(
    eq(habitsTable.id, habitId),
    eq(habitsTable.userId, userId),
    eq(habitsTable.journeyLength, 22),
  )).limit(1);
  if (!habit || habit.journeyStartDate == null) {
    throw new SocialHttpError(404, "Owned 22-day journey not found");
  }
  const savedDays = await tx.select({ date: habitDaysTable.date }).from(habitDaysTable)
    .where(eq(habitDaysTable.habitId, habitId));
  const validDays = savedDays.filter((day) => day.date >= habit.journeyStartDate!
    && day.date < addDay(habit.journeyStartDate!, 22));
  if (validDays.length !== 22) throw new SocialHttpError(409, "Journey plan snapshots are incomplete");
  await tx.insert(socialGroupJourneySharesTable).values({
    groupId,
    userId,
    habitId,
  }).onConflictDoNothing();
  const journey = await groupJourneyProgress(tx, userId, groupId, userId, habitId);
  if (!journey) throw new SocialHttpError(409, "Journey progress is unavailable");
  return { groupId, journey };
}

export async function revokeMyJourneyShare(
  tx: SocialCircleTransaction,
  groupId: number,
  habitId: number,
  userId: string,
): Promise<void> {
  await lockGroup(tx, groupId);
  await requireSocialGroupMember(tx, groupId, userId);
  await tx.delete(socialGroupJourneySharesTable).where(and(
    eq(socialGroupJourneySharesTable.groupId, groupId),
    eq(socialGroupJourneySharesTable.userId, userId),
    eq(socialGroupJourneySharesTable.habitId, habitId),
  ));
}

export async function listSocialGroupActivity(
  tx: SocialCircleTransaction,
  groupId: number,
  viewerUserId: string,
) {
  await requireSocialGroupMember(tx, groupId, viewerUserId);
  const events = await tx.select().from(socialGroupActivityEventsTable)
    .where(eq(socialGroupActivityEventsTable.groupId, groupId))
    .orderBy(desc(socialGroupActivityEventsTable.createdAt))
    .limit(100);
  const result = [];
  for (const event of events) {
    if (await areSocialUsersBlocked(tx, viewerUserId, event.actorUserId)) continue;
    const [isMember] = await tx.select({ id: groupMembersTable.id })
      .from(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, groupId),
        eq(groupMembersTable.userId, event.actorUserId),
      )).for("share").limit(1);
    if (!isMember) continue;
    const actor = await getUserSummary(tx, event.actorUserId);
    if (event.eventType === "member_joined" || event.journeyId == null) {
      result.push({
        id: event.id,
        actor,
        eventType: event.eventType,
        journey: null,
        progressDay: null,
        createdAt: event.createdAt,
      });
      continue;
    }
    const journey = await groupJourneyProgress(
      tx, viewerUserId, groupId, event.actorUserId, event.journeyId,
    );
    if (!journey) continue;
    result.push({
      id: event.id,
      actor,
      eventType: event.eventType,
      journey,
      progressDay: journey.progressDay,
      createdAt: event.createdAt,
    });
  }
  return result;
}

export async function recordSocialGroupActivityOnce(
  tx: SocialCircleTransaction,
  input: {
    groupId: number;
    actorUserId: string;
    eventType: "member_joined" | "successful_day" | "milestone" | "journey_completed";
    journeyId?: number;
    idempotencyKey: string;
  },
) {
  await lockGroup(tx, input.groupId);
  await requireSocialGroupMember(tx, input.groupId, input.actorUserId);
  if (input.eventType !== "member_joined") {
    if (input.journeyId == null) throw new SocialHttpError(400, "Positive progress events require a journey");
    const [share] = await tx.select({ id: socialGroupJourneySharesTable.id })
      .from(socialGroupJourneySharesTable).where(and(
        eq(socialGroupJourneySharesTable.groupId, input.groupId),
        eq(socialGroupJourneySharesTable.userId, input.actorUserId),
        eq(socialGroupJourneySharesTable.habitId, input.journeyId),
      )).limit(1);
    const [habit] = await tx.select({ id: habitsTable.id }).from(habitsTable).where(and(
      eq(habitsTable.id, input.journeyId),
      eq(habitsTable.userId, input.actorUserId),
    )).limit(1);
    if (!share || !habit) throw new SocialHttpError(403, "Journey is not shared with this group");
  }
  const [inserted] = await tx.insert(socialGroupActivityEventsTable).values({
    ...input,
    journeyId: input.journeyId ?? null,
  }).onConflictDoNothing().returning({ id: socialGroupActivityEventsTable.id });
  if (!inserted || input.eventType === "member_joined" || input.eventType === "successful_day") return;
  const members = await tx.select({ userId: groupMembersTable.userId })
    .from(groupMembersTable).where(eq(groupMembersTable.groupId, input.groupId));
  for (const member of members) {
    if (member.userId === input.actorUserId) continue;
    if (await areSocialUsersBlocked(tx, member.userId, input.actorUserId)) continue;
    await insertSocialNotificationOnce(tx, {
      recipientUserId: member.userId,
      actorUserId: input.actorUserId,
      type: "group_milestone",
      eventKey: `group-progress:${input.groupId}:${input.idempotencyKey}`,
      groupId: input.groupId,
      safeData: { eventType: input.eventType },
    });
  }
}

/**
 * Fans a just-created positive journey event out to the groups that had an
 * active explicit share at event time. Check-in callers must invoke this in
 * the same transaction as the check-in; this deliberately does not scan past
 * check-ins or backfill a newly created share.
 */
export async function recordSharedGroupActivityOnce(
  tx: SocialCircleTransaction,
  input: {
    actorUserId: string;
    journeyId: number;
    eventType: "successful_day" | "milestone" | "journey_completed";
    idempotencyKey: string;
  },
): Promise<void> {
  const shares = await tx.select({ groupId: socialGroupJourneySharesTable.groupId })
    .from(socialGroupJourneySharesTable).where(and(
      eq(socialGroupJourneySharesTable.userId, input.actorUserId),
      eq(socialGroupJourneySharesTable.habitId, input.journeyId),
    )).orderBy(asc(socialGroupJourneySharesTable.groupId));
  for (const share of shares) {
    try {
      await recordSocialGroupActivityOnce(tx, {
        groupId: share.groupId,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        journeyId: input.journeyId,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      // A concurrent leave/revoke can invalidate a share after the fanout
      // candidate query. It must not roll back the user's check-in.
      if (error instanceof SocialHttpError && (error.status === 403 || error.status === 404)) {
        continue;
      }
      throw error;
    }
  }
}

export async function listSocialGroupEncouragements(
  tx: SocialCircleTransaction,
  groupId: number,
  viewerUserId: string,
) {
  await requireSocialGroupMember(tx, groupId, viewerUserId);
  const reactions = await tx.select().from(groupReactionsTable)
    .where(eq(groupReactionsTable.groupId, groupId))
    .orderBy(desc(groupReactionsTable.createdAt)).limit(100);
  const result = [];
  for (const reaction of reactions) {
    const [senderMember] = await tx.select({ id: groupMembersTable.id })
      .from(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, groupId),
        eq(groupMembersTable.userId, reaction.fromUserId),
      )).for("share").limit(1);
    if (!senderMember) continue;
    try {
      await assertNoSocialBlock(tx, viewerUserId, reaction.fromUserId);
      if (reaction.toUserId) await assertNoSocialBlock(tx, viewerUserId, reaction.toUserId);
    } catch {
      continue;
    }
    let receiver = null;
    if (reaction.toUserId) {
      const [receiverMember] = await tx.select({ id: groupMembersTable.id })
        .from(groupMembersTable).where(and(
          eq(groupMembersTable.groupId, groupId),
          eq(groupMembersTable.userId, reaction.toUserId),
        )).for("share").limit(1);
      if (!receiverMember) continue;
      receiver = await getUserSummary(tx, reaction.toUserId);
    }
    result.push({
      id: reaction.id,
      groupId,
      sender: await getUserSummary(tx, reaction.fromUserId),
      receiver,
      emoji: reaction.emoji,
      template: reaction.templateCode,
      message: reaction.message,
      createdAt: reaction.createdAt,
    });
  }
  return result;
}

export async function createSocialGroupEncouragement(
  tx: SocialCircleTransaction,
  groupId: number,
  senderUserId: string,
  input: { receiverUserId?: string; template: keyof typeof GROUP_CHEER_EMOJI; message?: string; requestId: string },
) {
  const [previousSnapshot] = await tx.select({
    groupId: groupReactionsTable.groupId,
    toUserId: groupReactionsTable.toUserId,
  }).from(groupReactionsTable).where(and(
    eq(groupReactionsTable.fromUserId, senderUserId),
    eq(groupReactionsTable.requestId, input.requestId),
  )).limit(1);
  await lockSocialUsers(tx, [
    senderUserId,
    ...(input.receiverUserId ? [input.receiverUserId] : []),
    ...(previousSnapshot?.toUserId ? [previousSnapshot.toUserId] : []),
  ]);
  await lockGroup(tx, groupId);
  await requireSocialGroupMember(tx, groupId, senderUserId);
  const [previous] = await tx.select().from(groupReactionsTable).where(and(
    eq(groupReactionsTable.fromUserId, senderUserId),
    eq(groupReactionsTable.requestId, input.requestId),
  )).limit(1);
  if (previous) {
    if (previous.groupId !== groupId || previous.toUserId !== (input.receiverUserId ?? null)) {
      throw new SocialHttpError(409, "Request ID was already used");
    }
    if (previous.toUserId) {
      await requireSocialGroupMember(tx, groupId, previous.toUserId);
      if (await areSocialUsersBlocked(tx, senderUserId, previous.toUserId)) {
        throw new SocialHttpError(404, "Social resource not found");
      }
    }
    return reactionDto(tx, previous);
  }
  if (input.receiverUserId) {
    if (input.receiverUserId === senderUserId) throw new SocialHttpError(400, "You cannot encourage yourself");
    await requireSocialGroupMember(tx, groupId, input.receiverUserId);
    if (await areSocialUsersBlocked(tx, senderUserId, input.receiverUserId)) {
      throw new SocialHttpError(404, "Social resource not found");
    }
  }
  const currentMinute = new Date();
  currentMinute.setUTCSeconds(0, 0);
  const [reaction] = await tx.insert(groupReactionsTable).values({
    groupId,
    fromUserId: senderUserId,
    toUserId: input.receiverUserId ?? null,
    emoji: GROUP_CHEER_EMOJI[input.template],
    templateCode: input.template,
    message: input.message ?? null,
    requestId: input.requestId,
    cooldownBucket: currentMinute,
  }).onConflictDoNothing().returning();
  if (!reaction) {
    const [sameRequest] = await tx.select().from(groupReactionsTable).where(and(
      eq(groupReactionsTable.fromUserId, senderUserId),
      eq(groupReactionsTable.requestId, input.requestId),
    )).limit(1);
    if (sameRequest?.groupId === groupId) return reactionDto(tx, sameRequest);
    throw new SocialHttpError(409, "Please wait before sending another encouragement");
  }
  const recipientIds = input.receiverUserId
    ? [input.receiverUserId]
    : (await tx.select({ userId: groupMembersTable.userId }).from(groupMembersTable)
      .where(eq(groupMembersTable.groupId, groupId)))
      .map((member) => member.userId)
      .filter((memberId) => memberId !== senderUserId);
  for (const recipientUserId of recipientIds) {
    if (await areSocialUsersBlocked(tx, senderUserId, recipientUserId)) continue;
    await insertSocialNotificationOnce(tx, {
      recipientUserId,
      actorUserId: senderUserId,
      type: "encouragement_received",
      eventKey: `group-encouragement:${reaction.id}`,
      groupId,
      safeData: { groupReactionId: reaction.id },
    });
  }
  return reactionDto(tx, reaction);
}

export async function createLegacyGroupReactionWithCooldown(
  tx: SocialCircleTransaction,
  input: {
    groupId: number;
    senderUserId: string;
    receiverUserId?: string;
    emoji: string;
  },
) {
  await lockSocialUsers(tx, [
    input.senderUserId,
    ...(input.receiverUserId ? [input.receiverUserId] : []),
  ]);
  await lockGroup(tx, input.groupId);
  await requireSocialGroupMember(tx, input.groupId, input.senderUserId);
  if (input.receiverUserId) {
    if (input.receiverUserId === input.senderUserId) {
      throw new SocialHttpError(400, "You cannot encourage yourself");
    }
    await requireSocialGroupMember(tx, input.groupId, input.receiverUserId);
    if (await areSocialUsersBlocked(tx, input.senderUserId, input.receiverUserId)) {
      throw new SocialHttpError(404, "Social resource not found");
    }
  }
  const cooldownBucket = new Date();
  cooldownBucket.setUTCSeconds(0, 0);
  const [reaction] = await tx.insert(groupReactionsTable).values({
    groupId: input.groupId,
    fromUserId: input.senderUserId,
    toUserId: input.receiverUserId ?? null,
    emoji: input.emoji,
    templateCode: null,
    message: null,
    requestId: randomUUID(),
    cooldownBucket,
  }).onConflictDoNothing().returning();
  if (!reaction) {
    throw new SocialHttpError(409, "Please wait before sending another reaction");
  }
  return reaction;
}

async function reactionDto(tx: SocialCircleTransaction, reaction: typeof groupReactionsTable.$inferSelect) {
  return {
    id: reaction.id,
    groupId: reaction.groupId,
    sender: await getUserSummary(tx, reaction.fromUserId),
    receiver: reaction.toUserId ? await getUserSummary(tx, reaction.toUserId) : null,
    emoji: reaction.emoji,
    template: reaction.templateCode,
    message: reaction.message,
    createdAt: reaction.createdAt,
  };
}

export async function requireGroupOwner(tx: SocialCircleTransaction, groupId: number, userId: string) {
  const role = await requireSocialGroupMember(tx, groupId, userId);
  if (role !== "owner") throw new SocialHttpError(403, "Only the group owner can change its cover");
}

export async function getGroupCoverObjectPath(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
): Promise<string> {
  await requireSocialGroupMember(tx, groupId, userId);
  const group = await getGroupOr404(tx, groupId);
  if (!group.coverObjectPath) throw new SocialHttpError(404, "Group cover not found");
  return group.coverObjectPath;
}

export async function updateGroupCover(
  tx: SocialCircleTransaction,
  groupId: number,
  userId: string,
  coverObjectPath: string | null,
) {
  await lockGroup(tx, groupId);
  await requireGroupOwner(tx, groupId, userId);
  const [group] = await tx.update(groupsTable).set({
    coverObjectPath,
    coverUpdatedAt: coverObjectPath ? new Date() : null,
  }).where(eq(groupsTable.id, groupId)).returning({ id: groupsTable.id });
  if (!group) throw new SocialHttpError(404, "Group not found");
  return { imageUrl: coverObjectPath ? `/social/groups/${groupId}/cover` : null };
}

function challengeTemplate(habit: typeof habitsTable.$inferSelect): SocialChallengeHabitTemplate {
  const executionType = habit.executionType ?? (habit.goalType === "quit"
    ? "limit"
    : habit.unit === "minutes" ? "duration" : "count");
  if ((habit.goalType === "quit" && executionType !== "limit")
    || (habit.goalType === "build" && executionType === "limit")) {
    throw new SocialHttpError(400, "This habit has an incompatible execution type");
  }
  return {
    title: habit.title,
    emoji: habit.emoji,
    category: habit.category,
    cadence: habit.cadence,
    customDays: habit.cadence === "custom_days" ? habit.customDays : null,
    unit: habit.unit,
    executionType,
    goalType: habit.goalType,
    difficulty: "easy",
    suggestedTargetValue: habit.targetValue,
    suggestedMinimumValue: habit.minimumValue ?? habit.targetValue,
  };
}

async function challengeSummary(
  tx: SocialCircleTransaction,
  challenge: typeof socialChallengesTable.$inferSelect,
  userId: string,
  member: SocialChallengeMember,
) {
  const creator = await getUserSummary(tx, challenge.creatorUserId);
  const [acceptedCount] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(socialChallengeMembersTable).where(and(
      eq(socialChallengeMembersTable.challengeId, challenge.id),
      eq(socialChallengeMembersTable.status, "accepted"),
    ));
  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    durationDays: 22 as const,
    template: challenge.habitTemplate,
    creator,
    myStatus: member.status,
    memberCount: Math.max(1, acceptedCount?.count ?? 0),
    createdAt: challenge.createdAt,
  };
}

export async function listSocialChallenges(tx: SocialCircleTransaction, userId: string) {
  const memberships = await tx.select().from(socialChallengeMembersTable)
    .where(eq(socialChallengeMembersTable.userId, userId));
  const result = [];
  for (const membership of memberships) {
    const [challenge] = await tx.select().from(socialChallengesTable)
      .where(eq(socialChallengesTable.id, membership.challengeId)).limit(1);
    if (!challenge) continue;
    try {
      await assertNoSocialBlock(tx, userId, challenge.creatorUserId);
    } catch {
      continue;
    }
    result.push(await challengeSummary(tx, challenge, userId, membership));
  }
  return result;
}

export async function createSocialChallenge(
  tx: SocialCircleTransaction,
  userId: string,
  sourceHabitId: number,
  title?: string,
  description?: string,
) {
  const [sourceHabit] = await tx.select().from(habitsTable).where(and(
    eq(habitsTable.id, sourceHabitId),
    eq(habitsTable.userId, userId),
  )).limit(1);
  if (!sourceHabit || sourceHabit.journeyStartDate == null || sourceHabit.journeyLength !== 22) {
    throw new SocialHttpError(404, "Owned 22-day journey not found");
  }
  const sourceDays = await tx.select({ date: habitDaysTable.date })
    .from(habitDaysTable).where(eq(habitDaysTable.habitId, sourceHabitId));
  if (sourceDays.filter((day) => day.date >= sourceHabit.journeyStartDate!
    && day.date < addDay(sourceHabit.journeyStartDate!, 22)).length !== 22) {
    throw new SocialHttpError(409, "Journey plan snapshots are incomplete");
  }
  const [creator] = await tx.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!creator) throw new SocialHttpError(404, "User not found");
  const template = challengeTemplate(sourceHabit);
  validateChallengeHabitPlan(template, {});
  const [challenge] = await tx.insert(socialChallengesTable).values({
    creatorUserId: userId,
    sourceHabitId,
    title: title ?? sourceHabit.title,
    description: description ?? null,
    durationDays: 22,
    habitTemplate: template,
    status: "active",
  }).returning();
  if (!challenge) throw new SocialHttpError(500, "Could not create challenge");
  const [member] = await tx.insert(socialChallengeMembersTable).values({
    challengeId: challenge.id,
    userId,
    habitId: sourceHabitId,
    status: "accepted",
    targetValueSnapshot: sourceHabit.targetValue,
    minimumValueSnapshot: sourceHabit.minimumValue ?? sourceHabit.targetValue,
    cadenceSnapshot: sourceHabit.cadence,
    customDaysSnapshot: sourceHabit.cadence === "custom_days" ? sourceHabit.customDays : null,
    timezoneSnapshot: creator.timezone,
    journeyStartDate: sourceHabit.journeyStartDate,
    acceptedAt: new Date(),
  }).returning();
  if (!member) throw new SocialHttpError(500, "Could not link source journey to challenge");
  return {
    ...(await challengeSummary(tx, challenge, userId, member)),
    members: [await challengeMemberDto(tx, member, userId)],
  };
}

async function challengeProgress(tx: SocialCircleTransaction, member: SocialChallengeMember) {
  if (member.status !== "accepted" || member.habitId == null || member.journeyStartDate == null) return null;
  const [habit] = await tx.select().from(habitsTable).where(and(
    eq(habitsTable.id, member.habitId),
    eq(habitsTable.userId, member.userId),
  )).limit(1);
  const [user] = await tx.select({ timezone: usersTable.timezone }).from(usersTable)
    .where(eq(usersTable.id, member.userId)).limit(1);
  if (!habit || !user) return null;
  const savedDays = await tx.select({
    date: habitDaysTable.date,
    scheduled: habitDaysTable.scheduled,
  }).from(habitDaysTable).where(eq(habitDaysTable.habitId, habit.id));
  const windowDays = savedDays.filter((day) => day.date >= member.journeyStartDate!
    && day.date < addDay(member.journeyStartDate!, 22));
  if (windowDays.length !== 22) return null;
  const today = todayInTimezone(user.timezone);
  const eligibleDays = windowDays.filter((day) => day.date <= today);
  const successfulDates = eligibleDays.length
    ? await tx.select({ date: checkinsTable.date }).from(checkinsTable).where(and(
      eq(checkinsTable.habitId, habit.id),
      eq(checkinsTable.userId, member.userId),
      eq(checkinsTable.completed, true),
      inArray(checkinsTable.date, eligibleDays.map((day) => day.date)),
    ))
    : [];
  const successfulDateSet = new Set(successfulDates.map((checkin) => checkin.date));
  const elapsedScheduledDays = windowDays.filter((day) => day.date <= today && day.scheduled);
  const completedScheduledDays = elapsedScheduledDays.filter((day) => successfulDateSet.has(day.date)).length;
  const scheduledCount = windowDays.filter((day) => day.scheduled).length;
  const progressDay = Math.max(0, Math.min(22,
    today < member.journeyStartDate ? 0 : Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${member.journeyStartDate}T00:00:00Z`)) / 86_400_000,
    ) + 1,
  ));
  return {
    journeyId: habit.id,
    progressDay,
    journeyLength: 22 as const,
    consistencyPercentage: elapsedScheduledDays.length === 0
      ? null
      : completedScheduledDays / elapsedScheduledDays.length * 100,
    completed: habit.journeyCompletedAt != null
      || (scheduledCount > 0 && completedScheduledDays === scheduledCount),
  };
}

async function challengeCharacter(
  tx: SocialCircleTransaction,
  viewerUserId: string,
  ownerUserId: string,
) {
  if (!await canViewSocialResource(tx, {
    viewerUserId,
    ownerUserId,
    resourceType: "character",
    resourceId: "profile",
  })) return [];
  return tx.select({
    slot: characterItemsTable.slot,
    name: characterItemsTable.name,
    emoji: characterItemsTable.emoji,
  }).from(userCharacterItemsTable).innerJoin(
    characterItemsTable,
    eq(characterItemsTable.id, userCharacterItemsTable.itemId),
  ).where(and(
    eq(userCharacterItemsTable.userId, ownerUserId),
    eq(userCharacterItemsTable.equipped, true),
  )).orderBy(asc(characterItemsTable.slot), asc(characterItemsTable.name));
}

async function challengeMemberDto(
  tx: SocialCircleTransaction,
  member: SocialChallengeMember,
  viewerUserId: string,
) {
  const user = await getUserSummary(tx, member.userId);
  const progress = await challengeProgress(tx, member);
  return {
    user,
    status: member.status,
    journeyId: member.status === "accepted" ? member.habitId : null,
    progressDay: progress?.progressDay ?? null,
    journeyLength: progress ? 22 as const : null,
    completed: progress?.completed ?? null,
    consistencyPercentage: progress?.consistencyPercentage ?? null,
    character: await challengeCharacter(tx, viewerUserId, member.userId),
  };
}

export async function getSocialChallenge(
  tx: SocialCircleTransaction,
  challengeId: number,
  userId: string,
) {
  const [challenge] = await tx.select().from(socialChallengesTable)
    .where(eq(socialChallengesTable.id, challengeId)).limit(1);
  if (!challenge) throw new SocialHttpError(404, "Challenge not found");
  const [ownSnapshot] = await tx.select({
    id: socialChallengeMembersTable.id,
    status: socialChallengeMembersTable.status,
  }).from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).limit(1);
  if (!ownSnapshot) throw new SocialHttpError(404, "Challenge not found");
  const [ownMember] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).for("share").limit(1);
  if (!ownMember) throw new SocialHttpError(404, "Challenge not found");
  await assertNoSocialBlock(tx, userId, challenge.creatorUserId);
  const members = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    ownMember.status === "accepted"
      ? eq(socialChallengeMembersTable.status, "accepted")
      : eq(socialChallengeMembersTable.userId, userId),
  )).orderBy(asc(socialChallengeMembersTable.acceptedAt)).for("share");
  const safeMembers = [];
  for (const member of members) {
    if (member.userId !== userId) {
      try {
        await assertNoSocialBlock(tx, userId, member.userId);
      } catch {
        continue;
      }
    }
    safeMembers.push(await challengeMemberDto(tx, member, userId));
  }
  return {
    ...(await challengeSummary(tx, challenge, userId, ownMember)),
    members: safeMembers,
  };
}

export async function inviteUsersToSocialChallenge(
  tx: SocialCircleTransaction,
  challengeId: number,
  inviterUserId: string,
  inviteeUserIds: string[],
) {
  const uniqueInvitees = [...new Set(inviteeUserIds)];
  if (uniqueInvitees.includes(inviterUserId)) throw new SocialHttpError(400, "You cannot invite yourself");
  await lockSocialUsers(tx, [inviterUserId, ...uniqueInvitees]);
  const [challenge] = await tx.select().from(socialChallengesTable)
    .where(eq(socialChallengesTable.id, challengeId)).for("update").limit(1);
  if (!challenge || challenge.status !== "active") throw new SocialHttpError(404, "Challenge not found");
  const [inviter] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, inviterUserId),
    eq(socialChallengeMembersTable.status, "accepted"),
  )).for("share").limit(1);
  if (!inviter) throw new SocialHttpError(404, "Challenge not found");
  if (inviterUserId !== challenge.creatorUserId) {
    throw new SocialHttpError(403, "Only the challenge creator can invite participants");
  }
  const result = [];
  for (const inviteeUserId of uniqueInvitees) {
    await assertNoSocialBlock(tx, inviterUserId, inviteeUserId);
    if (!await areAcceptedSocialFriends(tx, inviterUserId, inviteeUserId)) {
      throw new SocialHttpError(403, "Challenge invitations are limited to accepted friends");
    }
    const [existing] = await tx.select().from(socialChallengeMembersTable).where(and(
      eq(socialChallengeMembersTable.challengeId, challengeId),
      eq(socialChallengeMembersTable.userId, inviteeUserId),
    )).for("update").limit(1);
    let member = existing;
    if (!existing) {
      [member] = await tx.insert(socialChallengeMembersTable).values({
        challengeId,
        userId: inviteeUserId,
        status: "invited",
      }).onConflictDoNothing().returning();
    }
    if (!member) {
      [member] = await tx.select().from(socialChallengeMembersTable).where(and(
        eq(socialChallengeMembersTable.challengeId, challengeId),
        eq(socialChallengeMembersTable.userId, inviteeUserId),
      )).limit(1);
    }
    if (!member || member.status === "accepted" || member.status === "left") {
      throw new SocialHttpError(409, "That user is already participating");
    }
    if (member.status !== "invited") {
      [member] = await tx.update(socialChallengeMembersTable).set({
        status: "invited",
        createdAt: new Date(Math.max(Date.now(), member.createdAt.getTime() + 1)),
      })
        .where(eq(socialChallengeMembersTable.id, member.id)).returning();
    }
    await insertSocialNotificationOnce(tx, {
      recipientUserId: inviteeUserId,
      actorUserId: inviterUserId,
      type: "challenge_invitation",
      eventKey: `challenge-invitation:${challengeId}:${inviteeUserId}:${member.createdAt.getTime()}`,
      challengeId,
      safeData: { challengeTitle: challenge.title },
    });
    result.push(await challengeMemberDto(tx, member, inviteeUserId));
  }
  return result;
}

export async function respondToSocialChallenge(
  tx: ChallengeHabitTransaction,
  challengeId: number,
  userId: string,
  input: { decision: "accept" | "decline" } & ChallengeHabitOverrides,
) {
  const [challenge] = await tx.select().from(socialChallengesTable)
    .where(eq(socialChallengesTable.id, challengeId)).limit(1);
  if (!challenge || challenge.status !== "active") throw new SocialHttpError(404, "Challenge not found");
  await lockSocialPair(tx, userId, challenge.creatorUserId);
  const [member] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).for("update").limit(1);
  if (!member) throw new SocialHttpError(404, "Challenge invitation not found");
  if (member.status === "accepted" && input.decision === "accept") {
    return getSocialChallenge(tx, challengeId, userId);
  }
  if (member.status !== "invited") throw new SocialHttpError(409, "Challenge invitation is no longer pending");
  if (input.decision === "decline") {
    await tx.update(socialChallengeMembersTable).set({ status: "declined" })
      .where(and(
        eq(socialChallengeMembersTable.id, member.id),
        eq(socialChallengeMembersTable.status, "invited"),
      ));
    let blocked = false;
    try {
      await assertNoSocialBlock(tx, userId, challenge.creatorUserId);
    } catch {
      blocked = true;
    }
    if (!blocked) {
      await insertSocialNotificationOnce(tx, {
        recipientUserId: challenge.creatorUserId,
        actorUserId: userId,
        type: "challenge_declined",
        eventKey: `challenge-declined:${challengeId}:${userId}`,
        challengeId,
      });
    }
    return getSocialChallenge(tx, challengeId, userId);
  }
  await assertNoSocialBlock(tx, userId, challenge.creatorUserId);
  if (!await areAcceptedSocialFriends(tx, userId, challenge.creatorUserId)) {
    throw new SocialHttpError(403, "Challenge invitation is no longer available");
  }
  await createChallengeHabit(tx, challengeId, userId, input);
  await insertSocialNotificationOnce(tx, {
    recipientUserId: challenge.creatorUserId,
    actorUserId: userId,
    type: "challenge_accepted",
    eventKey: `challenge-accepted:${challengeId}:${userId}`,
    challengeId,
  });
  return getSocialChallenge(tx, challengeId, userId);
}

export async function leaveSocialChallenge(
  tx: SocialCircleTransaction,
  challengeId: number,
  userId: string,
) {
  const [member] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).for("update").limit(1);
  if (!member) throw new SocialHttpError(404, "Challenge not found");
  if (member.status === "left") return getSocialChallenge(tx, challengeId, userId);
  if (member.status !== "accepted") throw new SocialHttpError(409, "Only accepted participants can leave");
  await tx.update(socialChallengeMembersTable).set({ status: "left" })
    .where(eq(socialChallengeMembersTable.id, member.id));
  return getSocialChallenge(tx, challengeId, userId);
}

export async function getChallengeMemberById(
  tx: SocialCircleTransaction,
  challengeId: number,
  userId: string,
): Promise<SocialChallengeMember> {
  const [member] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, userId),
  )).limit(1);
  if (!member || member.status !== "accepted") throw new SocialHttpError(404, "Challenge not found");
  return member;
}

export async function getChallengeProgressConsent(
  tx: SocialCircleTransaction,
  challengeId: number,
  viewerUserId: string,
  participantUserId: string,
) {
  const [viewer] = await tx.select({ status: socialChallengeMembersTable.status })
    .from(socialChallengeMembersTable).where(and(
      eq(socialChallengeMembersTable.challengeId, challengeId),
      eq(socialChallengeMembersTable.userId, viewerUserId),
    )).for("share").limit(1);
  const [participant] = await tx.select().from(socialChallengeMembersTable).where(and(
    eq(socialChallengeMembersTable.challengeId, challengeId),
    eq(socialChallengeMembersTable.userId, participantUserId),
  )).for("share").limit(1);
  if (viewer?.status !== "accepted" || !participant || participant.status !== "accepted") return null;
  try {
    await assertNoSocialBlock(tx, viewerUserId, participantUserId);
  } catch {
    return null;
  }
  return challengeProgress(tx, participant);
}

export async function isGroupInvitationPending(tx: SocialCircleTransaction, invitationId: number, userId: string) {
  const [invitation] = await tx.select({ id: socialGroupInvitationsTable.id })
    .from(socialGroupInvitationsTable).where(and(
      eq(socialGroupInvitationsTable.id, invitationId),
      eq(socialGroupInvitationsTable.inviteeUserId, userId),
      eq(socialGroupInvitationsTable.status, "pending"),
    )).limit(1);
  return Boolean(invitation);
}

export async function canViewGroupJourney(
  tx: SocialCircleTransaction,
  viewerUserId: string,
  groupId: number,
  ownerUserId: string,
  habitId: number,
) {
  return Boolean(await groupJourneyProgress(tx, viewerUserId, groupId, ownerUserId, habitId));
}
