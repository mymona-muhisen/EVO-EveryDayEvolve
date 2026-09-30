import { and, eq } from "drizzle-orm";
import { db, timeEntriesTable, type TimeEntryRow } from "@workspace/db";
import { geminiProvider } from "./gemini";
import { logger } from "./logger";
import { z } from "zod";

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

type Day = Awaited<ReturnType<typeof getTrackedDay>>;
type Replacement = { title: string; minutes: number; category: TimeCategory };
export type AnalysisContext = {
  previousTrackedDays: { date: string; totalMinutes: number }[];
  currentHabits: { title: string; category: string; targetValue: number; goalType: string }[];
  recentDifficulty: { date: string; difficulty: string | null }[];
  missedReasons: { date: string; reason: string | null }[];
  userInterest: string | null;
};

const coachResponse = z.object({
  type: z.enum(["pattern", "progress", "opportunity", "consistency", "no_major_change"]),
  headline: z.string().trim().min(1).max(120),
  observation: z.string().trim().min(1).max(300),
  pattern: z.string().max(300).nullable(),
  suggested_change: z.object({
    minutes: z.number().nullable(), category: z.string().nullable(),
  }).nullable(),
  replacement_options: z.array(z.object({
    title: z.string().min(1).max(80), minutes: z.number().nonnegative(),
    reason: z.string().max(160),
  })).max(6),
  coach_message: z.string().trim().min(1).max(240),
});

