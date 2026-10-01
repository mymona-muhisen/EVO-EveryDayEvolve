import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const rewardsTable = pgTable("rewards", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").references(() => habitsTable.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull(),
  emoji: text("emoji").notNull(),
  coinCost: integer("coin_cost").notNull(),
  isRedeemed: boolean("is_redeemed").notNull().default(false),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  journeyRequired: boolean("journey_required").notNull().default(false),
  journeyUnlockedAt: timestamp("journey_unlocked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RewardRow = typeof rewardsTable.$inferSelect;
