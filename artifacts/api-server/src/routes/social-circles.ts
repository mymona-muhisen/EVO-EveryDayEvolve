import { Readable } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  CreateSocialChallengeBody,
  CreateSocialChallengeResponse,
  CreateSocialGroupBody,
  CreateSocialGroupResponse,
  CreateSocialGroupEncouragementBody,
  CreateSocialGroupEncouragementParams,
  CreateSocialGroupEncouragementResponse,
  GetSocialChallengeParams,
  GetSocialChallengeResponse,
  GetSocialGroupCoverParams,
  GetSocialGroupParams,
  GetSocialGroupResponse,
  InviteUsersToSocialChallengeBody,
  InviteUsersToSocialChallengeParams,
  InviteUsersToSocialChallengeResponse,
  InviteUsersToSocialGroupBody,
  InviteUsersToSocialGroupParams,
  InviteUsersToSocialGroupResponse,
  LeaveSocialChallengeParams,
  LeaveSocialChallengeResponse,
  LeaveSocialGroupParams,
  LeaveSocialGroupResponse,
  ListIncomingSocialGroupInvitationsResponse,
  ListMySocialGroupJourneySharesParams,
  ListMySocialGroupJourneySharesResponse,
  ListSocialChallengesResponse,
  ListSocialGroupActivityParams,
  ListSocialGroupActivityResponse,
  ListSocialGroupEncouragementsParams,
  ListSocialGroupEncouragementsResponse,
  ListSocialGroupsResponse,
  RespondToSocialChallengeBody,
  RespondToSocialChallengeParams,
  RespondToSocialChallengeResponse,
  RespondToSocialGroupInvitationBody,
  RespondToSocialGroupInvitationParams,
  RespondToSocialGroupInvitationResponse,
  RevokeMySocialGroupJourneyShareParams,
  ShareMyJourneyWithSocialGroupBody,
  ShareMyJourneyWithSocialGroupParams,
  ShareMyJourneyWithSocialGroupResponse,
  UpdateSocialGroupCoverBody,
  UpdateSocialGroupCoverParams,
  UpdateSocialGroupCoverResponse,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { MemoryImageError, MemoryImageService } from "../lib/memoryImageService";
import {
  ObjectAclOwnershipError,
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { SocialHttpError } from "../services/social-common";
import {
  createSocialChallenge,
  createSocialGroup,
  createSocialGroupEncouragement,
  getGroupCoverObjectPath,
  getSocialChallenge,
  getSocialGroup,
  inviteUsersToSocialChallenge,
  inviteUsersToSocialGroup,
  leaveSocialChallenge,
  leaveSocialGroup,
  listIncomingSocialGroupInvitations,
  listMyGroupJourneyShares,
  listSocialChallenges,
  listSocialGroupActivity,
  listSocialGroupEncouragements,
  listSocialGroups,
  requireGroupOwner,
  respondToSocialChallenge,
  respondToSocialGroupInvitation,
  revokeMyJourneyShare,
  shareMyJourneyWithGroup,
  updateGroupCover,
} from "../services/social-circles";

const router: IRouter = Router();
router.use(requireAuth);

const memoryImageService = new MemoryImageService();
const objectStorageService = new ObjectStorageService();

type AsyncRoute = (req: Request, res: Response) => Promise<void>;
function route(handler: AsyncRoute): AsyncRoute {
  return async (req, res): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof SocialHttpError) {
        const status = (error as Error & { status?: number; statusCode?: number }).status
          ?? (error as Error & { statusCode?: number }).statusCode
          ?? 500;
        res.status(status).json({ error: error.message });
        return;
      }
      if (error instanceof MemoryImageError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (error instanceof ObjectAclOwnershipError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Social circles request failed");
      res.status(500).json({ error: "Social circles request failed" });
    }
  };
}

function parseFailure(res: Response, error: { message: string }): void {
  res.status(400).json({ error: error.message });
}

router.get("/social/groups", route(async (req, res) => {
  await ensureUser(req.userId!);
  const payload = await db.transaction((tx) => listSocialGroups(tx, req.userId!));
  res.json(ListSocialGroupsResponse.parse(payload));
}));

