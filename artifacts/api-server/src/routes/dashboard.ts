import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  db, habitsTable, checkinsTable, timeEntriesTable, journeyRewardsTable,
  usersTable, type CheckinRow,
} from "@workspace/db";
import {
  GetDashboardTodayResponse,
  GetDashboardCalendarQueryParams,
  GetDashboardCalendarResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { xpToNextLevel, isScheduledOn } from "../lib/rules";
import { suggestedJourneyStartDate, todayInTimezone } from "../lib/dates";
import { DashboardSnapshotError, getDashboardHabitsToday } from "../lib/dashboardService";
import { synchronizeJourneyCompletion } from "../lib/journeyRewardService";
import { HABIT_JOURNEY_LENGTH } from "../lib/habitJourney";

const router: IRouter = Router();
router.use(requireAuth);

async function journeyRewardCards(userId: string, now: Date) {
  const rows = await db.select({
    rewardId: journeyRewardsTable.id,
    habitId: habitsTable.id,
    habitTitle: habitsTable.title,
  }).from(journeyRewardsTable).innerJoin(
    habitsTable,
    eq(journeyRewardsTable.habitId, habitsTable.id),
  ).where(and(
    eq(journeyRewardsTable.userId, userId),
    eq(habitsTable.userId, userId),
    eq(habitsTable.isActive, true),
  ));
  const cards = [];
  for (const row of rows) {
    const card = await db.transaction(async (tx) => {
      const [user] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, userId)).for("update");
      if (!user) return null;
      const [habit] = await tx.select().from(habitsTable).where(and(
        eq(habitsTable.id, row.habitId),
        eq(habitsTable.userId, userId),
        eq(habitsTable.isActive, true),
      )).for("update");
      if (!habit || habit.journeyStartDate == null || habit.journeyLength !== HABIT_JOURNEY_LENGTH) {
        return null;
      }
      const [reward] = await tx.select().from(journeyRewardsTable).where(and(
        eq(journeyRewardsTable.id, row.rewardId),
        eq(journeyRewardsTable.userId, userId),
        eq(journeyRewardsTable.habitId, habit.id),
      )).for("update");
      if (!reward) return null;
      const synchronized = await synchronizeJourneyCompletion(
        tx,
        userId,
        habit,
        todayInTimezone(user.timezone, now),
        now,
      );
      if (!synchronized.reward) return null;
      const currentDay = Math.max(0, Math.min(HABIT_JOURNEY_LENGTH, synchronized.lifecycle.calendarDay));
      return {
        habitId: habit.id,
        habitTitle: habit.title,
        title: synchronized.reward.title,
        type: synchronized.reward.type,
        status: synchronized.reward.status,
        currentDay,
        daysRemaining: Math.max(0, HABIT_JOURNEY_LENGTH - currentDay),
        progressPercent: Math.round((currentDay / HABIT_JOURNEY_LENGTH) * 100),
        imageUrl: synchronized.reward.imageUrl,
      };
    });
    if (card) cards.push(card);
  }
  return cards;
}

router.get("/dashboard/today", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const now = new Date();
  const today = todayInTimezone(user.timezone, now);
  let habitsToday: Awaited<ReturnType<typeof getDashboardHabitsToday>>;
  try {
    habitsToday = await getDashboardHabitsToday(req.userId!, today);
  } catch (error) {
    if (!(error instanceof DashboardSnapshotError)) throw error;
    res.status(500).json({ error: error.message });
    return;
  }

  const timeEntriesToday = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.userId, req.userId!), eq(timeEntriesTable.date, today)));
  const timeTrackedMinutesToday = timeEntriesToday.reduce((sum, e) => sum + e.durationMinutes, 0);
  const realRewards = await journeyRewardCards(req.userId!, now);

  res.json(
    GetDashboardTodayResponse.parse({
      date: today,
      suggestedJourneyStartDate: suggestedJourneyStartDate(user.timezone, now),
      activeHabitsCount: habitsToday.length,
      completedTodayCount: habitsToday.filter((h) => h.completedToday).length,
      scheduledTodayCount: habitsToday.filter((h) => h.scheduledToday).length,
      timeTrackedMinutesToday,
      coins: user.coins,
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel(user.level),
      habitsToday,
      realRewards,
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
