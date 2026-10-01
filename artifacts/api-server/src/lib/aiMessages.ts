import { logger } from "./logger";
import type { AiTextProvider } from "./aiProvider";
import { geminiProvider } from "./gemini";

// The route and rule engine only depend on these message functions. Swap the
// provider here without changing their inputs, outputs, or deterministic math.
function logFallback(): void {
  // Never log SDK error objects: some include request details or credentials.
  logger.warn({ reason: "generation_failed" }, "AI phrasing unavailable; using Arabic fallback");
}

async function safeComplete(system: string, context: object, fallback: string, provider: AiTextProvider): Promise<string> {
  try {
    return await provider.generateText(system, context);
  } catch {
    logFallback();
    return fallback;
  }
}

export interface BreakdownGoalStep {
  targetValue: number;
  order: number;
}

/** The rule engine determines all milestone numbers; the provider only phrases them. */
export async function breakdownGoalMessages(
  input: {
    title: string;
    description?: string;
    category: string;
    goalType: string;
    difficulty: string;
    unit: string;
  },
  steps: BreakdownGoalStep[],
  provider: AiTextProvider = geminiProvider,
): Promise<{ stepTexts: { title: string; description: string }[]; coachMessage: string }> {
  const fallbackStepTexts = steps.map((s, i) => ({
    title: `الخطوة ${i + 1}`,
    description: `الوصول إلى ${s.targetValue} ${input.unit}`,
  }));
  const fallbackCoach = `قسّمنا هدف "${input.title}" إلى ${steps.length} خطوات تدريجية — لنبدأ بالخطوة الأولى!`;

  try {
    const raw = await provider.generateText(
      'أنت مدرّب عادات متحمس يتحدث العربية الفصحى الحديثة. ستتلقى هدفًا وقائمة بالقيم المستهدفة الرقمية لكل خطوة (تم حسابها مسبقًا من قبل محرك قواعد، لا تغيّرها). مهمتك فقط صياغة عنوان ووصف قصيرين ومحفزين لكل خطوة، بنفس ترتيبها، بالإضافة إلى رسالة تحفيزية قصيرة واحدة. أعد JSON حصراً بالشكل: {"steps": [{"title": string, "description": string}], "coachMessage": string}',
      { ...input, steps },
      true,
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== "object" ||
      !("steps" in parsed) || !Array.isArray(parsed.steps) ||
      parsed.steps.length !== steps.length ||
      !parsed.steps.every((s: unknown) =>
        !!s && typeof s === "object" && "title" in s && typeof s.title === "string" &&
        "description" in s && typeof s.description === "string"
      ) ||
      !("coachMessage" in parsed) || typeof parsed.coachMessage !== "string"
    ) throw new Error("Malformed goal breakdown response");
    return {
      stepTexts: parsed.steps as { title: string; description: string }[],
      coachMessage: parsed.coachMessage,
    };
  } catch {
    logFallback();
    return { stepTexts: fallbackStepTexts, coachMessage: fallbackCoach };
  }
}

/** Rule engine computes the trend/metric; this only phrases the insight. */
export async function dailyInsightMessage(facts: {
  displayName: string;
  trend: "up" | "down" | "steady";
  highlightMetric: string;
  completionRateThisWeek: number;
  completionRatePrevWeek: number;
}, provider: AiTextProvider = geminiProvider): Promise<string> {
  const fallback =
    facts.trend === "up"
      ? "أداؤك يتحسن هذا الأسبوع، استمر على هذا المنوال!"
      : facts.trend === "down"
        ? "لاحظنا تراجعًا بسيطًا هذا الأسبوع، لا بأس، يمكنك استعادة نشاطك اليوم."
        : "أنت محافظ على وتيرة ثابتة هذا الأسبوع، استمر!";
  return safeComplete(
    "أنت مدرّب عادات ودود يتحدث العربية الفصحى الحديثة. ستتلقى مقاييس أداء أسبوعية محسوبة مسبقًا (لا تغيّر الأرقام). اكتب رسالة تحفيزية قصيرة (جملة أو جملتين) تعلق على الاتجاه العام دون اختلاق أرقام جديدة.",
    facts,
    fallback,
    provider,
  );
}

/** Rule engine decides the tone deterministically; this only phrases the message. */
export async function checkinFeedbackMessage(facts: {
  habitTitle: string;
  completed: boolean;
  value?: number;
  streak: number;
  tone: "celebratory" | "encouraging" | "supportive";
}, provider: AiTextProvider = geminiProvider): Promise<string> {
  const fallback =
    facts.tone === "celebratory"
      ? `رائع! أكملت "${facts.habitTitle}" وسلسلتك الآن ${facts.streak} يومًا متتاليًا!`
      : facts.tone === "encouraging"
        ? `أحسنت في "${facts.habitTitle}"! واصل التقدم خطوة بخطوة.`
        : `لا بأس، الغياب اليوم عن "${facts.habitTitle}" لا يلغي تقدمك. عد غدًا بقوة.`;
  return safeComplete(
    `أنت مدرّب عادات يتحدث العربية الفصحى الحديثة. النبرة المطلوبة محددة مسبقًا: "${facts.tone}" (لا تغيّرها). اكتب جملة أو جملتين قصيرتين تعليقًا على تسجيل الحضور، بهذه النبرة تحديدًا.`,
    facts,
    fallback,
    provider,
  );
}

