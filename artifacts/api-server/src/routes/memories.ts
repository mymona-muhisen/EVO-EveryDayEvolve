import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, memoriesTable } from "@workspace/db";
import {
  ListMemoriesQueryParams,
  ListMemoriesResponse,
  CreateMemoryBody,
  CreateMemoryResponse,
  DeleteMemoryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { ObjectStorageService } from "../lib/objectStorage";
import { toDateOnly } from "../lib/dates";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
router.use(requireAuth);

function withPhotoUrl<T extends { photoObjectPath: string | null }>(
  memory: T,
): Omit<T, "photoObjectPath"> & { photoUrl: string | null } {
  const { photoObjectPath, ...rest } = memory;
  return { ...rest, photoUrl: photoObjectPath ? `/api/storage${photoObjectPath}` : null };
}

router.get("/memories", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListMemoriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = [eq(memoriesTable.userId, req.userId!)];
  if (query.data.habitId !== undefined) conditions.push(eq(memoriesTable.habitId, query.data.habitId));

  const memories = await db
    .select()
    .from(memoriesTable)
    .where(and(...conditions))
    .orderBy(memoriesTable.date);

  res.json(ListMemoriesResponse.parse(memories.map(withPhotoUrl)));
});

router.post("/memories", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = CreateMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let photoObjectPath: string | null = null;
  if (parsed.data.photoObjectPath) {
    photoObjectPath = await objectStorageService.trySetObjectEntityAclPolicy(
      parsed.data.photoObjectPath,
      { owner: req.userId!, visibility: "private" },
    );
  }

  const [memory] = await db
    .insert(memoriesTable)
    .values({
      userId: req.userId!,
      habitId: parsed.data.habitId ?? null,
      note: parsed.data.note,
      photoObjectPath,
      date: toDateOnly(parsed.data.date),
    })
    .returning();

  res.status(201).json(CreateMemoryResponse.parse(withPhotoUrl(memory)));
});

router.delete("/memories/:memoryId", async (req, res): Promise<void> => {
  const params = DeleteMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [memory] = await db
    .delete(memoriesTable)
    .where(and(eq(memoriesTable.id, params.data.memoryId), eq(memoriesTable.userId, req.userId!)))
    .returning();

  if (!memory) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
