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

export function defaultMinimumFloor(
  goalType: "build" | "quit",
  configuredFloor?: number | null,
): number {
  return configuredFloor ?? (goalType === "quit" ? 0 : 1);
}

export function checkinsForPlanRevision<T extends { date: string }>(
  checkins: T[],
  planDays: { date: string; planRevision: number }[],
  currentRevision?: number,
): T[] {
  if (currentRevision === undefined) return checkins;
  const revisionByDate = new Map(planDays.map((day) => [day.date, day.planRevision]));
  return checkins.filter((checkin) => revisionByDate.get(checkin.date) === currentRevision);
}

export interface HabitPlanUpdateGuards {
  expectedTargetValue?: number;
  expectedMinimumValue?: number;
  expectedSuccessLimitValue?: number | null;
}

export interface HabitPlanGuardState {
  targetValue: number;
  minimumValue: number;
  successLimitValue: number | null;
}

/** Called only after locking the habit row; expected values guard, not update. */
export function validateHabitPlanUpdate(
  expected: HabitPlanUpdateGuards,
  current: HabitPlanGuardState,
  hasActualUpdate: boolean,
): "conflict" | "empty" | null {
  if ((expected.expectedTargetValue !== undefined
      && expected.expectedTargetValue !== current.targetValue)
    || (expected.expectedMinimumValue !== undefined
      && expected.expectedMinimumValue !== current.minimumValue)
    || (expected.expectedSuccessLimitValue !== undefined
      && expected.expectedSuccessLimitValue !== current.successLimitValue)) {
    return "conflict";
  }
  return hasActualUpdate ? null : "empty";
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
  successLimitValue: number | null;
  busyDayValue: number | null;
}