/** Rule engine computes the reduced target; this only explains it in Arabic. */
export async function relapseRecoveryMessages(facts: {
  habitTitle: string;
  missedDays: number;
  suggestedTargetValue: number;
  unit: string;
}, provider: AiTextProvider = geminiProvider): Promise<{ message: string; encouragement: string }> {
  const fallbackMessage = `لا بأس، مرّت ${facts.missedDays} أيام دون "${facts.habitTitle}". لنبدأ من جديد بهدف أصغر: ${facts.suggestedTargetValue} ${facts.unit}.`;
  const fallbackEncouragement = "كل بداية جديدة هي فرصة، التقدم الحقيقي هو الاستمرار وليس الكمال.";

  try {
    const raw = await provider.generateText(
      'أنت مدرّب عادات متعاطف يتحدث العربية الفصحى الحديثة. تم تخفيض الهدف مسبقًا بواسطة محرك قواعد (لا تغيّر الرقم). اكتب رسالة قصيرة تشرح إعادة البدء بالهدف الجديد، وجملة تشجيع منفصلة. أعد JSON حصراً بالشكل: {"message": string, "encouragement": string}',
      facts,
      true,
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== "object" ||
      !("message" in parsed) || typeof parsed.message !== "string" ||
      !("encouragement" in parsed) || typeof parsed.encouragement !== "string"
    ) throw new Error("Malformed relapse-recovery response");
    return { message: parsed.message, encouragement: parsed.encouragement };
  } catch {
    logFallback();
    return { message: fallbackMessage, encouragement: fallbackEncouragement };
  }
}

export interface HabitAdaptationPhrasing {
  headline: string;
  explanation: string;
  next_step: string;
  encouragement: string;
}

export interface HabitBuilderText {
  title: string;
  category: "health" | "learning" | "productivity" | "mindfulness" | "social" | "creativity" | "finance" | "custom";
  understoodGoal: string;
  reason: string;
  frictionTip: string;
}

