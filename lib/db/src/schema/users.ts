import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const motivationStyleEnum = pgEnum("motivation_style", [
  "encouraging",
  "tough_love",
  "data_driven",
]);

// Shared between users.primaryGoalCategory and habits.category — same
// value set in the OpenAPI spec, so one Postgres enum backs both.
export const goalCategoryEnum = pgEnum("goal_category", [
  "health",
  "learning",
  "productivity",
  "mindfulness",
  "social",
  "creativity",
  "finance",
  "custom",
]);

export const usersTable = pgTable("users", {
  // Clerk user id (e.g. "user_xxx") — used directly as the primary key.
  id: text("id").primaryKey(),
  // Nullable for existing users until they choose a unique social username.
  username: text("username"),
  displayName: text("display_name").notNull(),
  avatarEmoji: text("avatar_emoji").notNull().default("🌱"),
  level: integer("level").notNull().default(1),
  xp: integer("xp").notNull().default(0),
  coins: integer("coins").notNull().default(0),
  motivationStyle: motivationStyleEnum("motivation_style")
    .notNull()
    .default("encouraging"),
  primaryGoalCategory: goalCategoryEnum("primary_goal_category"),
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  check(
    "users_username_format_check",
    sql`${table.username} IS NULL OR ${table.username} ~ '^[a-z0-9_]{3,24}$'`,
  ),
  uniqueIndex("users_username_lower_unique")
    .on(sql`lower(${table.username})`)
    .where(sql`${table.username} IS NOT NULL`),
]);

export type UserRow = typeof usersTable.$inferSelect;
