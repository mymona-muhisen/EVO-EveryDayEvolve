import type { HabitPlanJson } from "@workspace/db";

export const HABIT_JOURNEY_LENGTH = 22;
export type HabitExecutionType = "duration" | "count" | "boolean" | "limit";

export function resolveExecutionType(
  unit: "minutes" | "count" | "pages" | "custom",
  goalType: "build" | "quit",
  executionType?: HabitExecutionType | null,
): HabitExecutionType {
  return executionType ?? (goalType === "quit" ? "limit" : unit === "minutes" ? "duration" : "count");
}

export interface DayPlan {
  title: string;
  targetValue: number;
  minimumValue: number;
  busyDayValue: number | null;
  successLimitValue: number | null;
  goalType: "build" | "quit";
  unit: "minutes" | "count" | "pages" | "custom";
  executionType: "duration" | "count" | "boolean" | "limit";
  cueType: "time" | "routine" | "custom" | null;
  cueTime: string | null;
  cue: string | null;
  startAction: string | null;
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

export function isWithinJourneyWindow(date: string, startDate: string, length = HABIT_JOURNEY_LENGTH): boolean {
  return date >= startDate && date <= addCalendarDays(startDate, length - 1);
}

export function journeyDayNumber(date: string, startDate: string): number {
  return Math.floor(
    (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
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
    title: plan.title,
    unit: plan.unit,
    executionType: plan.executionType,
    cueType: plan.cueType,
    cueTime: plan.cueTime,
    cue: plan.cue,
    startAction: plan.startAction,
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
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.executionType === undefined ? {} : { executionType: input.executionType }),
    cueType: input.cueType,
    cueTime: input.cueTime,
    cue: input.cue,
    startAction: input.startAction,
    friction: input.friction,
  };
}