import { and, eq } from "drizzle-orm";
import { db, timeEntriesTable, type TimeEntryRow } from "@workspace/db";
import { geminiProvider } from "./gemini";
import { logger } from "./logger";

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

/** All numbers and conclusions come from observed data, never from generated text. */
export async function analyzeTrackedDay(day: Day, timezone: string) {
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
  const hour = (entry: TimeEntryRow) => {
    try {
      return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(entry.startTime!));
    } catch {
      return entry.startTime!.getUTCHours();
    }
  };
  const timedByCategory = timedEntries.filter(e => e.category === leader?.category);
  let peakStart = -1, peakMinutes = 0;
  for (let h = 0; h < 24; h++) {
    const minutes = timedByCategory.filter(e => {
      const localHour = hour(e);
      return localHour >= h && localHour < h + 3;
    }).reduce((sum, e) => sum + e.durationMinutes, 0);
    if (minutes > peakMinutes) { peakStart = h; peakMinutes = minutes; }
  }
  const pattern = peakStart >= 0 && peakMinutes >= 30
    ? `من وقت ${categories[leader.category]} المسجّل، ظهرت ${peakMinutes} دقيقة بين ${String(peakStart).padStart(2, "0")}:00 و${String(Math.min(peakStart + 3, 24)).padStart(2, "0")}:00.`
    : "لم يظهر وقت محدد يتكرر فيه هذا النشاط بعد.";
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
    const raw = await geminiProvider.generateText(
      'أنت مدرب سلوكي داعم بالعربية الفصحى. البيانات والأرقام والاستنتاجات المرفقة حُسبت مسبقًا. أعد JSON فقط يحتوي headline وpattern وopportunity كنصوص قصيرة. لا تغيّر الأرقام، لا تخترع أسبابًا أو معلومات، لا تشخّص أو تخجل المستخدم. استند حصريًا إلى observation وpattern وsuggestedChange المرفقة. إذا لا يوجد تغيير مقترح فلا تطلب تقليل الوقت.',
      { observation, pattern, suggestedChange, topCategories: day.topCategories, totalMinutes: day.totalMinutes },
      true,
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" ||
      !("headline" in parsed) || typeof parsed.headline !== "string" || !parsed.headline.trim() ||
      !("pattern" in parsed) || typeof parsed.pattern !== "string" || !parsed.pattern.trim() ||
      !("opportunity" in parsed) || typeof parsed.opportunity !== "string" || !parsed.opportunity.trim()) {
      throw new Error("Invalid analysis text");
    }
    return { ...fallback, headline: parsed.headline, pattern: parsed.pattern, opportunity: parsed.opportunity };
  } catch {
    logger.warn("Time analysis phrasing unavailable; using deterministic Arabic fallback");
    return fallback;
  }
}