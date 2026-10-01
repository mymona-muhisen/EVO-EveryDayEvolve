import {
  date,
  doublePrecision,
  integer,
  boolean,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { habitsTable, habitGoalTypeEnum } from "./habits";

export interface HabitPlanJson {
  title?: string;
  cadence?: "daily" | "weekdays" | "weekly" | "custom_days";
  customDays?: number[] | null;
  targetValue: number;
  minimumValue: number;
  busyDayValue: number | null;
  successLimitValue: number | null;
  minimumFloor: number | null;
  goalType: "build" | "quit";
  cueType: "time" | "routine" | "custom" | null;
  cueTime: string | null;
  cue: string | null;
  startAction: string | null;
  friction: string | null;
}

/** Immutable per-date plan snapshots used by check-in evaluation. */
export const habitDaysTable = pgTable("habit_days", {
  id: serial("id").primaryKey(),
  habitId: integer("habit_id").notNull()
    .references(() => habitsTable.id, { onDelete: "cascade" }),
  dayNumber: integer("day_number").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  scheduled: boolean("scheduled").notNull().default(true),
  targetValue: doublePrecision("target_value").notNull(),
  minimumValue: doublePrecision("minimum_value").notNull(),
  busyDayValue: doublePrecision("busy_day_value"),
  successLimitValue: doublePrecision("success_limit_value"),
  goalType: habitGoalTypeEnum("goal_type").notNull(),
  planRevision: integer("plan_revision").notNull().default(1),
}, (table) => [
  unique("habit_days_habit_day_unique").on(table.habitId, table.dayNumber),
  unique("habit_days_habit_date_unique").on(table.habitId, table.date),
]);

/** Append-only audit of accepted plan revisions and their effective date. */
export const habitPlanRevisionsTable = pgTable("habit_plan_revisions", {
  id: serial("id").primaryKey(),
  habitId: integer("habit_id").notNull()
    .references(() => habitsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  plan: jsonb("plan").$type<HabitPlanJson>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("habit_plan_revisions_habit_revision_unique").on(table.habitId, table.revision)]);

export type HabitDayRow = typeof habitDaysTable.$inferSelect;
export type HabitPlanRevisionRow = typeof habitPlanRevisionsTable.$inferSelect;