import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, timeEntriesTable } from "@workspace/db";
import {
  ListTimeEntriesQueryParams,
  ListTimeEntriesResponse,
  CreateTimeEntryBody,
  CreateTimeEntryResponse,
  GetTimeEntriesSummaryQueryParams,
  GetTimeEntriesSummaryResponse,
  DeleteTimeEntryParams,
  UpdateTimeEntryParams,
  UpdateTimeEntryBody,
  UpdateTimeEntryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { toDateOnly, coerceQueryDates } from "../lib/dates";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/time-entries", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListTimeEntriesQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]),
  );
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = [eq(timeEntriesTable.userId, req.userId!)];
  if (query.data.date) conditions.push(eq(timeEntriesTable.date, toDateOnly(query.data.date)));
  if (query.data.habitId !== undefined) conditions.push(eq(timeEntriesTable.habitId, query.data.habitId));

  const entries = await db
    .select()
    .from(timeEntriesTable)
    .where(and(...conditions))
    .orderBy(timeEntriesTable.date);

  res.json(ListTimeEntriesResponse.parse(entries));
});

router.post("/time-entries", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = CreateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      userId: req.userId!,
      habitId: parsed.data.habitId ?? null,
      label: parsed.data.label,
      durationMinutes: parsed.data.durationMinutes,
      date: toDateOnly(parsed.data.date),
      note: parsed.data.note ?? null,
      category: parsed.data.category ?? "other",
      source: "manual",
    })
    .returning();

  res.status(201).json(CreateTimeEntryResponse.parse(entry));
});

router.patch("/time-entries/:timeEntryId", async (req, res): Promise<void> => {
  const params = UpdateTimeEntryParams.safeParse(req.params);
  const parsed = UpdateTimeEntryBody.safeParse(req.body);
  if (!params.success || !parsed.success || !Object.keys(parsed.data).length) {
    res.status(400).json({ error: "Invalid time entry update" });
    return;
  }
  const [current] = await db.select().from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.id, params.data.timeEntryId), eq(timeEntriesTable.userId, req.userId!)));
  if (!current) { res.status(404).json({ error: "Time entry not found" }); return; }
  if (parsed.data.durationMinutes !== undefined && current.source === "check_in") {
    res.status(400).json({ error: "Check-in duration cannot be edited; correct its activity instead" });
    return;
  }
  const [updated] = await db.update(timeEntriesTable).set(parsed.data)
    .where(and(eq(timeEntriesTable.id, params.data.timeEntryId), eq(timeEntriesTable.userId, req.userId!)))
    .returning();
  res.json(UpdateTimeEntryResponse.parse(updated));
});

router.get("/time-entries/summary", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = GetTimeEntriesSummaryQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]),
  );
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const date = toDateOnly(query.data.date);
  const entries = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.userId, req.userId!), eq(timeEntriesTable.date, date)));

  const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
  const byHabitMap = new Map<string, { habitId: number | null; label: string; minutes: number }>();
  for (const e of entries) {
    const key = e.habitId !== null ? String(e.habitId) : `label:${e.label}`;
    const existing = byHabitMap.get(key);
    if (existing) {
      existing.minutes += e.durationMinutes;
    } else {
      byHabitMap.set(key, { habitId: e.habitId, label: e.label, minutes: e.durationMinutes });
    }
  }

  res.json(
    GetTimeEntriesSummaryResponse.parse({
      date,
      totalMinutes,
      byHabit: Array.from(byHabitMap.values()),
    }),
  );
});

router.delete("/time-entries/:timeEntryId", async (req, res): Promise<void> => {
  const params = DeleteTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .delete(timeEntriesTable)
    .where(and(eq(timeEntriesTable.id, params.data.timeEntryId), eq(timeEntriesTable.userId, req.userId!)))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