/** Stable, bounded proposal math. No provider-supplied numbers are accepted. */
export function proposeHabitAdaptation(input: {
  targetValue: number;
  minimumValue?: number | null;
  busyDayValue?: number | null;
  goalType?: "build" | "quit";
  successLimitValue?: number | null;
  baselineValue?: number | null;
  minimumFloor?: number | null;
  checkins: {
    difficulty: string | null;
    missedReason: MissedReason | null;
    completed: boolean;
    note?: string | null;
  }[];
  numericCheckins?: {
    difficulty: string | null;
    missedReason: MissedReason | null;
    completed: boolean;
    note?: string | null;
  }[];
}): HabitAdaptation {
  const currentTarget = input.targetValue;
  const currentMinimum = effectiveMinimum(currentTarget, input.minimumValue);
  const isQuit = input.goalType === "quit";
  const currentSuccessLimit = isQuit
    ? Math.max(currentTarget, input.successLimitValue ?? currentTarget)
    : null;
  const floor = Math.max(0, defaultMinimumFloor(isQuit ? "quit" : "build", input.minimumFloor));
  const recent = input.checkins.slice(-7);
  const unchanged = {
    targetValue: currentTarget,
    minimumValue: currentMinimum,
    successLimitValue: currentSuccessLimit,
    busyDayValue: input.busyDayValue ?? null,
  };
  if (!recent.length) return { reason: "no_history", missedReason: null, ...unchanged };
  const numericRecent = (input.numericCheckins ?? input.checkins).slice(-7);
  const veryHard = numericRecent.filter((c) => c.difficulty === "very_hard").length;
  const hard = numericRecent.filter((c) => c.difficulty === "hard" || c.difficulty === "very_hard").length;
  const successfulRecent = numericRecent.filter((c) => c.completed);
  const easySuccessful = successfulRecent.filter((c) => c.difficulty === "easy").length;
  const majorityEasy = successfulRecent.length >= 3
    && easySuccessful >= Math.ceil(successfulRecent.length / 2);
  const numericTooDifficultCount = numericRecent.filter((c) => c.missedReason === "too_difficult").length;
  const reasonCounts = new Map<MissedReason, number>();
  for (const checkin of recent) {
    if (checkin.missedReason) reasonCounts.set(checkin.missedReason, (reasonCounts.get(checkin.missedReason) ?? 0) + 1);
  }
  if (veryHard >= 2 || hard >= 2 || numericTooDifficultCount >= 2) {
    if (isQuit) {
      const limit = currentSuccessLimit ?? currentTarget;
      const baseline = Math.max(limit, input.baselineValue ?? limit);
      const returnFraction = veryHard >= 2 ? 0.5 : 0.25;
      const newLimit = Math.min(baseline, limit + Math.max(1, Math.ceil((baseline - limit) * returnFraction)));
      return {
        reason: hard >= 2 || veryHard >= 2 ? "repeated_hard" : "missed_reasons",
        missedReason: hard >= 2 || veryHard >= 2 ? null : "too_difficult",
        ...unchanged,
        successLimitValue: Math.max(currentTarget, newLimit),
      };
    }
    const reduction = veryHard >= 2 ? 0.5 : 0.8;
    const targetValue = Math.max(floor, Math.floor(currentTarget * reduction));
    const minimumValue = Math.max(floor, Math.min(targetValue, Math.floor(currentMinimum * reduction)));
    return {
      reason: hard >= 2 || veryHard >= 2 ? "repeated_hard" : "missed_reasons",
      missedReason: hard >= 2 || veryHard >= 2 ? null : "too_difficult",
      targetValue, minimumValue, successLimitValue: null,
      busyDayValue: input.busyDayValue == null ? null : Math.min(input.busyDayValue, minimumValue),
    };
  }
  if ((reasonCounts.get("no_time") ?? 0) >= 1) {
    return {
      reason: "missed_reasons", missedReason: "no_time", targetValue: currentTarget,
      minimumValue: currentMinimum, successLimitValue: currentSuccessLimit,
      busyDayValue: Math.max(0, Math.min(currentMinimum, Math.floor(currentTarget * 0.3))),
    };
  }
  if ((reasonCounts.get("forgot") ?? 0) >= 1) {
    return { reason: "missed_reasons", missedReason: "forgot", ...unchanged };
  }
  if ((reasonCounts.get("lost_motivation") ?? 0) >= 1) {
    return {
      reason: "missed_reasons", missedReason: "lost_motivation", targetValue: currentTarget,
      minimumValue: currentMinimum,
      successLimitValue: currentSuccessLimit, busyDayValue: input.busyDayValue ?? null,
    };
  }
  if ((reasonCounts.get("unexpected") ?? 0) >= 1) {
    return { reason: "missed_reasons", missedReason: "unexpected", ...unchanged };
  }
  if (numericTooDifficultCount >= 1) {
    return { reason: "missed_reasons", missedReason: "too_difficult", ...unchanged };
  }
  if (isQuit && easySuccessful >= 3) {
    const limit = currentSuccessLimit ?? currentTarget;
    if (limit <= currentTarget) {
      const roundedStep = Math.round((currentTarget * 0.125) / 10) * 10;
      const fallbackStep = Math.max(1, Math.round(currentTarget * 0.1));
      const maxStep = Math.max(1, Math.floor(currentTarget * 0.2));
      const step = Math.min(20, maxStep, roundedStep || fallbackStep);
      const targetValue = Math.max(floor, currentTarget - step);
      if (targetValue < currentTarget) {
        const minimumValue = Math.min(currentMinimum, targetValue);
        return {
          reason: "repeated_easy",
          missedReason: null,
          targetValue,
          minimumValue,
          // Keep the previous target as a softer success ceiling after progress.
          successLimitValue: currentTarget,
          busyDayValue: input.busyDayValue == null ? null : Math.min(input.busyDayValue, minimumValue),
        };
      }
      return { reason: "steady", missedReason: null, ...unchanged };
    }
    const newLimit = Math.max(currentTarget, limit - Math.max(1, Math.floor(limit * 0.1)));
    return { reason: "repeated_easy", missedReason: null, ...unchanged, successLimitValue: newLimit };
  }
  if (!isQuit && majorityEasy) {
    const targetValue = Math.min(Math.max(currentTarget + 1, Math.ceil(currentTarget * 1.1)), currentTarget * 2);
    const boundedTarget = Math.max(floor, targetValue);
    return { reason: "repeated_easy", missedReason: null, targetValue: boundedTarget, minimumValue: Math.min(boundedTarget, Math.max(floor, currentMinimum, Math.ceil(currentMinimum * 1.1))), successLimitValue: null, busyDayValue: input.busyDayValue ?? null };
  }
  return { reason: "steady", missedReason: null, ...unchanged };
}

export function buildHabitTargets(requestedDuration: number): {
  targetValue: number; minimumValue: number; busyDayValue: number;
} {
  const targetValue = Math.max(1, Math.min(10, Math.round(requestedDuration)));
  const minimumValue = Math.max(1, Math.floor(targetValue * 0.5));
  const busyDayValue = Math.max(1, Math.min(minimumValue, Math.round(targetValue * 0.3)));
  return { targetValue, minimumValue, busyDayValue };
}