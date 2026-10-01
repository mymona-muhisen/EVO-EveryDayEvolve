import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  groupsTable,
  groupMembersTable,
  groupReactionsTable,
  usersTable,
} from "@workspace/db";
import { SocialHttpError } from "../services/social-common";
import { createLegacyGroupReactionWithCooldown } from "../services/social-circles";
import {
  ListMyGroupsResponse,
  CreateGroupBody,
  CreateGroupResponse,
  JoinGroupBody,
  JoinGroupResponse,
  GetGroupParams,
  GetGroupResponse,
  ListGroupReactionsParams,
  ListGroupReactionsResponse,
  CreateGroupReactionParams,
  CreateGroupReactionBody,
  CreateGroupReactionResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { toDateOnly } from "../lib/dates";
import { assertNoSocialBlock } from "../services/social-common";

const router: IRouter = Router();
router.use(requireAuth);

function generateInviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

async function countMembers(groupId: number): Promise<number> {
  const rows = await db.select().from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  return rows.length;
}

async function isMember(groupId: number, userId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(groupMembersTable)
    .where(and(eq(groupMembersTable.groupId, groupId), eq(groupMembersTable.userId, userId)));
  return !!row;
}

router.get("/groups", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const memberships = await db
    .select()
    .from(groupMembersTable)
    .where(eq(groupMembersTable.userId, req.userId!));

  const groups = [];
  for (const membership of memberships) {
    const [group] = await db.select().from(groupsTable).where(eq(groupsTable.id, membership.groupId));
    if (group) groups.push({ ...group, inviteCode: "", memberCount: await countMembers(group.id) });
  }

  res.json(ListMyGroupsResponse.parse(groups));
});

router.post("/groups", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = CreateGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let inviteCode = generateInviteCode();
  for (let attempts = 0; attempts < 5; attempts++) {
    const [existing] = await db.select().from(groupsTable).where(eq(groupsTable.inviteCode, inviteCode));
    if (!existing) break;
    inviteCode = generateInviteCode();
  }

  const [group] = await db
    .insert(groupsTable)
    .values({
      name: parsed.data.name,
      inviteCode,
      goalDescription: parsed.data.goalDescription,
      startDate: toDateOnly(parsed.data.startDate),
      endDate: parsed.data.endDate ? toDateOnly(parsed.data.endDate) : null,
      createdBy: req.userId!,
    })
    .returning();

  await db.insert(groupMembersTable).values({ groupId: group.id, userId: req.userId!, role: "owner" });

  res.status(201).json(CreateGroupResponse.parse({ ...group, inviteCode: "", memberCount: 1 }));
});

router.post("/groups/join", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = JoinGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [group] = await db.select().from(groupsTable).where(eq(groupsTable.inviteCode, parsed.data.inviteCode));
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  // Invite codes are retained for legacy rows only. New circles are invite-only,
  // and this deprecated route cannot be used to add a member to any group.
  if (!(await isMember(group.id, req.userId!))) {
    res.status(403).json({ error: "Groups can only be joined through an invitation" });
    return;
  }
  res.json(JoinGroupResponse.parse({
    ...group,
    inviteCode: "",
    memberCount: await countMembers(group.id),
  }));
});

router.get("/groups/:groupId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetGroupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [group] = await db.select().from(groupsTable).where(eq(groupsTable.id, params.data.groupId));
  if (!group || !(await isMember(params.data.groupId, req.userId!))) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  const memberRows = await db
    .select({
      userId: groupMembersTable.userId,
      role: groupMembersTable.role,
      displayName: usersTable.displayName,
      avatarEmoji: usersTable.avatarEmoji,
    })
    .from(groupMembersTable)
    .innerJoin(usersTable, eq(groupMembersTable.userId, usersTable.id))
    .where(eq(groupMembersTable.groupId, group.id));

  const visibleMembers = [];
  for (const m of memberRows) {
    if (m.userId !== req.userId) {
      let blocked = false;
      try {
        await db.transaction((tx) => assertNoSocialBlock(tx, req.userId!, m.userId));
      } catch {
        blocked = true;
      }
      if (blocked) continue;
    }
    visibleMembers.push({
      userId: m.userId,
      displayName: m.displayName,
      avatarEmoji: m.avatarEmoji,
      isMe: m.userId === req.userId,
    });
  }

  res.json(GetGroupResponse.parse({
    ...group,
    inviteCode: "",
    memberCount: memberRows.length,
    members: visibleMembers,
  }));
});

router.get("/groups/:groupId/reactions", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = ListGroupReactionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (!(await isMember(params.data.groupId, req.userId!))) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  const reactionRows = await db
    .select({
      id: groupReactionsTable.id,
      fromUserId: groupReactionsTable.fromUserId,
      fromDisplayName: usersTable.displayName,
      toUserId: groupReactionsTable.toUserId,
      emoji: groupReactionsTable.emoji,
      createdAt: groupReactionsTable.createdAt,
    })
    .from(groupReactionsTable)
    .innerJoin(usersTable, eq(groupReactionsTable.fromUserId, usersTable.id))
    .where(eq(groupReactionsTable.groupId, params.data.groupId))
    .orderBy(desc(groupReactionsTable.createdAt))
    .limit(50);

  const reactions = [];
  for (const reaction of reactionRows) {
    const [senderMember] = await db.select({ id: groupMembersTable.id })
      .from(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, params.data.groupId),
        eq(groupMembersTable.userId, reaction.fromUserId),
      )).limit(1);
    const [receiverMember] = reaction.toUserId
      ? await db.select({ id: groupMembersTable.id }).from(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, params.data.groupId),
        eq(groupMembersTable.userId, reaction.toUserId),
      )).limit(1)
      : [true];
    if (!senderMember || !receiverMember) continue;
    try {
      await db.transaction(async (tx) => {
        await assertNoSocialBlock(tx, req.userId!, reaction.fromUserId);
        if (reaction.toUserId) await assertNoSocialBlock(tx, req.userId!, reaction.toUserId);
      });
    } catch {
      continue;
    }
    reactions.push(reaction);
  }
  res.json(ListGroupReactionsResponse.parse(reactions));
});

router.post("/groups/:groupId/reactions", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = CreateGroupReactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateGroupReactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!(await isMember(params.data.groupId, req.userId!))) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (parsed.data.toUserId) {
    if (parsed.data.toUserId === req.userId
      || !(await isMember(params.data.groupId, parsed.data.toUserId))) {
      res.status(400).json({ error: "Recipient must be another current group member" });
      return;
    }
    try {
      await db.transaction((tx) => assertNoSocialBlock(tx, req.userId!, parsed.data.toUserId!));
    } catch {
      res.status(404).json({ error: "Recipient not found" });
      return;
    }
  }

  let reaction;
  try {
    reaction = await db.transaction((tx) => createLegacyGroupReactionWithCooldown(tx, {
      groupId: params.data.groupId,
      senderUserId: req.userId!,
      receiverUserId: parsed.data.toUserId,
      emoji: parsed.data.emoji,
    }));
  } catch (error) {
    if (error instanceof SocialHttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  const [fromUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));

  res.status(201).json(
    CreateGroupReactionResponse.parse({
      id: reaction.id,
      fromUserId: reaction.fromUserId,
      fromDisplayName: fromUser.displayName,
      toUserId: reaction.toUserId,
      emoji: reaction.emoji,
      createdAt: reaction.createdAt,
    }),
  );
});

export default router;
