import { createHash } from "node:crypto";
import { and, eq, gte, lt, lte, inArray, desc } from "drizzle-orm";
import {
  db, dayAnalysisCacheTable, habitsTable, checkinsTable, timeEntriesTable,
  habitDaysTable, habitDailyExecutionsTable, habitPlanRevisionsTable,
} from "@workspace/db";
import { GetTrackedDayAnalysisResponse } from "@workspace/api-zod";
import { analyzeTrackedDay, getTrackedDay } from "./trackedDay";
import { habitCoachingHistory } from "./coachHistory";
import type { CoachHabit } from "./dayCoach";

const pending = new Map<string, Promise<ReturnType<typeof GetTrackedDayAnalysisResponse.parse>>>();

async function readAnalysisInputs(userId: string, date: string, timezone: string, interest: string | null) {
  const earliest = new Date(`${date}T12:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 7);
  const from = earliest.toISOString().slice(0, 10);
  const [day, previousEntries, habits, recentCheckins] = await Promise.all([
    getTrackedDay(userId, date),
    db.select().from(timeEntriesTable).where(and(eq(timeEntriesTable.userId, userId),
      gte(timeEntriesTable.date, from), lt(timeEntriesTable.date, date))),
    db.select()
      .from(habitsTable).where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true)))
      .orderBy(habitsTable.id).limit(12),
    db.select({ habitId: checkinsTable.habitId, date: checkinsTable.date, completed: checkinsTable.completed,
      difficulty: checkinsTable.difficulty, missedReason: checkinsTable.missedReason })
      .from(checkinsTable).where(and(eq(checkinsTable.userId, userId),
      gte(checkinsTable.date, from), lte(checkinsTable.date, date))),
  ]);
  const selectedHabits = habits.slice(0, 12);
  const ids = selectedHabits.map(h => h.id);
  const [savedDays, reflections, revisions] = ids.length ? await Promise.all([
    db.select({ habitId: habitDaysTable.habitId, date: habitDaysTable.date, scheduled: habitDaysTable.scheduled,
      planRevision: habitDaysTable.planRevision }).from(habitDaysTable).where(and(
        inArray(habitDaysTable.habitId, ids), gte(habitDaysTable.date, from), lte(habitDaysTable.date, date))),
    db.select({ habitId: habitDailyExecutionsTable.habitId, date: habitDailyExecutionsTable.date,
      difficulty: habitDailyExecutionsTable.difficulty, missedReason: habitDailyExecutionsTable.missedReason,
      status: habitDailyExecutionsTable.status, planRevision: habitDailyExecutionsTable.planRevision })
      .from(habitDailyExecutionsTable).where(and(inArray(habitDailyExecutionsTable.habitId, ids),
        gte(habitDailyExecutionsTable.date, from), lte(habitDailyExecutionsTable.date, date))),
    db.select({ habitId: habitPlanRevisionsTable.habitId, revision: habitPlanRevisionsTable.revision,
      effectiveFrom: habitPlanRevisionsTable.effectiveFrom }).from(habitPlanRevisionsTable)
      .where(inArray(habitPlanRevisionsTable.habitId, ids)).orderBy(desc(habitPlanRevisionsTable.revision)),
  ]) : [[], [], []];
  const sevenDayFrom = new Date(Date.parse(`${date}T12:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const currentHabits: CoachHabit[] = selectedHabits.map(h => {
    const revision = revisions.find(r => r.habitId === h.id);
    const records = recentCheckins.filter(r => r.habitId === h.id && r.date >= sevenDayFrom);
    const days = savedDays.filter(r => r.habitId === h.id && r.date >= sevenDayFrom);
    const reflected = reflections.filter(r => r.habitId === h.id)
      .map(r => ({ ...r, completed: r.status.startsWith("completed") }));
    const observations = habitCoachingHistory(records, days, reflected, date, revision?.revision ?? 0, revision?.effectiveFrom);
    return { id: h.id, title: h.title, category: h.category, unit: h.unit, goalType: h.goalType,
      desiredTarget: h.desiredTarget, desiredUnit: h.desiredUnit,
      targetValue: h.targetValue, minimumValue: h.minimumValue, busyDayValue: h.busyDayValue,
      successLimitValue: h.successLimitValue, baselineValue: h.baselineValue, minimumFloor: h.minimumFloor, ...observations };
  });
  const days = new Map<string, number>();
  for (const entry of previousEntries) days.set(entry.date, (days.get(entry.date) ?? 0) + entry.durationMinutes);
  const previousTrackedDays = [...days].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, totalMinutes]) => ({ date, totalMinutes }));
  const reported = new Map(recentCheckins.map(r => [`${r.habitId}:${r.date}`, r]));
  for (const r of reflections) {
    const key = `${r.habitId}:${r.date}`;
    if (!reported.has(key)) reported.set(key, { ...r, completed: r.status.startsWith("completed") });
  }
  const recentObservations = [...reported.values()].sort((a, b) => a.date.localeCompare(b.date));
  const context = {
    previousTrackedDays, currentHabits,
    recentDays: previousTrackedDays.map(d => {
      const totals = new Map<string, number>();
      for (const e of previousEntries.filter(e => e.date === d.date)) totals.set(e.category, (totals.get(e.category) ?? 0) + e.durationMinutes);
      return { ...d, categories: [...totals].map(([category, minutes]) => ({ category, minutes })) };
    }),
    recentDifficulty: recentObservations.filter(c => c.difficulty)
      .map(c => ({ date: c.date, difficulty: c.difficulty })).slice(-12),
    missedReasons: recentObservations.filter(c => c.missedReason)
      .map(c => ({ date: c.date, reason: c.missedReason })).slice(-7),
  };
  const hash = createHash("sha256").update(JSON.stringify({
    version: "structured-day-coach", date, timezone, entries: day.entries.map(e => ({
      id: e.id, category: e.category, duration: e.durationMinutes,
      source: e.source, start: e.startTime?.toISOString(), end: e.endTime?.toISOString(),
    })), context,
  })).digest("hex");
  return { day, context, hash };
}

