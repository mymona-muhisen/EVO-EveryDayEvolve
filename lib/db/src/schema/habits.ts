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

export interface HabitMilestoneJson {
  title: string;
  description: string;
  targetValue: number;
  order: number;
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
  targetValue: doublePrecision("target_value").notNull(),
  difficulty: habitDifficultyEnum("difficulty").notNull(),
  goalType: habitGoalTypeEnum("goal_type").notNull(),
  isActive: boolean("is_active").notNull().default(true),
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
