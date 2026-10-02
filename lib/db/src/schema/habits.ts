import {
  pgEnum,
  pgTable,
  serial,
  text,
  integer,
  boolean,
  date,
  doublePrecision,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable, goalCategoryEnum } from "./users";

export const habitCadenceEnum = pgEnum("habit_cadence", [
  "daily",
  "weekdays",
  "weekly",
  "custom_days",
]);

export const habitUnitEnum = pgEnum("habit_unit", [
  "minutes",
  "count",
  "pages",
  "custom",
]);

export const habitDifficultyEnum = pgEnum("habit_difficulty", [
  "easy",
  "medium",
  "hard",
]);

export const habitGoalTypeEnum = pgEnum("habit_goal_type", ["build", "quit"]);
export const habitCueTypeEnum = pgEnum("habit_cue_type", ["time", "routine", "custom"]);
export const habitExecutionTypeEnum = pgEnum("habit_execution_type", [
  "duration",
  "count",
  "boolean",
  "limit",
]);

export interface HabitMilestoneJson {
  title: string;
  description: string;
  targetValue: number;
  order: number;
}

export interface HabitOriginJson {
  source: "ai_time_recovery";
  analysisDate: string;
  recoveredMinutes: number;
  originalCategory: string;
  replacementActivity: string;
}

export const habitsTable = pgTable("habits", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  emoji: text("emoji").notNull(),
  category: goalCategoryEnum("category").notNull(),
  cadence: habitCadenceEnum("cadence").notNull(),
  customDays: integer("custom_days").array(),
  unit: habitUnitEnum("unit").notNull(),
  executionType: habitExecutionTypeEnum("execution_type"),
  targetValue: doublePrecision("target_value").notNull(),
  originalGoal: text("original_goal"),
  desiredTarget: doublePrecision("desired_target"),
  desiredUnit: habitUnitEnum("desired_unit"),
  recommendedStartingTarget: doublePrecision("recommended_starting_target"),
  origin: jsonb("origin").$type<HabitOriginJson>(),
  minimumValue: doublePrecision("minimum_value"),
  busyDayValue: doublePrecision("busy_day_value"),
  baselineValue: doublePrecision("baseline_value"),
  successLimitValue: doublePrecision("success_limit_value"),
  cueType: habitCueTypeEnum("cue_type"),
  cueTime: text("cue_time"),
  cue: text("cue"),
  startAction: text("start_action"),
  friction: text("friction"),
  minimumFloor: doublePrecision("minimum_floor"),
  journeyStartDate: date("journey_start_date", { mode: "string" }),
  journeyLength: integer("journey_length"),
  journeyCompletedAt: timestamp("journey_completed_at", { withTimezone: true }),
  rewardId: integer("reward_id"),
  difficulty: habitDifficultyEnum("difficulty").notNull(),
  goalType: habitGoalTypeEnum("goal_type").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  recoveryEnabled: boolean("recovery_enabled").notNull().default(false),
  recoveryUsed: integer("recovery_used").notNull().default(0),
  recoveryLimit: integer("recovery_limit").notNull().default(2),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  lastCheckinDate: date("last_checkin_date", { mode: "string" }),
  // Internal-only bookkeeping for the streak-recovery mechanic. Not part of
  // the public Habit API shape (zod .parse() strips unknown keys).
  lastBrokenStreak: integer("last_broken_streak"),
  streakBrokenAt: date("streak_broken_at", { mode: "string" }),
  milestones: jsonb("milestones").$type<HabitMilestoneJson[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type HabitRow = typeof habitsTable.$inferSelect;
