import {
  pgTable,
  serial,
  integer,
  text,
  date,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const groupsTable = pgTable("groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  goalDescription: text("goal_description").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const groupMembersTable = pgTable(
  "group_members",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groupsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("group_members_group_user_unique").on(table.groupId, table.userId),
  ],
);

export const groupReactionsTable = pgTable("group_reactions", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id")
    .notNull()
    .references(() => groupsTable.id, { onDelete: "cascade" }),
  fromUserId: text("from_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  toUserId: text("to_user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GroupRow = typeof groupsTable.$inferSelect;
export type GroupMemberRow = typeof groupMembersTable.$inferSelect;
export type GroupReactionRow = typeof groupReactionsTable.$inferSelect;
