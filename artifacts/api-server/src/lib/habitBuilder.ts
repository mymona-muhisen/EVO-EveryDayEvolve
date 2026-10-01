import type { HabitBuilderInput } from "@workspace/api-zod";
import { buildHabitTargets } from "./aiRules";

type BuilderInput = HabitBuilderInput;
type Category = "health" | "learning" | "productivity" | "mindfulness" | "social" | "creativity" | "finance" | "custom";
type Unit = "minutes" | "count" | "pages" | "custom";

export interface HabitBuilderPlan {
  title: string;
  category: Category;
  goalType: "build" | "quit";
  unit: Unit;
  originalGoal: string;
  understoodGoal: string;
  baselineValue: number | null;
  targetValue: number;
  minimumValue: number;
  busyDayValue: number;
  successLimitValue: number | null;
  minimumFloor: number;
  cueType: "time" | "routine" | "custom" | null;
  cueTime: string | null;
  cue: string | null;
  startAction: string | null;
  frictionTip: string;
  needsBaseline: boolean;
  reason: string;
  source: "ai" | "deterministic";
}

const categoryKeywords: Record<Category, RegExp> = {
  health: /exercise|workout|walk|run|gym|water|drink|sleep|fitness|رياض|تمرين|مشي|ماء|اشرب|نوم|أنام|النوم/u,
  learning: /read|reading|book|study|learn|مذاكر|دراسة|أدرس|تعلم|قراءة|اقرأ|كتاب/u,
  productivity: /tiktok|tik\s*tok|social\s*media|instagram|youtube|screen|تيك\s*توك|تكتوك|سوشال|التواصل|الشاشة/u,
  mindfulness: /meditat|mindful|تنفس|تأمل|اليقظة/u,
  social: /friend|family|call|صديق|أصدقاء|عائلة|اتصل/u,
  creativity: /draw|paint|write|music|رسم|كتابة|موسيقى|إبداع/u,
  finance: /save|budget|money|ادخار|مال|ميزانية/u,
  custom: /$a/,
};

const reduceIntent = /reduce|less|quit|stop|cut\s+down|avoid|limit|تقليل|قلل|أقلل|أخفف|أخفّف|خفف|أوقف|اتوقف|أقلع/u;

function textCategory(text: string): Category {
  const normalized = text.toLocaleLowerCase();
  for (const category of Object.keys(categoryKeywords) as Category[]) {
    if (category !== "custom" && categoryKeywords[category].test(normalized)) return category;
  }
  return "custom";
}

function inferredUnit(text: string, supplied: Unit): Unit {
  if (/page|pages|صفحة|صفحات/u.test(text)) return "pages";
  if (/hour|minute|min\b|دقيقة|دقائق|ساعة|ساعات/u.test(text)) return "minutes";
  if (/glass|cup|كوب|أكواب|كأس|كؤوس/u.test(text)) return "count";
  return supplied;
}

