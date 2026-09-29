import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import {
  db,
  groupsTable,
  groupMembersTable,
  groupReactionsTable,
  usersTable,
  checkinsTable,
} from "@workspace/db";
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
    if (group) groups.push({ ...group, memberCount: await countMembers(group.id) });
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

  await db.insert(groupMembersTable).values({ groupId: group.id, userId: req.userId! });

  res.status(201).json(CreateGroupResponse.parse({ ...group, memberCount: 1 }));
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

  await db
    .insert(groupMembersTable)
    .values({ groupId: group.id, userId: req.userId! })
    .onConflictDoNothing();

  res.json(JoinGroupResponse.parse({ ...group, memberCount: await countMembers(group.id) }));
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
      displayName: usersTable.displayName,
      avatarEmoji: usersTable.avatarEmoji,
    })
    .from(groupMembersTable)
    .innerJoin(usersTable, eq(groupMembersTable.userId, usersTable.id))
    .where(eq(groupMembersTable.groupId, group.id));

  const members = [];
  for (const m of memberRows) {
    const conditions = [
      eq(checkinsTable.userId, m.userId),
      eq(checkinsTable.completed, true),
      gte(checkinsTable.date, group.startDate),
    ];
    if (group.endDate) conditions.push(lte(checkinsTable.date, group.endDate));

    const progressRows = await db
      .select()
      .from(checkinsTable)
      .where(and(...conditions));

    members.push({
      userId: m.userId,
      displayName: m.displayName,
      avatarEmoji: m.avatarEmoji,
      progressCount: progressRows.length,
      isMe: m.userId === req.userId,
    });
  }

  members.sort((a, b) => b.progressCount - a.progressCount);

  res.json(GetGroupResponse.parse({ ...group, memberCount: memberRows.length, members }));
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

  const reactions = await db
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

  const [reaction] = await db
    .insert(groupReactionsTable)
    .values({
      groupId: params.data.groupId,
      fromUserId: req.userId!,
      toUserId: parsed.data.toUserId ?? null,
      emoji: parsed.data.emoji,
    })
    .returning();

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
