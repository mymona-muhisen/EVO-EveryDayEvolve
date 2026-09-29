import { pgEnum, pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

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
});

export type UserRow = typeof usersTable.$inferSelect;
