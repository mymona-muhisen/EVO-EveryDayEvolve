import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Global catalog — seeded once, shared by all users.
export const journeyMilestonesTable = pgTable("journey_milestones", {
  id: serial("id").primaryKey(),
  levelRequired: integer("level_required").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  emoji: text("emoji").notNull(),
  rewardCoins: integer("reward_coins").notNull(),
});

// Recorded the moment a user's level crosses a milestone's levelRequired —
// makes "reached" a simple existence check and guarantees rewardCoins are
// granted exactly once per user per milestone.
export const userJourneyMilestonesTable = pgTable(
  "user_journey_milestones",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    milestoneId: integer("milestone_id")
      .notNull()
      .references(() => journeyMilestonesTable.id, { onDelete: "cascade" }),
    reachedAt: timestamp("reached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("user_journey_milestones_user_milestone_unique").on(
      table.userId,
      table.milestoneId,
    ),
  ],
);

export type JourneyMilestoneRow = typeof journeyMilestonesTable.$inferSelect;
export type UserJourneyMilestoneRow =
  typeof userJourneyMilestonesTable.$inferSelect;
