import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, habitsTable, checkinsTable, timeEntriesTable, type CheckinRow } from "@workspace/db";
import {
  GetDashboardTodayResponse,
  GetDashboardCalendarQueryParams,
  GetDashboardCalendarResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { xpToNextLevel, isScheduledOn } from "../lib/rules";
import { todayInTimezone } from "../lib/dates";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/dashboard/today", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const today = todayInTimezone(user.timezone);
  const todayDate = new Date(`${today}T00:00:00Z`);

  const habits = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.userId, req.userId!), eq(habitsTable.isActive, true)));

  const todaysCheckins = await db
    .select()
    .from(checkinsTable)
    .where(and(eq(checkinsTable.userId, req.userId!), eq(checkinsTable.date, today)));
  const checkinByHabit = new Map(todaysCheckins.map((c) => [c.habitId, c]));

  const timeEntriesToday = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.userId, req.userId!), eq(timeEntriesTable.date, today)));
  const timeTrackedMinutesToday = timeEntriesToday.reduce((sum, e) => sum + e.durationMinutes, 0);

  const habitsToday = habits.map((h) => {
    const scheduledToday = isScheduledOn(h.cadence, h.customDays, todayDate);
    const checkin = checkinByHabit.get(h.id);
    return {
      habitId: h.id,
      title: h.title,
      emoji: h.emoji,
      unit: h.unit,
      targetValue: h.targetValue,
      completedToday: !!checkin?.completed,
      valueToday: checkin?.value ?? null,
      currentStreak: h.currentStreak,
      scheduledToday,
    };
  });

  res.json(
    GetDashboardTodayResponse.parse({
      date: today,
      activeHabitsCount: habits.length,
      completedTodayCount: habitsToday.filter((h) => h.completedToday).length,
      scheduledTodayCount: habitsToday.filter((h) => h.scheduledToday).length,
      timeTrackedMinutesToday,
      coins: user.coins,
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel(user.level),
      habitsToday,
    }),
  );
});

router.get("/dashboard/calendar", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = GetDashboardCalendarQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const [yearStr, monthStr] = query.data.month.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!yearStr || !monthStr || !year || !month || month < 1 || month > 12) {
    res.status(400).json({ error: "Invalid month format, expected YYYY-MM" });
    return;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${yearStr}-${monthStr}-01`;
  const to = `${yearStr}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  const habits = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.userId, req.userId!), eq(habitsTable.isActive, true)));

  const checkins = await db
    .select()
    .from(checkinsTable)
    .where(
      and(
        eq(checkinsTable.userId, req.userId!),
        eq(checkinsTable.completed, true),
        gte(checkinsTable.date, from),
        lte(checkinsTable.date, to),
      ),
    );

  const timeEntries = await db
    .select()
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.userId, req.userId!),
        gte(timeEntriesTable.date, from),
        lte(timeEntriesTable.date, to),
      ),
    );

  const checkinsByDate = new Map<string, CheckinRow[]>();
  for (const c of checkins) {
    const arr = checkinsByDate.get(c.date) ?? [];
    arr.push(c);
    checkinsByDate.set(c.date, arr);
  }
  const minutesByDate = new Map<string, number>();
  for (const e of timeEntries) {
    minutesByDate.set(e.date, (minutesByDate.get(e.date) ?? 0) + e.durationMinutes);
  }

  const days = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, "0")}`;
    const dateObj = new Date(`${dateStr}T00:00:00Z`);
    const scheduledCount = habits.filter((h) => isScheduledOn(h.cadence, h.customDays, dateObj)).length;
    days.push({
      date: dateStr,
      completedCount: checkinsByDate.get(dateStr)?.length ?? 0,
      scheduledCount,
      timeMinutes: minutesByDate.get(dateStr) ?? 0,
    });
  }

  res.json(GetDashboardCalendarResponse.parse(days));
});

export default router;
