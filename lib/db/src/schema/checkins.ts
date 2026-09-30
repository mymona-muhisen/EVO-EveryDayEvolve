import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  date,
  doublePrecision,
  timestamp,
  unique,
  pgEnum,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const checkinDifficultyEnum = pgEnum("checkin_difficulty", [
  "easy",
  "normal",
  "hard",
  "very_hard",
]);
export const missedReasonEnum = pgEnum("missed_reason", [
  "too_difficult",
  "no_time",
  "forgot",
  "lost_motivation",
  "unexpected",
  "other",
]);

export const checkinsTable = pgTable(
  "checkins",
  {
    id: serial("id").primaryKey(),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habitsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    completed: boolean("completed").notNull(),
    value: doublePrecision("value"),
    note: text("note"),
    moodRating: integer("mood_rating"),
    difficulty: checkinDifficultyEnum("difficulty"),
    missedReason: missedReasonEnum("missed_reason"),
    targetSnapshot: doublePrecision("target_snapshot"),
    minimumSnapshot: doublePrecision("minimum_snapshot"),
    successLimitSnapshot: doublePrecision("success_limit_snapshot"),
    targetCompleted: boolean("target_completed").notNull().default(false),
    rewardGranted: boolean("reward_granted").notNull().default(false),
    coinsEarned: integer("coins_earned").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("checkins_habit_date_unique").on(table.habitId, table.date)],
);

export type CheckinRow = typeof checkinsTable.$inferSelect;
