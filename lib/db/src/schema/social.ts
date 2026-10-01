import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { groupsTable } from "./groups";
import { habitCadenceEnum, habitsTable } from "./habits";

export const socialFriendRequestStatusEnum = pgEnum(
  "social_friend_request_status",
  ["pending", "accepted", "declined", "canceled"],
);
export const socialResourceTypeEnum = pgEnum("social_resource_type", [
  "journey",
  "memory",
  "reward",
  "character",
  "achievements",
]);
export const socialSharingVisibilityEnum = pgEnum(
  "social_sharing_visibility",
  ["private", "friends", "selected"],
);
export const socialReportReasonEnum = pgEnum("social_report_reason", [
  "spam",
  "inappropriate_content",
  "harassment",
  "other",
]);
export const socialReportStatusEnum = pgEnum("social_report_status", [
  "open",
  "reviewed",
  "closed",
]);
export const socialChallengeStatusEnum = pgEnum("social_challenge_status", [
  "active",
  "closed",
]);
export const socialChallengeMemberStatusEnum = pgEnum(
  "social_challenge_member_status",
  ["invited", "accepted", "declined", "left"],
);
export const socialGroupInvitationStatusEnum = pgEnum(
  "social_group_invitation_status",
  ["pending", "accepted", "declined", "canceled"],
);
export const socialEncouragementTypeEnum = pgEnum(
  "social_encouragement_type",
  ["cheer", "clap", "fire", "support"],
);
export const socialEncouragementTemplateEnum = pgEnum(
  "social_encouragement_template",
  ["nice_work", "keep_going", "great_job", "you_got_this", "keep_moving"],
);
export const socialActivityTypeEnum = pgEnum("social_activity_type", [
  "successful_day",
  "milestone",
  "journey_completed",
]);
export const socialGroupActivityTypeEnum = pgEnum(
  "social_group_activity_type",
  ["member_joined", "successful_day", "milestone", "journey_completed"],
);
export const socialNotificationTypeEnum = pgEnum("social_notification_type", [
  "friend_request_received",
  "friend_request_accepted",
  "challenge_invitation",
  "challenge_accepted",
  "challenge_declined",
  "group_invitation",
  "group_member_joined",
  "encouragement_received",
  "shared_milestone",
  "group_milestone",
]);

/** A private-by-default, owner-scoped ACL record. Profile preferences use resourceId="profile". */
export const socialSharesTable = pgTable(
  "social_shares",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    resourceType: socialResourceTypeEnum("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    visibility: socialSharingVisibilityEnum("visibility")
      .notNull()
      .default("private"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_shares_owner_resource_unique").on(
      table.ownerUserId,
      table.resourceType,
      table.resourceId,
    ),
    index("social_shares_resource_lookup_idx").on(
      table.resourceType,
      table.resourceId,
      table.visibility,
    ),
  ],
);

/** Normalized recipients; only populated for visibility="selected". */
export const socialShareRecipientsTable = pgTable(
  "social_share_recipients",
  {
    id: serial("id").primaryKey(),
    shareId: integer("share_id")
      .notNull()
      .references(() => socialSharesTable.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_share_recipients_share_user_unique").on(
      table.shareId,
      table.recipientUserId,
    ),
    index("social_share_recipients_user_idx").on(table.recipientUserId),
  ],
);

/**
 * Request rows retain their direction/history. pairUserLowId/pairUserHighId
 * are canonical (lexicographically sorted) so reverse-direction pending
 * requests cannot race into existence.
 */
export const socialFriendRequestsTable = pgTable(
  "social_friend_requests",
  {
    id: serial("id").primaryKey(),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    pairUserLowId: text("pair_user_low_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    pairUserHighId: text("pair_user_high_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: socialFriendRequestStatusEnum("status")
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "social_friend_requests_distinct_users_check",
      sql`${table.senderUserId} <> ${table.recipientUserId}`,
    ),
    check(
      "social_friend_requests_canonical_pair_check",
      sql`${table.pairUserLowId} < ${table.pairUserHighId}`,
    ),
    uniqueIndex("social_friend_requests_pending_pair_unique")
      .on(table.pairUserLowId, table.pairUserHighId)
      .where(sql`${table.status} = 'pending'`),
    index("social_friend_requests_incoming_idx").on(
      table.recipientUserId,
      table.status,
      table.createdAt,
    ),
    index("social_friend_requests_outgoing_idx").on(
      table.senderUserId,
      table.status,
      table.createdAt,
    ),
  ],
);

