import { proposeHabitAdaptation, type MissedReason } from "./aiRules";
import type { TimeCategory } from "./trackedDay";

export interface CoachRecord {
  date: string;
  completed: boolean;
  difficulty: string | null;
  missedReason: MissedReason | null;
}
export interface CoachHabit {
  id: number;
  title: string;
  category: string;
  goalType: "build" | "quit";
  unit: "minutes" | "pages" | "count" | "custom";
  targetValue: number;
  desiredTarget?: number | null;
  desiredUnit?: CoachHabit["unit"] | null;
  minimumValue: number | null;
  busyDayValue: number | null;
  successLimitValue: number | null;
  baselineValue: number | null;
  minimumFloor: number | null;
  history: CoachRecord[];
  numericHistory: CoachRecord[];
}
export interface CoachDay {
  date: string;
  totalMinutes: number;
  categories: { category: TimeCategory; minutes: number; percentage: number }[];
  entries: { category: string; source: string; startTime: Date | null; durationMinutes: number }[];
}

/** Categorized, confirmed intervals only. Clock time, pauses and gaps are not activities. */
export function timePatterns(day: CoachDay, timezone: string) {
  const buckets = new Map<string, { category: TimeCategory; start: number; minutes: number; records: number }>();
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", hourCycle: "h23",
  }); } catch { return []; }
  const hour = (instant: Date) => Number(formatter.format(instant));
  for (const entry of day.entries) {
    if (entry.source !== "check_in" || !entry.startTime || entry.category === "unknown") continue;
    const touched = new Set<string>();
    for (let minute = 0; minute < Math.min(1440, entry.durationMinutes); minute++) {
      const start = Math.floor(hour(new Date(entry.startTime.getTime() + minute * 60000)) / 3) * 3;
      const key = `${entry.category}:${start}`;
      const bucket = buckets.get(key) ?? { category: entry.category as TimeCategory, start, minutes: 0, records: 0 };
      bucket.minutes++;
      if (!touched.has(key)) { bucket.records++; touched.add(key); }
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].sort((a, b) => b.minutes - a.minutes).map(b => ({
    ...b, end: b.start + 3,
    period: `${String(b.start).padStart(2, "0")}:00–${String(b.start + 3).padStart(2, "0")}:00`,
  }));
}

export function coachHabitAdjustment(habits: CoachHabit[]) {
  for (const habit of habits) {
    const proposal = proposeHabitAdaptation({
      ...habit, checkins: habit.history, numericCheckins: habit.numericHistory,
    });
    const action = proposal.targetValue > habit.targetValue ? "increase" as const
      : proposal.targetValue < habit.targetValue ? "decrease" as const
      : proposal.missedReason === "forgot" ? "reschedule" as const
      : proposal.busyDayValue !== habit.busyDayValue || proposal.missedReason === "no_time"
        || proposal.missedReason === "lost_motivation" ? "simplify" as const : "maintain" as const;
    if (action === "maintain") continue;
    const progress = proposal.reason === "repeated_easy" || proposal.reason === "consistent_completion";
    const reason = action === "increase" || action === "decrease"
      ? progress ? "سجلات الالتزام الحالية تدعم خطوة تدريجية في الهدف؛ القرار لك."
        : "تكررت صعوبة الالتزام في الخطة الحالية؛ بداية أخف قد تساعد دون التخلي عن هدفك."
      : action === "reschedule" ? "ذكرت النسيان في تسجيل سابق؛ يمكنك اختيار إشارة أو وقت يناسبك."
      : proposal.missedReason === "lost_motivation" ? "ذكرت تراجع الدافع؛ يمكنك تجربة أصغر خطوة في العادة التي اخترتها."
      : "ذكرت ضيق الوقت؛ جرّب نسخة اليوم المزدحم بدل التخلي عن العادة.";
    return { habitId: habit.id, habitTitle: habit.title, currentTarget: habit.targetValue,
      suggestedTarget: proposal.targetValue, unit: habit.unit, reason, action };
  }
  return null;
}