router.post("/social/groups", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = CreateSocialGroupBody.safeParse(req.body);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) => createSocialGroup(tx, req.userId!, parsed.data));
  res.status(201).json(CreateSocialGroupResponse.parse(payload));
}));

router.get("/social/groups/:groupId", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = GetSocialGroupParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) => getSocialGroup(tx, parsed.data.groupId, req.userId!));
  res.json(GetSocialGroupResponse.parse(payload));
}));

router.post("/social/groups/:groupId/invitations", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = InviteUsersToSocialGroupParams.safeParse(req.params);
  const body = InviteUsersToSocialGroupBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => inviteUsersToSocialGroup(
    tx, params.data.groupId, req.userId!, body.data.inviteeUserIds,
  ));
  res.status(201).json(InviteUsersToSocialGroupResponse.parse(payload));
}));

router.post("/social/group-invitations/:invitationId/respond", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = RespondToSocialGroupInvitationParams.safeParse(req.params);
  const body = RespondToSocialGroupInvitationBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => respondToSocialGroupInvitation(
    tx, params.data.invitationId, req.userId!, body.data.decision,
  ));
  res.json(RespondToSocialGroupInvitationResponse.parse(payload));
}));

router.get("/social/group-invitations/incoming", route(async (req, res) => {
  await ensureUser(req.userId!);
  const payload = await db.transaction((tx) => listIncomingSocialGroupInvitations(tx, req.userId!));
  res.json(ListIncomingSocialGroupInvitationsResponse.parse(payload));
}));

router.post("/social/groups/:groupId/leave", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = LeaveSocialGroupParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  await db.transaction((tx) => leaveSocialGroup(tx, parsed.data.groupId, req.userId!));
  res.status(204).json(LeaveSocialGroupResponse.parse(undefined));
}));

router.get("/social/groups/:groupId/activity", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = ListSocialGroupActivityParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) =>
    listSocialGroupActivity(tx, parsed.data.groupId, req.userId!));
  res.json(ListSocialGroupActivityResponse.parse(payload));
}));

router.get("/social/groups/:groupId/shares", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = ListMySocialGroupJourneySharesParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) =>
    listMyGroupJourneyShares(tx, parsed.data.groupId, req.userId!));
  res.json(ListMySocialGroupJourneySharesResponse.parse(payload));
}));

router.post("/social/groups/:groupId/shares", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = ShareMyJourneyWithSocialGroupParams.safeParse(req.params);
  const body = ShareMyJourneyWithSocialGroupBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => shareMyJourneyWithGroup(
    tx, params.data.groupId, req.userId!, body.data.journeyId,
  ));
  res.status(201).json(ShareMyJourneyWithSocialGroupResponse.parse(payload));
}));

router.delete("/social/groups/:groupId/shares/:journeyId", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = RevokeMySocialGroupJourneyShareParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  await db.transaction((tx) => revokeMyJourneyShare(
    tx, parsed.data.groupId, parsed.data.journeyId, req.userId!,
  ));
  res.status(204).end();
}));

router.get("/social/groups/:groupId/encouragements", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = ListSocialGroupEncouragementsParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) =>
    listSocialGroupEncouragements(tx, parsed.data.groupId, req.userId!));
  res.json(ListSocialGroupEncouragementsResponse.parse(payload));
}));

router.post("/social/groups/:groupId/encouragements", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = CreateSocialGroupEncouragementParams.safeParse(req.params);
  const body = CreateSocialGroupEncouragementBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => createSocialGroupEncouragement(
    tx, params.data.groupId, req.userId!, body.data,
  ));
  res.status(201).json(CreateSocialGroupEncouragementResponse.parse(payload));
}));

router.get("/social/groups/:groupId/cover", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = GetSocialGroupCoverParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const objectPath = await db.transaction((tx) =>
    getGroupCoverObjectPath(tx, parsed.data.groupId, req.userId!));
  const file = await objectStorageService.getObjectEntityFile(objectPath);
  const response = await objectStorageService.downloadObject(file, 0);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.setHeader("Cache-Control", "private, no-store");
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
}));