/** Canonical low/high user IDs make friendship identity direction-independent. */
export const socialFriendshipsTable = pgTable(
  "social_friendships",
  {
    id: serial("id").primaryKey(),
    userLowId: text("user_low_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    userHighId: text("user_high_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdFromRequestId: integer("created_from_request_id").references(
      () => socialFriendRequestsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "social_friendships_canonical_pair_check",
      sql`${table.userLowId} < ${table.userHighId}`,
    ),
    unique("social_friendships_pair_unique").on(
      table.userLowId,
      table.userHighId,
    ),
    index("social_friendships_low_user_idx").on(table.userLowId),
    index("social_friendships_high_user_idx").on(table.userHighId),
  ],
);

export const socialBlocksTable = pgTable(
  "social_blocks",
  {
    id: serial("id").primaryKey(),
    blockerUserId: text("blocker_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    blockedUserId: text("blocked_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "social_blocks_distinct_users_check",
      sql`${table.blockerUserId} <> ${table.blockedUserId}`,
    ),
    unique("social_blocks_pair_unique").on(
      table.blockerUserId,
      table.blockedUserId,
    ),
    index("social_blocks_blocked_user_idx").on(table.blockedUserId),
  ],
);

export const socialReportsTable = pgTable(
  "social_reports",
  {
    id: serial("id").primaryKey(),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    reportedUserId: text("reported_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    reason: socialReportReasonEnum("reason").notNull(),
    details: text("details"),
    status: socialReportStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "social_reports_distinct_users_check",
      sql`${table.reporterUserId} <> ${table.reportedUserId}`,
    ),
    check(
      "social_reports_details_length_check",
      sql`${table.details} IS NULL OR char_length(${table.details}) <= 1000`,
    ),
    index("social_reports_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export interface SocialChallengeHabitTemplate {
  title: string;
  emoji: string;
  category: string;
  cadence: "daily" | "weekdays" | "weekly" | "custom_days";
  customDays: number[] | null;
  unit: "minutes" | "count" | "pages" | "custom";
  executionType: "duration" | "count" | "boolean" | "limit";
  goalType: "build" | "quit";
  difficulty: "easy" | "medium" | "hard";
  suggestedTargetValue: number;
  suggestedMinimumValue: number;
}

export const socialChallengesTable = pgTable(
  "social_challenges",
  {
    id: serial("id").primaryKey(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    sourceHabitId: integer("source_habit_id").references(
      () => habitsTable.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    description: text("description"),
    durationDays: integer("duration_days").notNull().default(22),
    habitTemplate: jsonb("habit_template")
      .$type<SocialChallengeHabitTemplate>()
      .notNull(),
    status: socialChallengeStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "social_challenges_duration_check",
      sql`${table.durationDays} = 22`,
    ),
    index("social_challenges_creator_idx").on(
      table.creatorUserId,
      table.createdAt,
    ),
  ],
);

export const socialChallengeMembersTable = pgTable(
  "social_challenge_members",
  {
    id: serial("id").primaryKey(),
    challengeId: integer("challenge_id")
      .notNull()
      .references(() => socialChallengesTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    habitId: integer("habit_id").references(() => habitsTable.id, {
      onDelete: "set null",
    }),
    status: socialChallengeMemberStatusEnum("status")
      .notNull()
      .default("invited"),
    targetValueSnapshot: doublePrecision("target_value_snapshot"),
    minimumValueSnapshot: doublePrecision("minimum_value_snapshot"),
    cadenceSnapshot: habitCadenceEnum("cadence_snapshot"),
    customDaysSnapshot: integer("custom_days_snapshot").array(),
    timezoneSnapshot: text("timezone_snapshot"),
    journeyStartDate: date("journey_start_date", { mode: "string" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_challenge_members_challenge_user_unique").on(
      table.challengeId,
      table.userId,
    ),
    uniqueIndex("social_challenge_members_habit_unique")
      .on(table.habitId)
      .where(sql`${table.habitId} IS NOT NULL`),
    index("social_challenge_members_user_status_idx").on(
      table.userId,
      table.status,
    ),
  ],
);

export const socialGroupInvitationsTable = pgTable(
  "social_group_invitations",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groupsTable.id, { onDelete: "cascade" }),
    inviterUserId: text("inviter_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    inviteeUserId: text("invitee_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: socialGroupInvitationStatusEnum("status")
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "social_group_invitations_distinct_users_check",
      sql`${table.inviterUserId} <> ${table.inviteeUserId}`,
    ),
    uniqueIndex("social_group_invitations_pending_unique")
      .on(table.groupId, table.inviteeUserId)
      .where(sql`${table.status} = 'pending'`),
    index("social_group_invitations_incoming_idx").on(
      table.inviteeUserId,
      table.status,
      table.createdAt,
    ),
  ],
);

/** Explicit per-group journey consent; an ordinary group membership shares nothing. */
export const socialGroupJourneySharesTable = pgTable(
  "social_group_journey_shares",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groupsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habitsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_group_journey_shares_unique").on(
      table.groupId,
      table.userId,
      table.habitId,
    ),
    index("social_group_journey_shares_group_idx").on(
      table.groupId,
      table.userId,
    ),
  ],
);

/**
 * Deliberately has no failure/missed event type. Writers insert only successful
 * check-ins, positive milestones, or journey completion; readers re-check ACLs.
 */
export const socialActivityEventsTable = pgTable(
  "social_activity_events",
  {
    id: serial("id").primaryKey(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    eventType: socialActivityTypeEnum("event_type").notNull(),
    journeyId: integer("journey_id").references(() => habitsTable.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_activity_events_actor_key_unique").on(
      table.actorUserId,
      table.idempotencyKey,
    ),
    index("social_activity_events_created_idx").on(table.createdAt),
  ],
);

export const socialGroupActivityEventsTable = pgTable(
  "social_group_activity_events",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groupsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    eventType: socialGroupActivityTypeEnum("event_type").notNull(),
    journeyId: integer("journey_id").references(() => habitsTable.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_group_activity_events_group_key_unique").on(
      table.groupId,
      table.idempotencyKey,
    ),
    index("social_group_activity_events_created_idx").on(
      table.groupId,
      table.createdAt,
    ),
  ],
);

export const socialEncouragementsTable = pgTable(
  "social_encouragements",
  {
    id: serial("id").primaryKey(),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    receiverUserId: text("receiver_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    journeyId: integer("journey_id").references(() => habitsTable.id, {
      onDelete: "set null",
    }),
    type: socialEncouragementTypeEnum("type").notNull(),
    template: socialEncouragementTemplateEnum("template").notNull(),
    message: text("message"),
    requestId: text("request_id").notNull(),
    cooldownBucket: timestamp("cooldown_bucket", { withTimezone: true })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "social_encouragements_distinct_users_check",
      sql`${table.senderUserId} <> ${table.receiverUserId}`,
    ),
    check(
      "social_encouragements_message_length_check",
      sql`${table.message} IS NULL OR char_length(${table.message}) <= 120`,
    ),
    unique("social_encouragements_sender_request_unique").on(
      table.senderUserId,
      table.requestId,
    ),
    uniqueIndex("social_encouragements_minute_cooldown_unique").on(
      table.senderUserId,
      table.receiverUserId,
      table.cooldownBucket,
    ),
    index("social_encouragements_receiver_created_idx").on(
      table.receiverUserId,
      table.createdAt,
    ),
  ],
);

