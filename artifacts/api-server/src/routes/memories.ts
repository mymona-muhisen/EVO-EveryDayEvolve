import { Router, type IRouter } from "express";
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  checkinsTable,
  db,
  habitDaysTable,
  habitsTable,
  memoriesTable,
  usersTable,
} from "@workspace/db";
import {
  CreateMemoryBody,
  CreateMemoryResponse,
  DeleteMemoryParams,
  GetMemoryParams,
  GetMemoryResponse,
  ListMemoriesQueryParams,
  ListMemoriesResponse,
  UpdateMemoryBody,
  UpdateMemoryParams,
  UpdateMemoryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import {
  ObjectAclOwnershipError,
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { todayInTimezone, toDateOnly } from "../lib/dates";
import {
  HABIT_JOURNEY_LENGTH,
  isWithinJourneyWindow,
  journeyDayNumber,
} from "../lib/habitJourney";
import { MemoryImageError, MemoryImageService } from "../lib/memoryImageService";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const memoryImageService = new MemoryImageService(objectStorageService);
router.use(requireAuth);

type MemoryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CaptureStatus = 400 | 404 | 409;

class MemoryCaptureError extends Error {
  constructor(message: string, readonly statusCode: CaptureStatus) {
    super(message);
  }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function onlyKnownKeys(value: unknown, keys: Set<string>): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).every((key) => keys.has(key));
}

function normalizedCaption(caption: string | null | undefined): string | null {
  const normalized = caption?.trim() ?? "";
  return normalized || null;
}

async function assertCaptureEligible(
  tx: MemoryTransaction,
  userId: string,
  timezone: string,
  habitId: number,
  date: string,
) {
  const [habit] = await tx.select().from(habitsTable).where(and(
    eq(habitsTable.id, habitId),
    eq(habitsTable.userId, userId),
  )).for("update").limit(1);
  if (!habit) throw new MemoryCaptureError("Habit not found", 404);
  if (habit.journeyStartDate == null || habit.journeyLength !== HABIT_JOURNEY_LENGTH
    || !isWithinJourneyWindow(date, habit.journeyStartDate, habit.journeyLength)) {
    throw new MemoryCaptureError("Date is outside this habit's 22-day journey", 400);
  }
  if (date > todayInTimezone(timezone)) {
    throw new MemoryCaptureError("A future journey day cannot have a memory", 400);
  }

  const [day] = await tx.select().from(habitDaysTable).where(and(
    eq(habitDaysTable.habitId, habit.id),
    eq(habitDaysTable.date, date),
  )).for("update").limit(1);
  if (!day || !day.scheduled || day.dayNumber !== journeyDayNumber(date, habit.journeyStartDate)) {
    throw new MemoryCaptureError("Date does not have a scheduled saved journey-day snapshot", 400);
  }

  const [checkin] = await tx.select().from(checkinsTable).where(and(
    eq(checkinsTable.habitId, habit.id),
    eq(checkinsTable.userId, userId),
    eq(checkinsTable.date, date),
    eq(checkinsTable.completed, true),
  )).for("update").limit(1);
  if (!checkin) {
    throw new MemoryCaptureError("A successful saved-day check-in is required", 400);
  }
  return { habit, day, checkin };
}

async function memoryRows(conditions: SQL[]) {
  return db.select({
    memory: memoriesTable,
    day: habitDaysTable,
    habit: habitsTable,
    checkin: checkinsTable,
  }).from(memoriesTable)
    .leftJoin(habitDaysTable, eq(habitDaysTable.id, memoriesTable.habitDayId))
    .leftJoin(habitsTable, and(
      eq(habitsTable.id, habitDaysTable.habitId),
      eq(habitsTable.userId, memoriesTable.userId),
    ))
    .leftJoin(checkinsTable, and(
      eq(checkinsTable.habitId, habitDaysTable.habitId),
      eq(checkinsTable.userId, memoriesTable.userId),
      eq(checkinsTable.date, habitDaysTable.date),
      eq(checkinsTable.completed, true),
    ))
    .where(and(...conditions))
    .orderBy(desc(memoriesTable.date), desc(memoriesTable.createdAt));
}

function memoryResponse(row: Awaited<ReturnType<typeof memoryRows>>[number]) {
  const { memory, day, habit, checkin } = row;
  const hasSavedContext = day != null
    && habit != null
    && memory.habitDayId === day.id
    && memory.habitId === habit.id
    && memory.date === day.date
    && memory.userId === habit.userId
    && habit.journeyStartDate != null
    && habit.journeyLength === HABIT_JOURNEY_LENGTH
    && isWithinJourneyWindow(day.date, habit.journeyStartDate, habit.journeyLength);

  return {
    id: memory.id,
    habitId: memory.habitId,
    note: memory.note,
    photoUrl: memory.photoObjectPath ? `/api/storage${memory.photoObjectPath}` : null,
    date: memory.date,
    createdAt: memory.createdAt,
    caption: memory.caption ?? (
      memory.habitDayId == null && memory.note.length <= 300 ? memory.note : null
    ),
    visibility: memory.visibility,
    updatedAt: memory.updatedAt,
    journeyId: hasSavedContext ? habit.id : null,
    habitDayId: hasSavedContext ? day.id : null,
    dayNumber: hasSavedContext ? day.dayNumber : null,
    journeyLength: hasSavedContext ? habit.journeyLength : null,
    habitTitle: hasSavedContext ? day.title : null,
    targetValue: hasSavedContext ? day.targetValue : null,
    actualValue: hasSavedContext && checkin != null ? checkin.value : null,
    unit: hasSavedContext ? day.unit : null,
    difficulty: hasSavedContext && checkin != null ? checkin.difficulty : null,
  };
}

async function oneMemory(userId: string, memoryId: number) {
  const rows = await memoryRows([
    eq(memoriesTable.id, memoryId),
    eq(memoriesTable.userId, userId),
  ]);
  return rows[0] ?? null;
}

router.get("/memories", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = ListMemoriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions = [eq(memoriesTable.userId, req.userId!)];
  if (parsed.data.habitId !== undefined) {
    conditions.push(eq(memoriesTable.habitId, parsed.data.habitId));
  }
  if (parsed.data.journeyId !== undefined) {
    // A journey filter is only satisfied by an explicit saved-day association;
    // legacy habitId values are never promoted to journey links.
    conditions.push(eq(habitDaysTable.habitId, parsed.data.journeyId));
  }

  const rows = await memoryRows(conditions);
  res.json(ListMemoriesResponse.parse(rows.map(memoryResponse)));
});