router.put("/social/groups/:groupId/cover", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = UpdateSocialGroupCoverParams.safeParse(req.params);
  const body = UpdateSocialGroupCoverBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  await db.transaction((tx) => requireGroupOwner(tx, params.data.groupId, req.userId!));
  let derivedPath: string | null = null;
  if (body.data.imageObjectPath !== null) {
    const sourcePath = body.data.imageObjectPath;
    if (!sourcePath.startsWith("/objects/uploads/")) {
      res.status(400).json({ error: "Cover image must be an authenticated private upload" });
      return;
    }
    const sourceObjectPath = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
        .where(eq(usersTable.id, req.userId!)).for("update");
      if (!owner) throw new SocialHttpError(404, "User not found");
      await requireGroupOwner(tx, params.data.groupId, req.userId!);
      return objectStorageService.trySetObjectEntityAclPolicy(
        sourcePath,
        { owner: req.userId!, visibility: "private" },
        req.userId!,
        tx,
      );
    });
    derivedPath = await memoryImageService.createOptimizedPrivatePhoto(
      sourceObjectPath,
      req.userId!,
    );
  }
  const payload = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!owner) throw new SocialHttpError(404, "User not found");
    if (derivedPath) {
      derivedPath = await objectStorageService.trySetObjectEntityAclPolicy(
        derivedPath,
        { owner: req.userId!, visibility: "private" },
        req.userId!,
        tx,
      );
    }
    return updateGroupCover(tx, params.data.groupId, req.userId!, derivedPath);
  });
  res.json(UpdateSocialGroupCoverResponse.parse(payload));
}));

router.get("/social/challenges", route(async (req, res) => {
  await ensureUser(req.userId!);
  const payload = await db.transaction((tx) => listSocialChallenges(tx, req.userId!));
  res.json(ListSocialChallengesResponse.parse(payload));
}));

router.post("/social/challenges", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = CreateSocialChallengeBody.safeParse(req.body);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) => createSocialChallenge(
    tx,
    req.userId!,
    parsed.data.sourceHabitId,
    parsed.data.title,
    parsed.data.description,
  ));
  res.status(201).json(CreateSocialChallengeResponse.parse(payload));
}));

router.get("/social/challenges/:challengeId", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = GetSocialChallengeParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) =>
    getSocialChallenge(tx, parsed.data.challengeId, req.userId!));
  res.json(GetSocialChallengeResponse.parse(payload));
}));

router.post("/social/challenges/:challengeId/invitations", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = InviteUsersToSocialChallengeParams.safeParse(req.params);
  const body = InviteUsersToSocialChallengeBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => inviteUsersToSocialChallenge(
    tx, params.data.challengeId, req.userId!, body.data.inviteeUserIds,
  ));
  res.status(201).json(InviteUsersToSocialChallengeResponse.parse(payload));
}));

router.post("/social/challenges/:challengeId/respond", route(async (req, res) => {
  await ensureUser(req.userId!);
  const params = RespondToSocialChallengeParams.safeParse(req.params);
  const body = RespondToSocialChallengeBody.safeParse(req.body);
  if (!params.success) return parseFailure(res, params.error);
  if (!body.success) return parseFailure(res, body.error);
  const payload = await db.transaction((tx) => respondToSocialChallenge(
    tx, params.data.challengeId, req.userId!, body.data,
  ));
  res.json(RespondToSocialChallengeResponse.parse(payload));
}));

router.post("/social/challenges/:challengeId/leave", route(async (req, res) => {
  await ensureUser(req.userId!);
  const parsed = LeaveSocialChallengeParams.safeParse(req.params);
  if (!parsed.success) return parseFailure(res, parsed.error);
  const payload = await db.transaction((tx) =>
    leaveSocialChallenge(tx, parsed.data.challengeId, req.userId!));
  res.json(LeaveSocialChallengeResponse.parse(payload));
}));

export default router;