/** Reuses notifications storage across social actions; eventKey is service-generated and idempotent. */
export const socialNotificationsTable = pgTable(
  "social_notifications",
  {
    id: serial("id").primaryKey(),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    type: socialNotificationTypeEnum("type").notNull(),
    eventKey: text("event_key").notNull(),
    friendRequestId: integer("friend_request_id").references(
      () => socialFriendRequestsTable.id,
      { onDelete: "cascade" },
    ),
    groupInvitationId: integer("group_invitation_id").references(
      () => socialGroupInvitationsTable.id,
      { onDelete: "cascade" },
    ),
    groupId: integer("group_id").references(() => groupsTable.id, {
      onDelete: "cascade",
    }),
    challengeId: integer("challenge_id").references(
      () => socialChallengesTable.id,
      { onDelete: "cascade" },
    ),
    encouragementId: integer("encouragement_id").references(
      () => socialEncouragementsTable.id,
      { onDelete: "cascade" },
    ),
    safeData: jsonb("safe_data").$type<Record<string, string | number | boolean | null>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_notifications_recipient_event_unique").on(
      table.recipientUserId,
      table.eventKey,
    ),
    index("social_notifications_unread_idx").on(
      table.recipientUserId,
      table.readAt,
      table.createdAt,
    ),
  ],
);

export type SocialShareRow = typeof socialSharesTable.$inferSelect;
export type SocialShareRecipientRow =
  typeof socialShareRecipientsTable.$inferSelect;
export type SocialFriendRequestRow =
  typeof socialFriendRequestsTable.$inferSelect;
export type SocialFriendshipRow = typeof socialFriendshipsTable.$inferSelect;
export type SocialBlockRow = typeof socialBlocksTable.$inferSelect;
export type SocialReportRow = typeof socialReportsTable.$inferSelect;
export type SocialChallengeRow = typeof socialChallengesTable.$inferSelect;
export type SocialChallengeMemberRow =
  typeof socialChallengeMembersTable.$inferSelect;
export type SocialGroupInvitationRow =
  typeof socialGroupInvitationsTable.$inferSelect;
export type SocialGroupJourneyShareRow =
  typeof socialGroupJourneySharesTable.$inferSelect;
export type SocialActivityEventRow =
  typeof socialActivityEventsTable.$inferSelect;
export type SocialGroupActivityEventRow =
  typeof socialGroupActivityEventsTable.$inferSelect;
export type SocialEncouragementRow =
  typeof socialEncouragementsTable.$inferSelect;
export type SocialNotificationRow =
  typeof socialNotificationsTable.$inferSelect;