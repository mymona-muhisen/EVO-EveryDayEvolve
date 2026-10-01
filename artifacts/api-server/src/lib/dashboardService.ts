import { and, eq, inArray } from "drizzle-orm";
import { db, habitsTable, habitDaysTable, checkinsTable } from "@workspace/db";
import type { DashboardHabitToday } from "@workspace/api-zod";
import { effectiveMinimum } from "./aiRules";
import { isScheduledOn } from "./rules";
import { addCalendarDays } from "./habitJourney";

export class DashboardSnapshotError extends Error {}

/**
 * Build today's action cards from its immutable day snapshot. Habits predating
 * journeys deliberately retain the cadence/current-plan fallback.
 */
export async function getDashboardHabitsToday(
  userId: string,
  today: string,
): Promise<DashboardHabitToday[]> {
  const habits = await db.select().from(habitsTable).where(and(
    eq(habitsTable.userId, userId),
    eq(habitsTable.isActive, true),
  ));
  if (!habits.length) return [];

  const habitIds = habits.map((habit) => habit.id);
  const [dayRows, checkins] = await Promise.all([
    db.select().from(habitDaysTable).where(and(
      inArray(habitDaysTable.habitId, habitIds),
      eq(habitDaysTable.date, today),
    )),
    db.select().from(checkinsTable).where(and(
      inArray(checkinsTable.habitId, habitIds),
      eq(checkinsTable.date, today),
    )),
  ]);
  const dayByHabit = new Map(dayRows.map((day) => [day.habitId, day]));
  const checkinByHabit = new Map(checkins.map((checkin) => [checkin.habitId, checkin]));
  const todayDate = new Date(`${today}T00:00:00Z`);

  return habits.map((habit) => {
    const checkin = checkinByHabit.get(habit.id);
    const day = dayByHabit.get(habit.id);
    const hasStart = habit.journeyStartDate != null;
    const hasLength = habit.journeyLength != null;
    if (hasStart !== hasLength) {
      throw new DashboardSnapshotError(`Habit ${habit.id} has an incomplete journey definition`);
    }

    let scheduledToday: boolean;
    let targetValue = habit.targetValue;
    let minimumValue = effectiveMinimum(habit.targetValue, habit.minimumValue);
    let goalType = habit.goalType;
    let successLimitValue = habit.successLimitValue;
    if (hasStart && hasLength) {
      const start = habit.journeyStartDate!;
      const end = addCalendarDays(start, habit.journeyLength! - 1);
      const withinJourney = today >= start && today <= end;
      if (withinJourney) {
        if (!day) {
          throw new DashboardSnapshotError(`Habit ${habit.id} is missing today's journey plan snapshot`);
        }
        targetValue = day.targetValue;
        minimumValue = day.minimumValue;
        goalType = day.goalType;
        successLimitValue = day.successLimitValue;
        scheduledToday = day.scheduled;
      } else {
        scheduledToday = false;
      }
    } else {
      // Legacy habits have no immutable day rows; use their live plan/cadence.
      scheduledToday = isScheduledOn(habit.cadence, habit.customDays, todayDate);
    }

    return {
      habitId: habit.id,
      title: habit.title,
      emoji: habit.emoji,
      unit: habit.unit,
      targetValue,
      minimumValue,
      goalType,
      successLimitValue,
      completedToday: Boolean(checkin?.completed),
      targetCompleted: Boolean(checkin?.targetCompleted),
      valueToday: checkin?.value ?? null,
      currentStreak: habit.currentStreak,
      scheduledToday,
    };
  });
}