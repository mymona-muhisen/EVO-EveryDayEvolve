import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const journeyRewardTypeEnum = pgEnum("journey_reward_type", ["physical", "experience"]);
export const journeyRewardStatusEnum = pgEnum("journey_reward_status", [
  "pending",
  "unlocked",
  "claimed",
]);

export const journeyRewardsTable = pgTable("journey_rewards", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").references(() => habitsTable.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull(),
  type: journeyRewardTypeEnum("type").notNull(),
  description: text("description"),
  // Only normalized private object paths (e.g. /objects/uploads/<id>) are persisted.
  imageUrl: text("image_url"),
  estimatedValue: doublePrecision("estimated_value"),
  status: journeyRewardStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  unlockedAt: timestamp("unlocked_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("journey_rewards_habit_unique").on(table.habitId),
  index("journey_rewards_owner_created_idx").on(table.userId, table.createdAt),
  index("journey_rewards_image_url_idx").on(table.imageUrl),
]);

export type JourneyRewardRow = typeof journeyRewardsTable.$inferSelect;
export type NewJourneyReward = typeof journeyRewardsTable.$inferInsert;