/** One normalized object drives all consumers and the provider, never a raw database dump. */
export function buildDayCoach(day: CoachDay, timezone: string, habits: CoachHabit[],
  labels: Record<TimeCategory, string>) {
  const patterns = timePatterns(day, timezone);
  const enough = day.totalMinutes >= 60 && day.entries.filter(e => e.source === "check_in" && e.startTime).length >= 3;
  const leader = day.categories.find(c => c.category !== "unknown");
  const focus = enough ? day.categories.find(c =>
    ["social_media", "gaming", "entertainment"].includes(c.category) && c.minutes >= 60) : undefined;
  const suggestedChange = focus ? { category: focus.category,
    minutes: Math.min(20, Math.max(10, Math.round(focus.minutes * .1))) } : null;
  const focused = patterns.find(p => ["study", "work"].includes(p.category) && p.minutes >= 30);
  const recoveryPeriod = patterns.find(p => p.category === focus?.category && p.minutes >= 30);
  const peak = patterns.find(p => p.category === leader?.category && p.minutes >= 30);
  const habitAdjustment = coachHabitAdjustment(habits);
  const consistent = habits.map(h => ({ ...h, count: h.history.length,
    completed: h.history.filter(r => r.completed).length }))
    .filter(h => h.count >= 3 && h.completed > 0).sort((a, b) => b.completed - a.completed)[0];
  const insights = [
    focused ? { type: "focus" as const, label: "أكثر فترة دراسة أو عمل مسجّلة", value: focused.period,
      evidence: `${focused.minutes} دقيقة من ${labels[focused.category]}؛ التسجيل لا يقيس جودة التركيز.` }
      : { type: "insufficient" as const, label: "فترة التركيز", value: "لم تتضح بعد",
        evidence: "نحتاج إلى تسجيلات مؤقتة للدراسة أو العمل؛ لا نفترض أن الوقت غير المسجّل كان متاحًا." },
    leader ? { type: "dominant_activity" as const, label: "أكثر نشاط أخذ من وقتك", value: `${labels[leader.category]} — ${leader.minutes} دقيقة`,
      evidence: `${leader.percentage}% من الوقت المسجّل فقط، لا من يومك الكامل.` }
      : { type: "insufficient" as const, label: "توزيع وقتك", value: "لا توجد أنشطة محددة بعد", evidence: "سجّل نشاطًا تعرفه حتى نستطيع فهم يومك." },
    consistent ? { type: "consistency" as const, label: "شيء جيد حافظت عليه", value: `${consistent.title} — ${consistent.completed}/${consistent.count}`,
      evidence: "نجاحات ضمن التسجيلات والأيام المجدولة المعروفة في آخر سبعة أيام؛ لا نفترض شيئًا عن التاريخ غير المسجّل." }
      : { type: "insufficient" as const, label: "الالتزام", value: "نحتاج إلى مزيد من الأيام",
        evidence: "نحتاج إلى يوم إضافي من التتبع حتى نكتشف نمطك بشكل أدق." },
  ];
  const replacements = suggestedChange ? [
    { title: "القراءة", category: "study" as const, reason: "جلسة قصيرة مع كتاب تختاره." },
    { title: "المشي", category: "exercise" as const, reason: "خطوة خفيفة تناسب الوقت الذي اخترته." },
    { title: "التنفس", category: "personal" as const, reason: "استراحة قصيرة بإيقاع يناسبك." },
    { title: "التعلم", category: "study" as const, reason: "درس صغير في موضوع يهمك." },
    { title: "هواية", category: "personal" as const, reason: "مساحة قصيرة لهواية تختارها." },
  ].map(r => ({ ...r, minutes: suggestedChange.minutes })) : [];
  const observation = leader
    ? `خصصت ${leader.minutes} دقيقة لـ${labels[leader.category]}، أي ${leader.percentage}% من وقتك المسجّل.`
    : `سجّلت ${day.totalMinutes} دقيقة، لكن الأنشطة المحددة لا تكفي لفهم توزيعها.`;
  const pattern = peak ? `سُجّلت ${peak.minutes} دقيقة من ${labels[peak.category]} بين ${peak.period}. هذه ملاحظة من هذا اليوم، وليست إثباتًا لروتين متكرر.`
    : "لا توجد تسجيلات مؤقتة كافية لاستخلاص فترة واضحة، ولا نستنتج روتينًا من الوقت اليدوي.";
  const opportunity = suggestedChange
    ? `يمكنك تجربة استعادة ${suggestedChange.minutes} دقيقة من ${labels[suggestedChange.category]}؛ اقتراح صغير وليس وقتًا مستعادًا بالفعل.`
    : habitAdjustment?.reason ?? "حافظ على ما يناسبك؛ لا نحتاج إلى فرض تغيير.";
  const bestTimeSuggestion = recoveryPeriod ? {
    start: `${String(recoveryPeriod.start).padStart(2, "0")}:00`,
    end: `${String(recoveryPeriod.end).padStart(2, "0")}:00`,
    reason: `يمكن تجربة البديل في هذه الفترة بدل جزء من ${labels[recoveryPeriod.category]} المسجّل؛ ليست فترة فراغ مؤكدة.`,
  } : null;
  const recommendation = suggestedChange ? { type: "reduce_time" as const,
    minutesToRecover: suggestedChange.minutes, reason: opportunity, confidence: "low" as const }
    : habitAdjustment ? { type: "adjust_habit" as const, minutesToRecover: 0,
      reason: habitAdjustment.reason, confidence: "medium" as const }
      : { type: enough ? "maintain" as const : "none" as const, minutesToRecover: 0,
        reason: enough ? "لا يظهر تغيير ضروري من البيانات المتاحة." : "نحتاج إلى مزيد من التسجيلات قبل اقتراح تغيير.", confidence: "low" as const };
  return {
    status: enough ? "ready" as const : "insufficient" as const,
    headline: enough ? "يومك يمنحك صورة أوضح" : "ما زلنا نتعرّف إلى يومك",
    observation, pattern, opportunity, suggestedChange, replacements, insights, recommendation,
    habitAdjustment, bestTimeSuggestion, trackedMinutes: day.totalMinutes,
    tomorrowSuggestion: suggestedChange ? `جرّب البديل لمدة ${suggestedChange.minutes} دقيقة غدًا، ثم سجّل كيف كان مناسبًا لك.`
      : habitAdjustment ? "راجع الاقتراح واختر ما يناسبك، دون تغيير تلقائي لخطة اليوم."
        : "واصل التسجيل على راحتك؛ لا نملأ الفجوات أو نفترض أن كل يوم يشبه الآخر.",
    actionable: !!suggestedChange || !!habitAdjustment,
    timePatterns: patterns,
  };
}