router.post("/memories", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  if (!onlyKnownKeys(req.body, new Set([
    "habitId",
    "date",
    "photoObjectPath",
    "caption",
    "note",
    "visibility",
  ]))) {
    res.status(400).json({ error: "Unsupported memory fields" });
    return;
  }
  const parsed = CreateMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.visibility !== "private") {
    res.status(400).json({ error: "Only private memory visibility is supported" });
    return;
  }

  const date = toDateOnly(parsed.data.date);
  const captionInput = parsed.data.caption !== undefined
    ? parsed.data.caption
    : parsed.data.note;
  const caption = normalizedCaption(captionInput);

  let initialEligibility: Awaited<ReturnType<typeof assertCaptureEligible>>;
  try {
    initialEligibility = await db.transaction((tx) => assertCaptureEligible(
      tx,
      req.userId!,
      user.timezone,
      parsed.data.habitId,
      date,
    ));
  } catch (error) {
    if (error instanceof MemoryCaptureError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }
  const [existingMemory] = await db.select({ id: memoriesTable.id })
    .from(memoriesTable).where(and(
      eq(memoriesTable.userId, req.userId!),
      eq(memoriesTable.habitDayId, initialEligibility.day.id),
    )).limit(1);
  if (existingMemory) {
    res.status(409).json({ error: "This saved journey day already has a memory" });
    return;
  }

  let sourceObjectPath: string;
  try {
    sourceObjectPath = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
        .where(eq(usersTable.id, req.userId!)).for("update");
      if (!owner) throw new MemoryCaptureError("User not found", 404);
      return objectStorageService.trySetObjectEntityAclPolicy(
        parsed.data.photoObjectPath,
        { owner: req.userId!, visibility: "private" },
        req.userId!,
        tx,
      );
    });
  } catch (error) {
    if (error instanceof MemoryCaptureError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectAclOwnershipError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Photo object was not found" });
      return;
    }
    throw error;
  }

  let optimizedPath: string;
  try {
    optimizedPath = await memoryImageService.createOptimizedPrivatePhoto(
      sourceObjectPath,
      req.userId!,
    );
  } catch (error) {
    if (error instanceof MemoryImageError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectAclOwnershipError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Photo object was not found" });
      return;
    }
    res.status(500).json({ error: "Unable to prepare photo" });
    return;
  }

  try {
    const memory = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
        .where(eq(usersTable.id, req.userId!)).for("update");
      if (!owner) throw new MemoryCaptureError("User not found", 404);

      const { day } = await assertCaptureEligible(
        tx,
        req.userId!,
        user.timezone,
        parsed.data.habitId,
        date,
      );
      const [existing] = await tx.select({ id: memoriesTable.id })
        .from(memoriesTable).where(and(
          eq(memoriesTable.userId, req.userId!),
          eq(memoriesTable.habitDayId, day.id),
        )).for("update").limit(1);
      if (existing) {
        throw new MemoryCaptureError("This saved journey day already has a memory", 409);
      }

      // Adoption and the memory reference share the owner's lock and transaction,
      // preventing the private-upload cleanup worker from deleting a live photo.
      const photoObjectPath = await objectStorageService.trySetObjectEntityAclPolicy(
        optimizedPath,
        { owner: req.userId!, visibility: "private" },
        req.userId!,
        tx,
      );
      const [created] = await tx.insert(memoriesTable).values({
        userId: req.userId!,
        habitId: parsed.data.habitId,
        habitDayId: day.id,
        note: caption ?? "",
        caption,
        visibility: "private",
        photoObjectPath,
        date,
      }).returning();
      if (!created) throw new Error("Memory insert returned no row");
      return created;
    });

    const row = await oneMemory(req.userId!, memory.id);
    if (!row) {
      res.status(500).json({ error: "Created memory could not be loaded" });
      return;
    }
    res.status(201).json(CreateMemoryResponse.parse(memoryResponse(row)));
  } catch (error) {
    // The derived object remains provenance-tracked and is eligible for the
    // cleanup worker only after its ordinary seven-day unreferenced grace.
    if (error instanceof MemoryCaptureError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectAclOwnershipError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Photo object was not found" });
      return;
    }
    if (hasDatabaseErrorCode(error, "23505")) {
      res.status(409).json({ error: "This saved journey day already has a memory" });
      return;
    }
    res.status(500).json({ error: "Unable to save memory" });
    return;
  }
});