/** All numbers and conclusions come from observed data, never from generated text. */
export async function analyzeTrackedDay(day: Day, timezone: string, context?: AnalysisContext) {
  const timedEntries = day.entries.filter(e => e.source === "check_in" && e.startTime);
  if (timedEntries.length < 3 || day.totalMinutes < 60) {
    return {
      status: "insufficient" as const,
      headline: "ما زلنا نتعرّف إلى يومك",
      observation: `سجّلت ${day.totalMinutes} دقيقة حتى الآن. نحتاج إلى ثلاثة تسجيلات سريعة و60 دقيقة على الأقل لنرى نمطًا مفيدًا.`,
      pattern: "لا توجد بيانات كافية لاستخلاص نمط موثوق.",
      opportunity: "استمر في تسجيل يومك على راحتك، دون ضغط.",
      suggestedChange: null,
      replacements: [] as Replacement[],
    };
  }

  const focus = day.categories.find(c =>
    ["social_media", "gaming", "entertainment"].includes(c.category) && c.minutes >= 60,
  );
  const suggestedChange = focus ? {
    category: focus.category, minutes: Math.min(20, Math.max(10, Math.round(focus.minutes * 0.1))),
  } : null;
  const replacements: Replacement[] = suggestedChange ? [
    { title: "القراءة", minutes: Math.min(10, suggestedChange.minutes), category: "study" },
    { title: "المشي", minutes: suggestedChange.minutes, category: "exercise" },
    { title: "الإبداع", minutes: suggestedChange.minutes, category: "personal" },
    { title: "كتابة يومياتك", minutes: Math.min(10, suggestedChange.minutes), category: "personal" },
  ] : [];
  const leader = day.topCategories.find(c => c.category !== "unknown") ?? day.topCategories[0];
  const observation = leader
    ? `خصصت ${leader.minutes} دقيقة لـ${categories[leader.category]}، أي ${leader.percentage}% من وقتك المسجّل.`
    : "ما زلنا نتعرف إلى توزيع وقتك.";

  // Use the user's saved timezone for the three-hour block; do not infer causes.
  const localHour = (instant: Date) => {
    try {
      return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(instant));
    } catch {
      return instant.getUTCHours();
    }
  };
  const timedByCategory = timedEntries.filter(e => e.category === leader?.category);
  const blocks = Array.from({ length: 8 }, () => ({ minutes: 0, count: 0 }));
  for (const entry of timedByCategory) {
    const bucket = Math.floor(localHour(entry.startTime!) / 3);
    blocks[bucket].count++;
    // Assign each elapsed minute to its actual local three-hour block, including boundary crossings.
    for (let minute = 0; minute < entry.durationMinutes; minute++) {
      const instant = new Date(entry.startTime!.getTime() + minute * 60_000);
      blocks[Math.floor(localHour(instant) / 3)].minutes++;
    }
  }
  const peakIndex = blocks.reduce((best, block, index) =>
    block.minutes > blocks[best].minutes ? index : best, 0);
  const peakStart = peakIndex * 3, peakMinutes = blocks[peakIndex].minutes;
  const avgSession = timedByCategory.length
    ? Math.round(timedByCategory.reduce((sum, e) => sum + e.durationMinutes, 0) / timedByCategory.length)
    : 0;
  const previousDay = context?.previousTrackedDays.find(d => d.date ===
    new Date(Date.parse(`${day.date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
  const comparison = previousDay
    ? ` أمس سُجّلت ${previousDay.totalMinutes} دقيقة مقابل ${day.totalMinutes} دقيقة اليوم؛ هذه مقارنة للوقت المسجّل فقط.`
    : "";
  const pattern = peakStart >= 0 && peakMinutes >= 30
    ? `ظهر ${peakMinutes} دقيقة من ${categories[leader.category]} بين ${String(peakStart).padStart(2, "0")}:00 و${String(peakStart + 3).padStart(2, "0")}:00${blocks[peakIndex].count >= 2 ? ` عبر ${blocks[peakIndex].count} تسجيلات` : ""}. متوسط مدة التسجيل ${avgSession} دقيقة.${comparison}`
    : `لم يظهر وقت محدد يتكرر فيه هذا النشاط بعد.${comparison}`;
  const fallback = {
    status: "ready" as const,
    headline: "يومك يمنحك صورة أوضح",
    observation,
    pattern,
    opportunity: suggestedChange
      ? `هل ترغب بتجربة استعادة ${suggestedChange.minutes} دقيقة من ${categories[suggestedChange.category]} غدًا؟ لا حاجة لتغيير كل شيء.`
      : "انظر إلى الأنشطة التي تهمك، وإن رغبت فاختر خطوة صغيرة للغد.",
    suggestedChange,
    replacements,
  };
  try {
    let timer!: ReturnType<typeof setTimeout>;
    const raw = await Promise.race([geminiProvider.generateText(
      'أنت مدرب داعم باللغة العربية. أعد JSON بالمفاتيح type, headline, observation, pattern, suggested_change, replacement_options, coach_message. النوع من pattern/progress/opportunity/consistency/no_major_change. أعد الأرقام والفئات كما أُرسلت فقط؛ لا تخترع أسبابًا أو روتينًا، ولا تشخّص أو تلُم المستخدم. observation وpattern وsuggested_change والبدائل Facts محسوبة مسبقًا. إن غاب اقتراح التغيير فلا تقترح تقليلًا. اختصر الرسالة.',
      { observation, pattern, suggestedChange, replacements, previousTrackedDays: context?.previousTrackedDays,
        currentHabits: context?.currentHabits, recentDifficulty: context?.recentDifficulty,
        missedReasons: context?.missedReasons, userInterest: context?.userInterest,
        topCategories: day.topCategories, totalMinutes: day.totalMinutes },
      true,
    ), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Analysis provider timed out")), 3000);
    })]).finally(() => clearTimeout(timer));
    const parsed = coachResponse.parse(JSON.parse(raw));
    // The model's observation, pattern, numbers, and replacement objects never become application facts.
    // A headline without digits prevents it from introducing a different numeric assertion.
    if (/\d|[٠-٩]|[۰-۹]/u.test(parsed.headline)) throw new Error("AI headline changed numeric facts");
    return { ...fallback, headline: parsed.headline, source: "gemini" as const };
  } catch {
    logger.warn("Time analysis phrasing unavailable; using deterministic Arabic fallback");
    return { ...fallback, source: "fallback" as const };
  }
}