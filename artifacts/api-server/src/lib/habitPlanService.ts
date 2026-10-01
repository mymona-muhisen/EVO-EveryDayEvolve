import { and, eq, gt } from "drizzle-orm";
import { db, checkinsTable, habitDaysTable } from "@workspace/db";
import { isScheduledDate } from "./habitJourney";

type HabitTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Revise only future scheduled calendar rows with no recorded check-in. */
export async function reviseFutureUnrecordedDays(
  tx: HabitTransaction,
  habitId: number,
  today: string,
  revision: number,
  plan: {
    targetValue: number;
    minimumValue: number;
    busyDayValue: number | null;
    successLimitValue: number | null;
    goalType: "build" | "quit";
    cadence: "daily" | "weekdays" | "weekly" | "custom_days";
    customDays: number[] | null;
  },
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
      targetValue: plan.targetValue,
      minimumValue: plan.minimumValue,
      busyDayValue: plan.busyDayValue,
      successLimitValue: plan.successLimitValue,
      goalType: plan.goalType,
      scheduled: isScheduledDate(day.date, day.dayNumber, plan.cadence, plan.customDays),
      planRevision: revision,
    }).where(eq(habitDaysTable.id, day.id));
    revised.push(day.date);
  }
  return revised;
}