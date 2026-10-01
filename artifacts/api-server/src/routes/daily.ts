import { Router, type IRouter, type Response } from "express";
import {
  GetDailyHabitDayParams,
  GetDailyOverviewQueryParams,
  ChangeDailyHabitExecutionParams,
  ChangeDailyHabitExecutionBody,
  SaveDailyHabitReflectionParams,
  SaveDailyHabitReflectionBody,
  RecordDailyAdaptationDecisionParams,
  RecordDailyAdaptationDecisionBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { coerceQueryDates, toDateOnly, todayInTimezone } from "../lib/dates";
import {
  changeDailyHabitExecution,
  DailyServiceError,
  getDailyHabitState,
  getDailyOverview,
  recordDailyAdaptationDecision,
  saveDailyHabitReflection,
} from "../lib/dailyExecutionService";

const router: IRouter = Router();
router.use(requireAuth);

function respondServiceError(res: Response, error: unknown): boolean {
  if (!(error instanceof DailyServiceError)) return false;
  res.status(error.statusCode).json({ error: error.message });
  return true;
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

router.get("/habits/:habitId/daily/:date", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  if (!isDateOnly(req.params.date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" });
    return;
  }
  const params = GetDailyHabitDayParams.safeParse(
    coerceQueryDates(req.params as Record<string, unknown>, ["date"]),
  );
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    res.json(await getDailyHabitState(
      req.userId!,
      params.data.habitId,
      toDateOnly(params.data.date),
    ));
  } catch (error) {
    if (!respondServiceError(res, error)) throw error;
  }
});

router.post("/habits/:habitId/daily/actions", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  if (!req.body || !isDateOnly(req.body.date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" });
    return;
  }
  const params = ChangeDailyHabitExecutionParams.safeParse(req.params);
  const body = ChangeDailyHabitExecutionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    res.json(await changeDailyHabitExecution(req.userId!, params.data.habitId, body.data));
  } catch (error) {
    if (!respondServiceError(res, error)) throw error;
  }
});

router.patch("/habits/:habitId/daily/:date/reflection", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  if (!isDateOnly(req.params.date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" });
    return;
  }
  const params = SaveDailyHabitReflectionParams.safeParse(
    coerceQueryDates(req.params as Record<string, unknown>, ["date"]),
  );
  const body = SaveDailyHabitReflectionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    res.json(await saveDailyHabitReflection(
      req.userId!,
      params.data.habitId,
      toDateOnly(params.data.date),
      body.data,
    ));
  } catch (error) {
    if (!respondServiceError(res, error)) throw error;
  }
});

router.post("/habits/:habitId/daily/:date/adaptation-decision", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  if (!isDateOnly(req.params.date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" });
    return;
  }
  const params = RecordDailyAdaptationDecisionParams.safeParse(
    coerceQueryDates(req.params as Record<string, unknown>, ["date"]),
  );
  const body = RecordDailyAdaptationDecisionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    res.json(await recordDailyAdaptationDecision(
      req.userId!,
      params.data.habitId,
      toDateOnly(params.data.date),
      body.data,
    ));
  } catch (error) {
    if (!respondServiceError(res, error)) throw error;
  }
});

router.get("/daily/overview", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const rawDate = req.query.date;
  if (rawDate !== undefined && !isDateOnly(rawDate)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" });
    return;
  }
  const query = GetDailyOverviewQueryParams.safeParse(
    coerceQueryDates(req.query as Record<string, unknown>, ["date"]),
  );
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const date = query.data.date ? toDateOnly(query.data.date) : todayInTimezone(user.timezone);
  try {
    res.json(await getDailyOverview(req.userId!, date));
  } catch (error) {
    if (!respondServiceError(res, error)) throw error;
  }
});

export default router;