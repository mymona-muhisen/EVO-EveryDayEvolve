import {
  date,
  doublePrecision,
  integer,
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import {
  habitsTable,
  habitCueTypeEnum,
  habitExecutionTypeEnum,
  habitGoalTypeEnum,
  habitUnitEnum,
} from "./habits";
import { checkinDifficultyEnum, missedReasonEnum } from "./checkins";

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
  unit?: "minutes" | "count" | "pages" | "custom";
  executionType?: "duration" | "count" | "boolean" | "limit";
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
  title: text("title"),
  targetValue: doublePrecision("target_value").notNull(),
  minimumValue: doublePrecision("minimum_value").notNull(),
  busyDayValue: doublePrecision("busy_day_value"),
  successLimitValue: doublePrecision("success_limit_value"),
  goalType: habitGoalTypeEnum("goal_type").notNull(),
  unit: habitUnitEnum("unit"),
  executionType: habitExecutionTypeEnum("execution_type"),
  cueType: habitCueTypeEnum("cue_type"),
  cueTime: text("cue_time"),
  cue: text("cue"),
  startAction: text("start_action"),
  planRevision: integer("plan_revision").notNull().default(1),
}, (table) => [unique("habit_days_habit_date_unique").on(table.habitId, table.date)]);

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

export const dailyExecutionStatusEnum = pgEnum("daily_execution_status", [
  "pending",
  "in_progress",
  "paused",
  "minimum_reached",
  "target_reached",
  "pending_reflection",
  "completed",
  "missed",
  "recovery_available",
  "recovery_active",
  "recovered",
]);

export const dailyAdaptationDecisionEnum = pgEnum("daily_adaptation_decision", [
  "accepted",
  "rejected",
]);

/**
 * Durable execution state is deliberately separate from immutable habit_days
 * plan snapshots and from free-form time-tracking sessions.
 */
export const habitDailyExecutionsTable = pgTable("habit_daily_executions", {
  id: serial("id").primaryKey(),
  habitId: integer("habit_id").notNull()
    .references(() => habitsTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  dayNumber: integer("day_number").notNull(),
  scheduled: boolean("scheduled").notNull().default(true),
  title: text("title").notNull(),
  targetValue: doublePrecision("target_value").notNull(),
  minimumValue: doublePrecision("minimum_value").notNull(),
  busyDayValue: doublePrecision("busy_day_value"),
  successLimitValue: doublePrecision("success_limit_value"),
  goalType: habitGoalTypeEnum("goal_type").notNull(),
  executionType: habitExecutionTypeEnum("execution_type").notNull(),
  unit: habitUnitEnum("unit").notNull(),
  planRevision: integer("plan_revision").notNull().default(0),
  cueType: habitCueTypeEnum("cue_type"),
  cueTime: text("cue_time"),
  cue: text("cue"),
  startAction: text("start_action"),
  status: dailyExecutionStatusEnum("status").notNull().default("pending"),
  actualValue: doublePrecision("actual_value"),
  actualSeconds: integer("actual_seconds"),
  elapsedBaseSeconds: integer("elapsed_base_seconds").notNull().default(0),
  segmentPausedSeconds: integer("segment_paused_seconds").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastResumedAt: timestamp("last_resumed_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedSeconds: integer("paused_seconds").notNull().default(0),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  missedReason: missedReasonEnum("missed_reason"),
  note: text("note"),
  difficulty: checkinDifficultyEnum("difficulty"),
  revision: integer("revision").notNull().default(0),
  adaptationDecision: dailyAdaptationDecisionEnum("adaptation_decision"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("habit_daily_executions_habit_date_unique").on(table.habitId, table.date),
]);

export const habitDailyActionKeysTable = pgTable("habit_daily_action_keys", {
  id: serial("id").primaryKey(),
  habitId: integer("habit_id").notNull()
    .references(() => habitsTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  action: text("action").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("habit_daily_action_keys_unique").on(table.habitId, table.date, table.idempotencyKey),
]);

export type HabitDayRow = typeof habitDaysTable.$inferSelect;
export type HabitPlanRevisionRow = typeof habitPlanRevisionsTable.$inferSelect;
export type HabitDailyExecutionRow = typeof habitDailyExecutionsTable.$inferSelect;