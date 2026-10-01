import type { HabitPlanJson } from "@workspace/db";

export const HABIT_JOURNEY_LENGTH = 22;

export interface DayPlan {
  targetValue: number;
  minimumValue: number;
  busyDayValue: number | null;
  successLimitValue: number | null;
  goalType: "build" | "quit";
  planRevision: number;
  cadence: "daily" | "weekdays" | "weekly" | "custom_days";
  customDays: number[] | null;
}

export function isScheduledDate(
  dateOnly: string,
  dayNumber: number,
  cadence: DayPlan["cadence"],
  customDays: number[] | null,
): boolean {
  const weekday = new Date(`${dateOnly}T00:00:00.000Z`).getUTCDay();
  if (cadence === "daily") return true;
  if (cadence === "weekdays") return weekday >= 1 && weekday <= 5;
  if (cadence === "weekly") return (dayNumber - 1) % 7 === 0;
  return customDays?.includes(weekday) ?? false;
}

export function addCalendarDays(dateOnly: string, amount: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function makeJourneyDays(habitId: number, startDate: string, length: number, plan: DayPlan) {
  return Array.from({ length }, (_, index) => ({
    habitId,
    dayNumber: index + 1,
    date: addCalendarDays(startDate, index),
    scheduled: isScheduledDate(
      addCalendarDays(startDate, index),
      index + 1,
      plan.cadence,
      plan.customDays,
    ),
    targetValue: plan.targetValue,
    minimumValue: plan.minimumValue,
    busyDayValue: plan.busyDayValue,
    successLimitValue: plan.successLimitValue,
    goalType: plan.goalType,
    planRevision: plan.planRevision,
  }));
}

export function snapshotPlan(input: HabitPlanJson): HabitPlanJson {
  return {
    title: input.title,
    cadence: input.cadence,
    customDays: input.customDays,
    targetValue: input.targetValue,
    minimumValue: input.minimumValue,
    busyDayValue: input.busyDayValue,
    successLimitValue: input.successLimitValue,
    minimumFloor: input.minimumFloor,
    goalType: input.goalType,
    cueType: input.cueType,
    cueTime: input.cueTime,
    cue: input.cue,
    startAction: input.startAction,
    friction: input.friction,
  };
}