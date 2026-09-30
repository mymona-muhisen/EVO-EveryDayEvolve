import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, timeEntriesTable, trackingSessionsTable } from "@workspace/db";
import {
  GetTrackingSessionQueryParams, GetTrackingSessionResponse,
  ChangeTrackingSessionBody, ChangeTrackingSessionResponse,
  CreateTrackingCheckinBody, CreateTrackingCheckinResponse,
  GetTrackedDayQueryParams, GetTrackedDayResponse,
  GetTrackedDayAnalysisQueryParams, GetTrackedDayAnalysisResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { toDateOnly, coerceQueryDates } from "../lib/dates";
import { categories, getTrackedDay } from "../lib/trackedDay";
import { getCachedTrackedAnalysis } from "../lib/trackedAnalysisCache";

const router: IRouter = Router();
router.use(requireAuth);
const intervalAfter = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000);
const whereSession = (userId: string, date: string) =>
  and(eq(trackingSessionsTable.userId, userId), eq(trackingSessionsTable.date, date));

router.get("/time-tracking/session", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = GetTrackingSessionQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]));
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [session] = await db.select().from(trackingSessionsTable)
    .where(whereSession(req.userId!, toDateOnly(parsed.data.date)));
  res.json(GetTrackingSessionResponse.parse({ session: session ?? null }));
});

router.post("/time-tracking/session", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = ChangeTrackingSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { action, intervalMinutes } = parsed.data;
  if ((action === "start" || action === "interval") && !intervalMinutes) {
    res.status(400).json({ error: "Choose a 15 or 30 minute interval" }); return;
  }
  const date = toDateOnly(parsed.data.date);
  const userId = req.userId!;
  const now = new Date();
  const result = await db.transaction(async tx => {
    if (action === "start") {
      await tx.insert(trackingSessionsTable).values({
        userId, date, status: "active", intervalMinutes: intervalMinutes!,
        startedAt: now, lastCheckinAt: now, nextCheckinAt: intervalAfter(now, intervalMinutes!),
      }).onConflictDoNothing();
    }
    const [session] = await tx.select().from(trackingSessionsTable)
      .where(whereSession(userId, date)).for("update");
    if (!session) return { error: "Start tracking first", status: 404 };
    if (action === "start") {
      if (session.status !== "finished" && session.startedAt.getTime() !== now.getTime()) {
        return { error: "Tracking already started", status: 409 };
      }
      if (session.status === "finished") {
        const [updated] = await tx.update(trackingSessionsTable).set({
          status: "active", finishedAt: null, intervalMinutes: intervalMinutes!,
          lastCheckinAt: now, nextCheckinAt: intervalAfter(now, intervalMinutes!),
        }).where(eq(trackingSessionsTable.id, session.id)).returning();
        return { session: updated };
      }
      return { session };
    }
    if (action === "pause" && session.status !== "active" ||
      action === "resume" && session.status !== "paused" ||
      action === "finish" && session.status === "finished" ||
      action === "interval" && session.status === "finished") {
      return { error: "Tracking state has changed; refresh the page", status: 409 };
    }
    const changes = action === "pause" ? { status: "paused", nextCheckinAt: null } :
      action === "resume" ? { status: "active", lastCheckinAt: now,
        nextCheckinAt: intervalAfter(now, session.intervalMinutes) } :
      action === "finish" ? { status: "finished", finishedAt: now, nextCheckinAt: null } :
      { intervalMinutes: intervalMinutes!, lastCheckinAt: now,
        nextCheckinAt: session.status === "active" ? intervalAfter(now, intervalMinutes!) : null };
    const [updated] = await tx.update(trackingSessionsTable).set(changes)
      .where(eq(trackingSessionsTable.id, session.id)).returning();
    return { session: updated };
  });
  if ("error" in result) { res.status(result.status ?? 409).json({ error: result.error }); return; }
  res.json(ChangeTrackingSessionResponse.parse({ session: result.session }));
});

router.post("/time-tracking/check-in", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = CreateTrackingCheckinBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { category, label } = parsed.data;
  if (category === "other" && !label?.trim()) {
    res.status(400).json({ error: "Name the other activity" }); return;
  }
  const date = toDateOnly(parsed.data.date);
  const now = new Date();
  const result = await db.transaction(async tx => {
    const [session] = await tx.select().from(trackingSessionsTable)
      .where(whereSession(req.userId!, date)).for("update");
    if (!session || session.status !== "active" || !session.lastCheckinAt) {
      return { error: "Tracking is not active", status: 409 };
    }
    const elapsed = now.getTime() - session.lastCheckinAt.getTime();
    if (elapsed < 60_000) return { error: "Wait at least a minute between check-ins", status: 409 };
    const durationMinutes = Math.max(1, Math.min(session.intervalMinutes, Math.round(elapsed / 60_000)));
    const startTime = new Date(now.getTime() - durationMinutes * 60_000);
    const [entry] = await tx.insert(timeEntriesTable).values({
      userId: req.userId!, date, category, source: "check_in",
      label: category === "other" ? label!.trim() : categories[category],
      durationMinutes, startTime, endTime: now,
    }).returning();
    await tx.update(trackingSessionsTable).set({
      lastCheckinAt: now, nextCheckinAt: intervalAfter(now, session.intervalMinutes),
    }).where(eq(trackingSessionsTable.id, session.id));
    return { entry };
  });
  if ("error" in result) { res.status(result.status ?? 409).json({ error: result.error }); return; }
  res.status(201).json(CreateTrackingCheckinResponse.parse(result.entry));
});

router.get("/time-tracking/day", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = GetTrackedDayQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]));
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const day = await getTrackedDay(req.userId!, toDateOnly(parsed.data.date));
  res.json(GetTrackedDayResponse.parse(day));
});

router.get("/time-tracking/analysis", async (req, res): Promise<void> => {
  const parsed = GetTrackedDayAnalysisQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]));
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const user = await ensureUser(req.userId!);
  const result = await getCachedTrackedAnalysis(req.userId!, toDateOnly(parsed.data.date),
    user.timezone, user.primaryGoalCategory);
  res.json(GetTrackedDayAnalysisResponse.parse(result));
});

export default router;