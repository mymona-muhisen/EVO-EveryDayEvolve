import { addCalendarDays, HABIT_JOURNEY_LENGTH } from "./habitJourney";

export type JourneyLifecycleStatus = "not_started" | "active" | "completed" | "expired";
export type JourneyFinalUnmetReason =
  | "journey_not_started"
  | "calendar_days_remaining"
  | "final_scheduled_day_not_successful"
  | "no_scheduled_days"
  | null;

function dayDifference(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

export function evaluateJourneyLifecycle(input: {
  startDate: string | null;
  length: number | null;
  today: string;
  scheduledDates: string[];
  successfulDates: Set<string>;
  completedAt: Date | null;
}) {
  const isDefinedJourney = input.startDate != null && input.length === HABIT_JOURNEY_LENGTH;
  const endDate = isDefinedJourney
    ? addCalendarDays(input.startDate!, HABIT_JOURNEY_LENGTH - 1)
    : null;
  const calendarDay = isDefinedJourney && input.today >= input.startDate!
    ? Math.min(HABIT_JOURNEY_LENGTH, dayDifference(input.startDate!, input.today) + 1)
    : 0;
  const finalScheduledDate = input.scheduledDates.length
    ? [...input.scheduledDates].sort().at(-1)!
    : null;
  const finalDateSuccessful = finalScheduledDate != null
    && input.successfulDates.has(finalScheduledDate);
  const eligibleNow = isDefinedJourney
    && input.today >= endDate!
    && finalScheduledDate != null
    && finalDateSuccessful;
  const finalRestWindowMissed = input.today === endDate
    && finalScheduledDate != null
    && finalScheduledDate < endDate!
    && !finalDateSuccessful;
  const status: JourneyLifecycleStatus = !isDefinedJourney
    ? "not_started"
    : input.completedAt || eligibleNow
      ? "completed"
      : input.today < input.startDate!
        ? "not_started"
        : input.today > endDate! || finalRestWindowMissed
          ? "expired"
          : "active";
  const unmetReason: JourneyFinalUnmetReason = status === "completed"
    ? null
    : !isDefinedJourney || input.today < input.startDate!
      ? "journey_not_started"
      : !finalScheduledDate
        ? "no_scheduled_days"
        : input.today < endDate!
          ? "calendar_days_remaining"
          : "final_scheduled_day_not_successful";
  return {
    status,
    endDate,
    calendarDay,
    completedAt: input.completedAt,
    shouldCommitCompletion: eligibleNow && input.completedAt == null,
    finalScheduledDate,
    finalDateSuccessful,
    finalEligibility: {
      eligible: status === "completed",
      calendarDayRequired: HABIT_JOURNEY_LENGTH,
      finalScheduledDate,
      finalDateSuccessful,
      unmetReason,
    },
  };
}