router.get("/memories/:memoryId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await oneMemory(req.userId!, params.data.memoryId);
  if (!row) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(GetMemoryResponse.parse(memoryResponse(row)));
});

router.patch("/memories/:memoryId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = UpdateMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!onlyKnownKeys(req.body, new Set(["caption", "note"]))) {
    res.status(400).json({ error: "Only the memory caption can be updated" });
    return;
  }
  const parsed = UpdateMemoryBody.safeParse(req.body);
  if (!parsed.success
    || (parsed.data.caption === undefined && parsed.data.note === undefined)) {
    res.status(400).json({ error: parsed.success ? "A caption update is required" : parsed.error.message });
    return;
  }

  const captionInput = parsed.data.caption !== undefined
    ? parsed.data.caption
    : parsed.data.note;
  const caption = normalizedCaption(captionInput);
  const [updated] = await db.update(memoriesTable).set({
    caption,
    note: caption ?? "",
    updatedAt: new Date(),
  }).where(and(
    eq(memoriesTable.id, params.data.memoryId),
    eq(memoriesTable.userId, req.userId!),
  )).returning({ id: memoriesTable.id });
  if (!updated) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  const row = await oneMemory(req.userId!, updated.id);
  if (!row) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(UpdateMemoryResponse.parse(memoryResponse(row)));
});

router.delete("/memories/:memoryId", async (req, res): Promise<void> => {
  const params = DeleteMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).for("update");
    if (!owner) return false;
    const [memory] = await tx.delete(memoriesTable).where(and(
      eq(memoriesTable.id, params.data.memoryId),
      eq(memoriesTable.userId, req.userId!),
    )).returning({ id: memoriesTable.id });
    return Boolean(memory);
  });

  if (!deleted) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  // Object storage is deliberately not deleted here. A photo can also be
  // referenced by another feature, so association removal is the safe default.
  res.sendStatus(204);
});

export default router;