function parseCue(text: string): Pick<HabitBuilderPlan, "cueType" | "cueTime" | "cue"> {
  const clock = text.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i);
  const arabicClock = text.match(/(?:الساعة|الساعه)\s*([٠-٩۰-۹0-9]{1,2})(?::([٠-٩۰-۹0-9]{2}))?\s*(صباحًا|صباحا|مساءً|مساء)?/u);
  const hasTimeContext = clock && (clock[0].includes(":") || !!clock[3]
    || /(?:\bat|\baround)\s*$/i.test(text.slice(0, clock.index)));
  if (clock && hasTimeContext) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? "0");
    if (clock[3]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (clock[3]?.toLowerCase() === "am" && hour === 12) hour = 0;
    return { cueType: "time", cueTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, cue: text.slice(clock.index, clock.index! + clock[0].length) };
  }
  if (arabicClock) {
    const normalize = (value: string) => value.replace(/[٠-٩۰-۹]/gu, (digit) =>
      String("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit) % 10));
    let hour = Number(normalize(arabicClock[1]));
    const minute = Number(normalize(arabicClock[2] ?? "0"));
    if (/مساء/u.test(arabicClock[3] ?? "") && hour < 12) hour += 12;
    if (/صباح/u.test(arabicClock[3] ?? "") && hour === 12) hour = 0;
    return { cueType: "time", cueTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, cue: arabicClock[0] };
  }
  const routine = text.match(/(?:after|بعد)\s+(?:my\s+)?(?:morning\s+)?(?:coffee|tea|breakfast|قهوة|الشاي|الفطور|الإفطار)[^,.]*/iu);
  if (routine) return { cueType: "routine", cueTime: null, cue: routine[0].trim() };
  return { cueType: null, cueTime: null, cue: null };
}

function startActionFor(text: string, category: Category): string | null {
  const normalized = text.toLocaleLowerCase();
  if (/read|reading|book|قراءة|اقرأ|كتاب/u.test(normalized)) return "افتح الكتاب الذي اخترته";
  if (/study|learn|دراسة|أدرس|مذاكر/u.test(normalized)) return "افتح المادة التي اخترتها";
  if (/exercise|workout|walk|run|رياض|تمرين|مشي/u.test(normalized)) return "جهّز ما تحتاجه للتمرين";
  if (/water|drink|ماء|اشرب/u.test(normalized)) return "جهّز كوب ماء";
  if (category === "productivity" && reduceIntent.test(normalized)) return "ابدأ بتقليل الاستخدام في الفترة التي تختارها";
  if (/sleep|نوم|أنام|النوم/u.test(normalized)) return "جهّز مكانًا مريحًا للنوم";
  return null;
}

export function habitBuilderFrictionTip(friction?: string): string {
  const normalized = friction?.trim().toLocaleLowerCase() ?? "";
  if (!normalized) return "";
  if (/phone|mobile|notification|distraction|هاتف|جوال|تشتيت|إشعار/u.test(normalized)) {
    return "أبعد الهاتف عن مكان تنفيذ الخطوة لتقليل التشتيت.";
  }
  if (/time|busy|schedule|وقت|مشغول|انشغال/u.test(normalized)) {
    return "اجعل الخطوة أقصر لتناسب الوقت المتاح.";
  }
  if (/tired|fatigue|energy|exhaust|تعب|إرهاق|طاقة/u.test(normalized)) {
    return "اختر نسخة أخف تناسب طاقتك المتاحة.";
  }
  if (/what to (read|choose)|don't know|not sure|حيرة|ماذا أقرأ|ماذا اختار/u.test(normalized)) {
    return "اختر ما ستبدأ به مسبقًا لتقليل حيرة الاختيار.";
  }
  if (/environment|place|space|location|بيئة|مكان/u.test(normalized)) {
    return "جهّز المكان المناسب للخطوة مسبقًا.";
  }
  return "قسّم العائق الذي ذكرته إلى أصغر خطوة يسهل البدء بها.";
}

export function matchedTrackingCategories(text: string, category: Category): string[] {
  const normalized = text.toLocaleLowerCase();
  if (/tiktok|tik\s*tok|instagram|social\s*media|تيك\s*توك|تكتوك|التواصل/u.test(normalized)) {
    return ["social_media", "gaming", "entertainment"];
  }
  if (/study|read|reading|مذاكر|دراسة|أدرس|قراءة|اقرأ/u.test(normalized) || category === "learning") return ["study"];
  if (/exercise|workout|walk|run|رياض|تمرين|مشي/u.test(normalized)) return ["exercise"];
  if (/sleep|نوم|أنام|النوم/u.test(normalized)) return ["rest"];
  if (/work|job|عمل/u.test(normalized)) return ["work"];
  return [];
}

export function makeHabitBuilderPlan(input: BuilderInput, trackedBaseline: number | null = null): HabitBuilderPlan {
  const intent = input.intent.trim();
  const lower = intent.toLocaleLowerCase();
  const goalType = input.goalType ?? (reduceIntent.test(lower) ? "quit" : "build");
  const category = input.trackingContext?.category ?? textCategory(intent);
  const unit = input.trackingContext?.unit ?? inferredUnit(intent, input.unit);
  const explicitlyProvidedBaseline = input.baselineValue;
  const baselineValue = explicitlyProvidedBaseline ?? trackedBaseline;
  const cue = parseCue(intent);
  const frictionTip = habitBuilderFrictionTip(input.friction);
  if (goalType === "quit" && baselineValue == null) {
    return {
      title: intent, category, goalType, unit, originalGoal: intent, understoodGoal: intent,
      baselineValue: null, targetValue: 0, minimumValue: 0, busyDayValue: 0,
      successLimitValue: null, minimumFloor: 0, ...cue,
      startAction: startActionFor(intent, category), frictionTip, needsBaseline: true,
      reason: "لا نعرف خط الأساس بعد. أدخل مقدار الاستخدام الحالي أو سجّل بيانات مناسبة قبل تحديد هدف التخفيض.",
      source: "deterministic",
    };
  }

  if (goalType === "quit") {
    const baseline = Math.max(0, baselineValue ?? 0);
    const targetValue = Math.max(0, Math.floor(baseline * 0.75));
    const successLimitValue = Math.max(targetValue, Math.floor(baseline * 0.9));
    return {
      title: intent, category, goalType, unit, originalGoal: intent, understoodGoal: intent,
      baselineValue: baseline, targetValue, minimumValue: targetValue,
      busyDayValue: Math.min(targetValue, Math.floor(targetValue * 0.5)),
      successLimitValue, minimumFloor: 0, ...cue,
      startAction: startActionFor(intent, category), frictionTip, needsBaseline: false,
      reason: "الحد الحالي يستند إلى خط الأساس الذي أكدته، وتبدأ الخطة بخفض تدريجي يمكن مراجعته.",
      source: "deterministic",
    };
  }

  const safeTargets = buildHabitTargets(input.requestedDuration);
  const requestedFloor = Math.min(safeTargets.targetValue, Math.max(1, Math.floor(safeTargets.targetValue * 0.2)));
  return {
    title: intent, category, goalType, unit, originalGoal: intent, understoodGoal: intent,
    baselineValue: explicitlyProvidedBaseline ?? null,
    ...safeTargets, successLimitValue: null, minimumFloor: requestedFloor, ...cue,
    startAction: startActionFor(intent, category), frictionTip, needsBaseline: false,
    reason: "اقتراح تدريجي محدود من المدة المطلوبة؛ لم تُضف الخطة وقتًا أو روتينًا غير مذكور.",
    source: "deterministic",
  };
}