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

export type MissedReason =
  | "too_difficult"
  | "no_time"
  | "forgot"
  | "lost_motivation"
  | "unexpected"
  | "other";

export function effectiveMinimum(targetValue: number, minimumValue?: number | null): number {
  return minimumValue ?? targetValue;
}

export function evaluateHabitCheckin(input: {
  goalType: "build" | "quit";
  targetValue: number;
  minimumValue?: number | null;
  successLimitValue?: number | null;
  value?: number | null;
  legacyCompleted?: boolean;
}): { completed: boolean; targetCompleted: boolean } {
  if (input.value == null) {
    return {
      completed: input.legacyCompleted ?? false,
      targetCompleted: input.legacyCompleted ?? false,
    };
  }
  if (input.goalType === "quit") {
    const completed = input.successLimitValue == null
      ? (input.legacyCompleted ?? false)
      : input.value <= input.successLimitValue;
    return {
      completed,
      targetCompleted: input.successLimitValue == null
        ? completed
        : input.value <= input.targetValue,
    };
  }
  const minimum = effectiveMinimum(input.targetValue, input.minimumValue);
  return {
    completed: input.value >= minimum,
    targetCompleted: input.value >= input.targetValue,
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function missedScheduledDays(
  cadence: "daily" | "weekdays" | "weekly" | "custom_days",
  customDays: number[] | null | undefined,
  checkinDates: string[],
  throughDate: string,
  habitCreatedAt?: Date | string,
): number {
  const firstCheckin = [...checkinDates].sort()[0];
  const createdDate = habitCreatedAt instanceof Date
    ? habitCreatedAt.toISOString().slice(0, 10)
    : habitCreatedAt?.slice(0, 10);
  const startDate = firstCheckin ?? createdDate;
  if (!startDate) return 0;
  const totalDays = Math.max(0, daysBetween(startDate, throughDate));
  const days = Math.min(90, totalDays);
  const windowStartOffset = Math.max(0, totalDays - days);
  let missed = 0;
  for (let index = 0; index < days; index++) {
    const offset = windowStartOffset + index;
    const d = new Date(`${startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    const day = d.getUTCDay();
    const scheduled = cadence === "daily" || (cadence === "weekly" && offset % 7 === 0)
      || (cadence === "weekdays" && day >= 1 && day <= 5)
      || (cadence === "custom_days" && !!customDays?.includes(day));
    if (scheduled && !checkinDates.includes(d.toISOString().slice(0, 10))) missed++;
  }
  return missed;
}

export interface HabitAdaptation {
  reason: "repeated_hard" | "repeated_easy" | "missed_reasons" | "steady" | "no_history";
  missedReason: MissedReason | null;
  targetValue: number;
  minimumValue: number;
  busyDayValue: number | null;
}

/** Stable, bounded proposal math. No provider-supplied numbers are accepted. */
export function proposeHabitAdaptation(input: {
  targetValue: number;
  minimumValue?: number | null;
  busyDayValue?: number | null;
  checkins: { difficulty: string | null; missedReason: MissedReason | null; completed: boolean }[];
}): HabitAdaptation {
  const currentTarget = input.targetValue;
  const currentMinimum = effectiveMinimum(currentTarget, input.minimumValue);
  const recent = input.checkins.slice(-7);
  if (!recent.length) return { reason: "no_history", missedReason: null, targetValue: currentTarget, minimumValue: currentMinimum, busyDayValue: input.busyDayValue ?? null };
  const hard = recent.filter((c) => c.difficulty === "hard" || c.difficulty === "very_hard").length;
  const easy = recent.filter((c) => c.difficulty === "easy").length;
  const reasonCounts = new Map<MissedReason, number>();
  for (const checkin of recent) {
    if (checkin.missedReason) reasonCounts.set(checkin.missedReason, (reasonCounts.get(checkin.missedReason) ?? 0) + 1);
  }
  if (hard >= 3 || (reasonCounts.get("too_difficult") ?? 0) >= 2) {
    const targetValue = Math.max(1, Math.floor(currentTarget * 0.8));
    const minimumValue = Math.max(1, Math.min(targetValue, Math.floor(currentMinimum * 0.8)));
    return { reason: hard >= 3 ? "repeated_hard" : "missed_reasons", missedReason: hard >= 3 ? null : "too_difficult", targetValue, minimumValue, busyDayValue: input.busyDayValue ?? null };
  }
  if ((reasonCounts.get("no_time") ?? 0) >= 2) {
    return {
      reason: "missed_reasons", missedReason: "no_time", targetValue: currentTarget,
      minimumValue: currentMinimum,
      busyDayValue: Math.max(1, Math.min(currentMinimum, Math.floor(currentTarget * 0.3))),
    };
  }
  if ((reasonCounts.get("forgot") ?? 0) >= 2) {
    return { reason: "missed_reasons", missedReason: "forgot", targetValue: currentTarget, minimumValue: currentMinimum, busyDayValue: input.busyDayValue ?? null };
  }
  if ((reasonCounts.get("lost_motivation") ?? 0) >= 2) {
    return {
      reason: "missed_reasons", missedReason: "lost_motivation", targetValue: currentTarget,
      minimumValue: Math.max(1, Math.floor(currentMinimum * 0.9)), busyDayValue: input.busyDayValue ?? null,
    };
  }
  if ((reasonCounts.get("unexpected") ?? 0) >= 2) {
    return { reason: "missed_reasons", missedReason: "unexpected", targetValue: currentTarget, minimumValue: currentMinimum, busyDayValue: input.busyDayValue ?? null };
  }
  if (easy >= 5 && recent.filter((c) => c.completed).length >= 5) {
    const targetValue = Math.min(Math.max(currentTarget + 1, Math.ceil(currentTarget * 1.1)), currentTarget * 2);
    return { reason: "repeated_easy", missedReason: null, targetValue, minimumValue: Math.min(targetValue, Math.max(currentMinimum, Math.ceil(currentMinimum * 1.1))), busyDayValue: input.busyDayValue ?? null };
  }
  return { reason: "steady", missedReason: null, targetValue: currentTarget, minimumValue: currentMinimum, busyDayValue: input.busyDayValue ?? null };
}

export function buildHabitTargets(requestedDuration: number): {
  targetValue: number; minimumValue: number; busyDayValue: number;
} {
  const targetValue = Math.max(1, Math.min(10, Math.round(requestedDuration)));
  const minimumValue = Math.max(1, Math.floor(targetValue * 0.5));
  const busyDayValue = Math.max(1, Math.min(minimumValue, Math.round(targetValue * 0.3)));
  return { targetValue, minimumValue, busyDayValue };
}