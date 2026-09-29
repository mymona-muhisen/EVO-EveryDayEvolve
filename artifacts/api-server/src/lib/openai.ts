import OpenAI from "openai";
import { logger } from "./logger";

// Uses the project owner's own OpenAI API key directly via the raw SDK —
// never the Replit AI Integrations proxy (binding product requirement).
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";

async function safeComplete(
  system: string,
  context: object,
  fallback: string,
): Promise<string> {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context) },
      ],
      temperature: 0.8,
      max_tokens: 200,
    });
    return completion.choices[0]?.message?.content?.trim() || fallback;
  } catch (error) {
    logger.error({ err: error }, "OpenAI phrasing call failed, using fallback message");
    return fallback;
  }
}

export interface BreakdownGoalStep {
  targetValue: number;
  order: number;
}

/**
 * Rule engine (caller) computes the milestone targetValues/order. This only
 * phrases Arabic titles/descriptions for each step plus a short coach
 * message — it must never change the numbers it's given.
 */
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
): Promise<{ stepTexts: { title: string; description: string }[]; coachMessage: string }> {
  const fallbackStepTexts = steps.map((s, i) => ({
    title: `الخطوة ${i + 1}`,
    description: `الوصول إلى ${s.targetValue} ${input.unit}`,
  }));
  const fallbackCoach = `قسّمنا هدف "${input.title}" إلى ${steps.length} خطوات تدريجية — لنبدأ بالخطوة الأولى!`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'أنت مدرّب عادات متحمس يتحدث العربية الفصحى الحديثة. ستتلقى هدفًا وقائمة بالقيم المستهدفة الرقمية لكل خطوة (تم حسابها مسبقًا من قبل محرك قواعد، لا تغيّرها). مهمتك فقط صياغة عنوان ووصف قصيرين ومحفزين لكل خطوة، بنفس ترتيبها، بالإضافة إلى رسالة تحفيزية قصيرة واحدة. أعد JSON حصراً بالشكل: {"steps": [{"title": string, "description": string}], "coachMessage": string}',
        },
        { role: "user", content: JSON.stringify({ ...input, steps }) },
      ],
      temperature: 0.8,
      max_tokens: 500,
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty completion");
    const parsed = JSON.parse(raw) as {
      steps?: { title: string; description: string }[];
      coachMessage?: string;
    };
    if (!parsed.steps || parsed.steps.length !== steps.length || !parsed.coachMessage) {
      throw new Error("Malformed breakdown-goal completion shape");
    }
    return { stepTexts: parsed.steps, coachMessage: parsed.coachMessage };
  } catch (error) {
    logger.error({ err: error }, "OpenAI breakdown-goal call failed, using fallback text");
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
}): Promise<string> {
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
  );
}

/** Rule engine decides the tone deterministically; this only phrases the message in that tone. */
export async function checkinFeedbackMessage(facts: {
  habitTitle: string;
  completed: boolean;
  value?: number;
  streak: number;
  tone: "celebratory" | "encouraging" | "supportive";
}): Promise<string> {
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
  );
}

/** Rule engine computes the reduced restart target; this only phrases compassionate encouragement. */
export async function relapseRecoveryMessages(facts: {
  habitTitle: string;
  missedDays: number;
  suggestedTargetValue: number;
  unit: string;
}): Promise<{ message: string; encouragement: string }> {
  const fallbackMessage = `لا بأس، مرّت ${facts.missedDays} أيام دون "${facts.habitTitle}". لنبدأ من جديد بهدف أصغر: ${facts.suggestedTargetValue} ${facts.unit}.`;
  const fallbackEncouragement = "كل بداية جديدة هي فرصة، التقدم الحقيقي هو الاستمرار وليس الكمال.";

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'أنت مدرّب عادات متعاطف يتحدث العربية الفصحى الحديثة. تم تخفيض الهدف مسبقًا بواسطة محرك قواعد (لا تغيّر الرقم). اكتب رسالة قصيرة تشرح إعادة البدء بالهدف الجديد، وجملة تشجيع منفصلة. أعد JSON حصراً بالشكل: {"message": string, "encouragement": string}',
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
      temperature: 0.8,
      max_tokens: 300,
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty completion");
    const parsed = JSON.parse(raw) as { message?: string; encouragement?: string };
    if (!parsed.message || !parsed.encouragement) {
      throw new Error("Malformed relapse-recovery completion shape");
    }
    return { message: parsed.message, encouragement: parsed.encouragement };
  } catch (error) {
    logger.error({ err: error }, "OpenAI relapse-recovery call failed, using fallback text");
    return { message: fallbackMessage, encouragement: fallbackEncouragement };
  }
}