/** Pure lookup inputs for dashboard staleness; this performs reads only and never generates analysis. */
export async function getCurrentTrackedAnalysisHash(
  userId: string,
  date: string,
  timezone: string,
  interest: string | null,
) {
  return (await readAnalysisInputs(userId, date, timezone, interest)).hash;
}

/** The hash includes only inputs that can change the analysis, never user credentials. */
export async function getCachedTrackedAnalysis(userId: string, date: string, timezone: string, interest: string | null) {
  const { day, context, hash } = await readAnalysisInputs(userId, date, timezone, interest);
  const key = `${userId}:${date}:${hash}`;
  const existing = pending.get(key);
  if (existing) return existing;

  const compute = async () => {
    const [cached] = await db.select().from(dayAnalysisCacheTable).where(
      and(eq(dayAnalysisCacheTable.userId, userId), eq(dayAnalysisCacheTable.date, date)));
    // Re-attempt transient Gemini failures after a short cooldown; steady data uses the same saved result.
    if (cached?.dataHash === hash && (
      (cached.analysis as { source?: string }).source !== "fallback" ||
      Date.now() - cached.createdAt.getTime() < 15 * 60_000
    )) {
      return GetTrackedDayAnalysisResponse.parse(cached.analysis);
    }
    const result = await analyzeTrackedDay(day, timezone, context);
    await db.insert(dayAnalysisCacheTable).values({
      userId, date, dataHash: hash, analysis: result, createdAt: new Date(),
    }).onConflictDoUpdate({
      target: [dayAnalysisCacheTable.userId, dayAnalysisCacheTable.date],
      set: { dataHash: hash, analysis: result, createdAt: new Date() },
    });
    return GetTrackedDayAnalysisResponse.parse(result);
  };
  const promise = compute().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}