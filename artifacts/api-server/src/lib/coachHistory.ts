import type { CoachRecord } from "./dayCoach";

/** Known scheduled obligations are not fabricated activity/check-ins. Never persist these observations. */
export function habitCoachingHistory(
  records: CoachRecord[],
  days: { date: string; scheduled: boolean; planRevision: number }[],
  reflections: (CoachRecord & { status: string; planRevision: number })[],
  throughDate: string,
  revision: number,
  effectiveFrom?: string,
) {
  const dayByDate = new Map(days.map(d => [d.date, d]));
  const history = new Map<string, CoachRecord>();
  for (const record of records) {
    if (record.date > throughDate || dayByDate.get(record.date)?.scheduled === false) continue;
    history.set(record.date, record);
  }
  for (const day of days) {
    if (!day.scheduled || day.date >= throughDate || history.has(day.date)) continue;
    const reflection = reflections.find(r => r.date === day.date);
    history.set(day.date, { date: day.date, completed: reflection?.status.startsWith("completed") ?? false,
      difficulty: reflection?.difficulty ?? null, missedReason: reflection?.missedReason ?? null });
  }
  const ordered = [...history.values()].sort((a, b) => a.date.localeCompare(b.date));
  const numeric = ordered.filter(r => dayByDate.has(r.date)
    ? dayByDate.get(r.date)!.planRevision === revision
    : (effectiveFrom != null && r.date >= effectiveFrom));
  return { history: ordered, numericHistory: numeric };
}