/** AI may interpret text, but numeric recommendations and cues stay rule-owned. */
export async function habitBuilderText(
  facts: {
    intent: string;
    fallbackTitle: string;
    fallbackCategory: HabitBuilderText["category"];
    goalType: "build" | "quit";
    friction?: string | null;
    fallbackFrictionTip?: string;
  },
  provider: AiTextProvider = geminiProvider,
): Promise<HabitBuilderText | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      provider.generateText(
        "أنت مساعد لفهم هدف عادة. أعد JSON فقط بالمفاتيح title وcategory وunderstoodGoal وreason وfrictionTip. صنّف النشاط دون إضافة روتين أو وقت أو baseline غير مذكور. category واحدة من health, learning, productivity, mindfulness, social, creativity, finance, custom. لا تعدّل الأرقام ولا تخترع حقائق. frictionTip نصيحة واحدة قصيرة مستندة فقط إلى العائق الذي ذكره المستخدم؛ لا تذكر عادة أو أداة أو رقمًا لم يذكره. إذا لم يذكر عائقًا فأعد frictionTip كسلسلة فارغة.",
        facts,
        true,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Habit builder AI timeout")), 2500);
      }),
    ]);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("Malformed habit-builder response");
    const result = parsed as Record<string, unknown>;
    const categories = ["health", "learning", "productivity", "mindfulness", "social", "creativity", "finance", "custom"];
    const tip = typeof result.frictionTip === "string" ? result.frictionTip.trim() : "";
    const friction = facts.friction?.trim() ?? "";
    const ignoredTokens = new Set(["the", "and", "for", "my", "with", "from", "this", "that", "من", "في", "على", "عن", "هذا", "هذه"]);
    const frictionTokens = friction.toLocaleLowerCase().match(/[\p{L}]{2,}/gu)?.filter((token) => !ignoredTokens.has(token)) ?? [];
    const groundedTip = !friction
      ? tip.length === 0
      : frictionTokens.some((token) => tip.toLocaleLowerCase().includes(token));
    const spelledNumber = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|first|second|third|once|twice)\b|(?:^|[\s،,])(?:صفر|واحد(?:ة)?|اثنان|اثنين|ثلاث(?:ة|ين)?|أربع(?:ة|ين)?|خمس(?:ة|ين)?|ست(?:ة|ين)?|سبع(?:ة|ين)?|ثمان(?:ية|ين)?|تسع(?:ة|ين)?|عشر(?:ة|ون)?|عشرين|ثلاثين|أربعين|خمسين|مرتين)(?=$|[\s،,.!?؟])/u;
    if (Object.keys(result).sort().join(",") !== ["category", "frictionTip", "reason", "title", "understoodGoal"].sort().join(",")
      || typeof result.title !== "string" || !result.title.trim() || result.title.length > 100
      || typeof result.understoodGoal !== "string" || !result.understoodGoal.trim() || result.understoodGoal.length > 240
      || typeof result.reason !== "string" || !result.reason.trim() || result.reason.length > 240
      || typeof result.category !== "string" || !categories.includes(result.category)
      || typeof result.frictionTip !== "string" || tip.length > 180
      || /[0-9٠-٩۰-۹\r\n]/u.test(tip) || spelledNumber.test(tip) || !groundedTip
      || (tip && /[.!?؟].*[.!?؟]/u.test(tip))) {
      throw new Error("Invalid habit-builder interpretation");
    }
    return {
      title: result.title.trim(),
      category: result.category as HabitBuilderText["category"],
      understoodGoal: result.understoodGoal.trim(),
      reason: result.reason.trim(),
      frictionTip: tip,
    };
  } catch {
    logFallback();
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function habitAdaptationMessages(
  facts: {
    reason: string;
    missedReason: string | null;
    changedTarget: boolean;
    changedMinimum: boolean;
    hasBusyDayOption: boolean;
  },
  provider: AiTextProvider = geminiProvider,
): Promise<HabitAdaptationPhrasing> {
  const fallback: HabitAdaptationPhrasing = facts.missedReason === "no_time"
    ? {
        headline: "خطة مرنة للأيام المزدحمة",
        explanation: "ضيق الوقت لا يعني أن هدفك يحتاج إلى تخفيض.",
        next_step: "جرّب النسخة الأقصر في يوم مزدحم.",
        encouragement: "القليل المستمر يساعدك على الحفاظ على العادة.",
      }
    : facts.missedReason === "forgot"
      ? {
          headline: "اجعل تذكّر العادة أسهل",
          explanation: "تكرار النسيان قد يعني أن إشارة التذكير ستفيدك.",
          next_step: "اربط العادة بوقت ثابت أو نشاط تقوم به يوميًا.",
          encouragement: "تغيير صغير في البيئة قد يجعل العودة أسهل.",
        }
      : facts.missedReason === "unexpected"
        ? {
            headline: "امنح نفسك مساحة للظروف",
            explanation: "الأحداث غير المتوقعة لا تعني أن هدفك غير مناسب.",
            next_step: "استأنف العادة عندما تسمح ظروفك.",
            encouragement: "يمكنك العودة دون أن تعاقب نفسك.",
          }
        : {
            headline: facts.changedTarget || facts.changedMinimum ? "اقتراح لتعديل هدفك" : "استمر على وتيرتك",
            explanation: facts.changedTarget || facts.changedMinimum
              ? "يقترح سجلّك تعديلًا بسيطًا ليكون الهدف أكثر قابلية للاستمرار."
              : "لا توجد حاجة إلى تغيير هدفك الآن.",
            next_step: facts.hasBusyDayOption
              ? "يمكنك اختيار نسخة أقصر للأيام المزدحمة."
              : "جرّب الاقتراح أو واصل بهدفك الحالي.",
            encouragement: "الاستمرارية أهم من الكمال.",
          };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      provider.generateText(
        'أنت مدرب عادات داعم. صغ رسالة عربية موجزة فقط اعتمادًا على الحقائق والسبب المرفقين. لا تخترع أو تذكر أي أرقام أو قيم أو تغييرات غير موجودة. أعد JSON صالحًا بهذه المفاتيح الأربعة بالضبط: {"headline": string, "explanation": string, "next_step": string, "encouragement": string}.',
        facts,
        true,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("AI phrasing timeout")), 2500);
      }),
    ]);
    const parsed: unknown = JSON.parse(raw);
    const keys = ["headline", "explanation", "next_step", "encouragement"];
    if (!parsed || typeof parsed !== "object"
      || Object.keys(parsed).sort().join(",") !== [...keys].sort().join(",")) {
      throw new Error("Malformed habit-adaptation response");
    }
    const result = parsed as Record<string, unknown>;
    const numeral = /[0-9٠-٩۰-۹]/;
    for (const key of keys) {
      if (typeof result[key] !== "string" || !result[key].trim()
        || result[key].length > 240 || numeral.test(result[key] as string)) {
        throw new Error("Invalid habit-adaptation phrasing");
      }
    }
    return {
      headline: result.headline as string,
      explanation: result.explanation as string,
      next_step: result.next_step as string,
      encouragement: result.encouragement as string,
    };
  } catch {
    logFallback();
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}