import { and, eq } from "drizzle-orm";
import { db, timeEntriesTable, type TimeEntryRow } from "@workspace/db";
import { geminiProvider } from "./gemini";
import { logger } from "./logger";
import { z } from "zod";
import { buildDayCoach, type CoachHabit } from "./dayCoach";
import type { AiTextProvider } from "./aiProvider";

export const categories = {
  study: "الدراسة", work: "العمل", social_media: "وسائل التواصل",
  gaming: "الألعاب", entertainment: "الترفيه", exercise: "الرياضة",
  eating: "الطعام", rest: "الراحة", travel: "التنقل",
  socializing: "التواصل مع الآخرين", personal: "وقت شخصي",
  other: "نشاط آخر", unknown: "لا أتذكر",
} as const;
export type TimeCategory = keyof typeof categories;

export async function getTrackedDay(userId: string, date: string) {
  const entries = await db.select().from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.userId, userId), eq(timeEntriesTable.date, date)));
  entries.sort((a, b) => (a.startTime ?? a.createdAt).getTime() - (b.startTime ?? b.createdAt).getTime());
  const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
  const totals = new Map<TimeCategory, number>();
  for (const e of entries) {
    const category: TimeCategory = e.category in categories ? e.category as TimeCategory : "other";
    totals.set(category, (totals.get(category) ?? 0) + e.durationMinutes);
  }
  const grouped = [...totals].map(([category, minutes]) => ({
    category, minutes, percentage: totalMinutes ? Math.round(minutes * 100 / totalMinutes) : 0,
  })).sort((a, b) => b.minutes - a.minutes);
  return { date, totalMinutes, categories: grouped, topCategories: grouped.slice(0, 3), entries };
}

export type AnalysisContext = {
  previousTrackedDays: { date: string; totalMinutes: number }[];
  currentHabits: CoachHabit[];
  recentDifficulty: { date: string; difficulty: string | null }[];
  missedReasons: { date: string; reason: string | null }[];
  recentDays?: { date: string; totalMinutes: number; categories: { category: string; minutes: number }[] }[];
};

const headlines = ["يومك يمنحك صورة أوضح", "خطوة صغيرة تناسب يومك", "القرار لك، والبداية صغيرة"] as const;
export const dayCoachPrompt = `أنت مدرّب عربي داعم ومختصر وغير حُكمي. هدفك الملاحظة والفهم والاقتراح والتكيف والتعافي.
تستقبل ملخصًا محسوبًا فقط، وليس سجلات خاصة. لا تشخّص ولا تلُم ولا تفترض النية.
التسجيلات دليل على وقت مسجّل، لا دليل على جودة التركيز أو فراغ بقية اليوم. يوم واحد لا يثبت روتينًا.
اختر إجراءً واحدًا من supportedActions وفق الأدلة، ولا تخترع وقتًا أو أرقامًا أو أسبابًا أو تعدّل عادة.
أعد JSON فقط: headline من الخيارات المرسلة، actionIndex فهرس صحيح لإجراء مسموح، وencouragement
إحدى: "يمكنك تجربة خطوة صغيرة ثم مراجعتها." أو "احتفظ بما يناسبك، فالقرار لك.".
إن لم تكفِ البيانات اختر عدم التغيير. سجلات الصعوبة ليست حكمًا على الشخص؛ الهدف الأصلي يظل محفوظًا.`;

export async function analyzeTrackedDay(day: Awaited<ReturnType<typeof getTrackedDay>>, timezone: string, context?: AnalysisContext,
  provider: AiTextProvider = geminiProvider) {
  const { timePatterns, ...fallback } = buildDayCoach(day, timezone, context?.currentHabits ?? [], categories);
  if (fallback.status === "insufficient") return { ...fallback, source: "fallback" as const };
  const actions = [fallback.recommendation];
  if (fallback.habitAdjustment && fallback.recommendation.type !== "adjust_habit") {
    actions.push({ type: "adjust_habit", minutesToRecover: 0,
      reason: fallback.habitAdjustment.reason, confidence: "medium" });
  }
  const responseSchema = z.object({
    headline: z.enum(headlines),
    actionIndex: z.number().int().min(0).max(actions.length - 1),
    encouragement: z.enum(["يمكنك تجربة خطوة صغيرة ثم مراجعتها.", "احتفظ بما يناسبك، فالقرار لك."]),
  }).strict();
  try {
    let timer!: ReturnType<typeof setTimeout>;
    const raw = await Promise.race([provider.generateText(
      dayCoachPrompt,
      { date: day.date, trackedMinutes: day.totalMinutes,
        categories: day.categories.map(c => ({ name: categories[c.category], minutes: c.minutes, percentage: c.percentage })),
        timePatterns, habits: context?.currentHabits.map(h => ({ name: h.title, target: h.targetValue, unit: h.unit,
          desiredTarget: h.desiredTarget ?? null, desiredUnit: h.desiredUnit ?? null,
          completed: h.history.filter(c => c.completed).length, observedHabitDays: h.history.length,
          currentPlanObservations: h.numericHistory.length })),
        recentDays: context?.recentDays, recentCheckins: context?.recentDifficulty,
        recentRelapses: context?.missedReasons, supportedActions: actions, headlines },
      true,
    ), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Analysis provider timed out")), 3000);
    })]).finally(() => clearTimeout(timer));
    const parsed = responseSchema.parse(JSON.parse(raw));
    return { ...fallback, headline: parsed.headline, recommendation: actions[parsed.actionIndex],
      opportunity: `${actions[parsed.actionIndex].reason} ${parsed.encouragement}`, source: "gemini" as const };
  } catch {
    logger.warn("Time analysis phrasing unavailable; using deterministic Arabic fallback");
    return { ...fallback, source: "fallback" as const };
  }
}