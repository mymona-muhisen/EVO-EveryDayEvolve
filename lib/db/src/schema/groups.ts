import {
  pgEnum,
  pgTable,
  serial,
  integer,
  text,
  date,
  timestamp,
  unique,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const groupPrivacyEnum = pgEnum("group_privacy", ["invite_only"]);
export const groupMemberRoleEnum = pgEnum("group_member_role", ["owner", "member"]);

export const groupsTable = pgTable("groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  goalDescription: text("goal_description").notNull(),
  description: text("description"),
  privacy: groupPrivacyEnum("privacy").notNull().default("invite_only"),
  maxMembers: integer("max_members").notNull().default(30),
  coverObjectPath: text("cover_object_path"),
  coverUpdatedAt: timestamp("cover_updated_at", { withTimezone: true }),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  check("groups_max_members_check", sql`${table.maxMembers} BETWEEN 2 AND 30`),
]);

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
    role: groupMemberRoleEnum("role").notNull().default("member"),
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
  templateCode: text("template_code"),
  message: text("message"),
  requestId: text("request_id"),
  cooldownBucket: timestamp("cooldown_bucket", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  check(
    "group_reactions_message_length_check",
    sql`${table.message} IS NULL OR char_length(${table.message}) <= 120`,
  ),
  check(
    "group_reactions_template_code_check",
    sql`${table.templateCode} IS NULL OR ${table.templateCode} IN ('nice_work', 'keep_going', 'great_job', 'you_got_this', 'keep_moving')`,
  ),
  uniqueIndex("group_reactions_sender_request_unique")
    .on(table.fromUserId, table.requestId)
    .where(sql`${table.requestId} IS NOT NULL`),
  uniqueIndex("group_reactions_minute_cooldown_unique")
    .on(
      table.groupId,
      table.fromUserId,
      sql`COALESCE(${table.toUserId}, '')`,
      table.cooldownBucket,
    )
    .where(sql`${table.cooldownBucket} IS NOT NULL`),
]);

export type GroupRow = typeof groupsTable.$inferSelect;
export type GroupMemberRow = typeof groupMembersTable.$inferSelect;
export type GroupReactionRow = typeof groupReactionsTable.$inferSelect;
