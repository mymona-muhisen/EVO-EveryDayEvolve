import { createHash } from "node:crypto";
import { and, eq, gte, lt } from "drizzle-orm";
import {
  db, dayAnalysisCacheTable, habitsTable, checkinsTable, timeEntriesTable,
} from "@workspace/db";
import { GetTrackedDayAnalysisResponse } from "@workspace/api-zod";
import { analyzeTrackedDay, getTrackedDay } from "./trackedDay";

const pending = new Map<string, Promise<ReturnType<typeof GetTrackedDayAnalysisResponse.parse>>>();

async function readAnalysisInputs(userId: string, date: string, timezone: string, interest: string | null) {
  const earliest = new Date(`${date}T12:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 7);
  const from = earliest.toISOString().slice(0, 10);
  const [day, previousEntries, habits, recentCheckins] = await Promise.all([
    getTrackedDay(userId, date),
    db.select().from(timeEntriesTable).where(and(eq(timeEntriesTable.userId, userId),
      gte(timeEntriesTable.date, from), lt(timeEntriesTable.date, date))),
    db.select({ category: habitsTable.category, title: habitsTable.title,
      targetValue: habitsTable.targetValue, goalType: habitsTable.goalType })
      .from(habitsTable).where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true))),
    db.select().from(checkinsTable).where(and(eq(checkinsTable.userId, userId),
      gte(checkinsTable.date, from), lt(checkinsTable.date, date))),
  ]);
  const days = new Map<string, number>();
  for (const entry of previousEntries) days.set(entry.date, (days.get(entry.date) ?? 0) + entry.durationMinutes);
  const previousTrackedDays = [...days].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, totalMinutes]) => ({ date, totalMinutes }));
  const context = {
    previousTrackedDays, currentHabits: habits.slice(0, 12), userInterest: interest,
    recentDifficulty: recentCheckins.filter(c => c.difficulty)
      .map(c => ({ date: c.date, difficulty: c.difficulty })).slice(-12),
    missedReasons: recentCheckins.filter(c => c.missedReason)
      .map(c => ({ date: c.date, reason: c.missedReason })).slice(-7),
  };
  const hash = createHash("sha256").update(JSON.stringify({
    date, timezone, entries: day.entries.map(e => ({
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