import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, habitsTable } from "@workspace/db";
import {
  ListHabitsQueryParams,
  ListHabitsResponse,
  CreateHabitBody,
  CreateHabitResponse,
  GetHabitParams,
  GetHabitResponse,
  UpdateHabitParams,
  UpdateHabitBody,
  UpdateHabitResponse,
  DeleteHabitParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/habits", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListHabitsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = [eq(habitsTable.userId, req.userId!)];
  if (query.data.isActive !== undefined) {
    conditions.push(eq(habitsTable.isActive, query.data.isActive));
  }

  const habits = await db
    .select()
    .from(habitsTable)
    .where(and(...conditions))
    .orderBy(desc(habitsTable.createdAt));

  res.json(ListHabitsResponse.parse(habits));
});

router.post("/habits", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = CreateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .insert(habitsTable)
    .values({
      userId: req.userId!,
      ...parsed.data,
      customDays: parsed.data.customDays ?? null,
      milestones: parsed.data.milestones ?? [],
    })
    .returning();

  res.status(201).json(CreateHabitResponse.parse(habit));
});

router.get("/habits/:habitId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)));

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.json(GetHabitResponse.parse(habit));
});

router.patch("/habits/:habitId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = UpdateHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .update(habitsTable)
    .set(parsed.data)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)))
    .returning();

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.json(UpdateHabitResponse.parse(habit));
});

router.delete("/habits/:habitId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = DeleteHabitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [habit] = await db
    .delete(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, req.userId!)))
    .returning();

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
