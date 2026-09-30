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