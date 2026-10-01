import { and, eq, gt } from "drizzle-orm";
import { db, checkinsTable, habitDaysTable } from "@workspace/db";
import type { HabitPlanJson } from "@workspace/db";
import { isScheduledDate, journeyDayNumber } from "./habitJourney";

type HabitTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Revise only future scheduled calendar rows with no recorded check-in. */
export async function reviseFutureUnrecordedDays(
  tx: HabitTransaction,
  habitId: number,
  today: string,
  revision: number,
  plan: {
    title: string;
    targetValue: number;
    minimumValue: number;
    busyDayValue: number | null;
    successLimitValue: number | null;
    goalType: "build" | "quit";
    unit: "minutes" | "count" | "pages" | "custom";
    executionType: "duration" | "count" | "boolean" | "limit";
    cadence: "daily" | "weekdays" | "weekly" | "custom_days";
    customDays: number[] | null;
    cueType: HabitPlanJson["cueType"];
    cueTime: string | null;
    cue: string | null;
    startAction: string | null;
  },
  journeyStartDate?: string | null,
): Promise<string[]> {
  const futureDays = await tx.select().from(habitDaysTable).where(and(
    eq(habitDaysTable.habitId, habitId),
    gt(habitDaysTable.date, today),
  ));
  if (!futureDays.length) return [];
  const checkins = await tx.select({ date: checkinsTable.date }).from(checkinsTable)
    .where(eq(checkinsTable.habitId, habitId));
  const recorded = new Set(checkins.map((row) => row.date));
  const revised: string[] = [];
  for (const day of futureDays) {
    if (recorded.has(day.date)) continue;
    await tx.update(habitDaysTable).set({
      title: plan.title,
      targetValue: plan.targetValue,
      minimumValue: plan.minimumValue,
      busyDayValue: plan.busyDayValue,
      successLimitValue: plan.successLimitValue,
      goalType: plan.goalType,
      unit: plan.unit,
      executionType: plan.executionType,
      cueType: plan.cueType,
      cueTime: plan.cueTime,
      cue: plan.cue,
      startAction: plan.startAction,
      scheduled: isScheduledDate(
        day.date,
        journeyStartDate == null ? day.dayNumber : journeyDayNumber(day.date, journeyStartDate),
        plan.cadence,
        plan.customDays,
      ),
      planRevision: revision,
    }).where(eq(habitDaysTable.id, day.id));
    revised.push(day.date);
  }
  return revised;
}