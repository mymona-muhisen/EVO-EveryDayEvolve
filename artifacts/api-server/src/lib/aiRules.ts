/** Numbers and tone are determined locally, never by the language model. */
export function goalMilestones(targetValue: number): { targetValue: number; order: number }[] {
  return [0.25, 0.5, 0.75, 1].map((fraction, index) => ({
    targetValue: Math.max(1, Math.round(targetValue * fraction)),
    order: index + 1,
  }));
}

export function phraseMilestones(
  steps: ReturnType<typeof goalMilestones>,
  texts: { title: string; description: string }[],
): { targetValue: number; order: number; title: string; description: string }[] {
  return steps.map((step, index) => ({
    ...step,
    title: texts[index]?.title ?? `الخطوة ${index + 1}`,
    description: texts[index]?.description ?? "",
  }));
}

export type CheckinTone = "celebratory" | "encouraging" | "supportive";

export function checkinTone(completed: boolean, streak: number): CheckinTone {
  if (!completed) return "supportive";
  if (streak > 0 && (streak % 7 === 0 || streak >= 3)) return "celebratory";
  return "encouraging";
}

export function recoveryTarget(targetValue: number): number {
  return Math.max(1, Math.round(targetValue * 0.5));
}