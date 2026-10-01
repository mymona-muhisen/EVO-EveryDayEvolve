-- Feature 09: additive social contract. Existing users, groups, reactions, and
-- memories are preserved; old records receive private/invite-only defaults and
-- no share rows or social activity are backfilled.

CREATE TYPE "group_privacy" AS ENUM ('invite_only');
CREATE TYPE "group_member_role" AS ENUM ('owner', 'member');
CREATE TYPE "social_friend_request_status" AS ENUM ('pending', 'accepted', 'declined', 'canceled');
CREATE TYPE "social_resource_type" AS ENUM ('journey', 'memory', 'reward', 'character', 'achievements');
CREATE TYPE "social_sharing_visibility" AS ENUM ('private', 'friends', 'selected');
CREATE TYPE "social_report_reason" AS ENUM ('spam', 'inappropriate_content', 'harassment', 'other');
CREATE TYPE "social_report_status" AS ENUM ('open', 'reviewed', 'closed');
CREATE TYPE "social_challenge_status" AS ENUM ('active', 'closed');
CREATE TYPE "social_challenge_member_status" AS ENUM ('invited', 'accepted', 'declined', 'left');
CREATE TYPE "social_group_invitation_status" AS ENUM ('pending', 'accepted', 'declined', 'canceled');
CREATE TYPE "social_encouragement_type" AS ENUM ('cheer', 'clap', 'fire', 'support');
CREATE TYPE "social_encouragement_template" AS ENUM ('nice_work', 'keep_going', 'great_job', 'you_got_this', 'keep_moving');
CREATE TYPE "social_activity_type" AS ENUM ('successful_day', 'milestone', 'journey_completed');
CREATE TYPE "social_group_activity_type" AS ENUM ('member_joined', 'successful_day', 'milestone', 'journey_completed');
CREATE TYPE "social_notification_type" AS ENUM (
  'friend_request_received',
  'friend_request_accepted',
  'challenge_invitation',
  'challenge_accepted',
  'challenge_declined',
  'group_invitation',
  'group_member_joined',
  'encouragement_received',
  'shared_milestone',
  'group_milestone'
);

ALTER TABLE "users" ADD COLUMN "username" text;
ALTER TABLE "users"
  ADD CONSTRAINT "users_username_format_check"
  CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9_]{3,24}$');
CREATE UNIQUE INDEX "users_username_lower_unique"
  ON "users" USING btree (lower("username"))
  WHERE "username" IS NOT NULL;

ALTER TABLE "groups"
  ADD COLUMN "description" text,
  ADD COLUMN "privacy" "group_privacy" DEFAULT 'invite_only' NOT NULL,
  ADD COLUMN "max_members" integer DEFAULT 30 NOT NULL,
  ADD COLUMN "cover_object_path" text,
  ADD COLUMN "cover_updated_at" timestamp with time zone;
ALTER TABLE "groups"
  ADD CONSTRAINT "groups_max_members_check"
  CHECK ("max_members" BETWEEN 2 AND 30);

ALTER TABLE "group_members"
  ADD COLUMN "role" "group_member_role" DEFAULT 'member' NOT NULL;
UPDATE "group_members" AS gm
  SET "role" = 'owner'
  FROM "groups" AS g
  WHERE gm."group_id" = g."id"
    AND gm."user_id" = g."created_by";

ALTER TABLE "group_reactions"
  ADD COLUMN "template_code" text,
  ADD COLUMN "message" text,
  ADD COLUMN "request_id" text,
  ADD COLUMN "cooldown_bucket" timestamp with time zone;
ALTER TABLE "group_reactions"
  ADD CONSTRAINT "group_reactions_message_length_check"
  CHECK ("message" IS NULL OR char_length("message") <= 120);
ALTER TABLE "group_reactions"
  ADD CONSTRAINT "group_reactions_template_code_check"
  CHECK ("template_code" IS NULL OR "template_code" IN (
    'nice_work', 'keep_going', 'great_job', 'you_got_this', 'keep_moving'
  ));
CREATE UNIQUE INDEX "group_reactions_sender_request_unique"
  ON "group_reactions" USING btree ("from_user_id", "request_id")
  WHERE "request_id" IS NOT NULL;
CREATE UNIQUE INDEX "group_reactions_minute_cooldown_unique"
  ON "group_reactions" USING btree (
    "group_id",
    "from_user_id",
    COALESCE("to_user_id", ''),
    "cooldown_bucket"
  )
  WHERE "cooldown_bucket" IS NOT NULL;

CREATE TABLE "social_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource_type" "social_resource_type" NOT NULL,
  "resource_id" text NOT NULL,
  "visibility" "social_sharing_visibility" DEFAULT 'private' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_shares_owner_resource_unique"
    UNIQUE ("owner_user_id", "resource_type", "resource_id")
);
CREATE INDEX "social_shares_resource_lookup_idx"
  ON "social_shares" USING btree ("resource_type", "resource_id", "visibility");

CREATE TABLE "social_share_recipients" (
  "id" serial PRIMARY KEY NOT NULL,
  "share_id" integer NOT NULL REFERENCES "social_shares"("id") ON DELETE CASCADE,
  "recipient_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_share_recipients_share_user_unique" UNIQUE ("share_id", "recipient_user_id")
);
CREATE INDEX "social_share_recipients_user_idx"
  ON "social_share_recipients" USING btree ("recipient_user_id");

CREATE TABLE "social_friend_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "sender_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recipient_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "pair_user_low_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "pair_user_high_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" "social_friend_request_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "responded_at" timestamp with time zone,
  CONSTRAINT "social_friend_requests_distinct_users_check" CHECK ("sender_user_id" <> "recipient_user_id"),
  CONSTRAINT "social_friend_requests_canonical_pair_check" CHECK ("pair_user_low_id" < "pair_user_high_id")
);
CREATE UNIQUE INDEX "social_friend_requests_pending_pair_unique"
  ON "social_friend_requests" USING btree ("pair_user_low_id", "pair_user_high_id")
  WHERE "status" = 'pending';
CREATE INDEX "social_friend_requests_incoming_idx"
  ON "social_friend_requests" USING btree ("recipient_user_id", "status", "created_at");
CREATE INDEX "social_friend_requests_outgoing_idx"
  ON "social_friend_requests" USING btree ("sender_user_id", "status", "created_at");

CREATE TABLE "social_friendships" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_low_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "user_high_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_from_request_id" integer REFERENCES "social_friend_requests"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_friendships_canonical_pair_check" CHECK ("user_low_id" < "user_high_id"),
  CONSTRAINT "social_friendships_pair_unique" UNIQUE ("user_low_id", "user_high_id")
);
CREATE INDEX "social_friendships_low_user_idx"
  ON "social_friendships" USING btree ("user_low_id");
CREATE INDEX "social_friendships_high_user_idx"
  ON "social_friendships" USING btree ("user_high_id");

CREATE TABLE "social_blocks" (
  "id" serial PRIMARY KEY NOT NULL,
  "blocker_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_blocks_distinct_users_check" CHECK ("blocker_user_id" <> "blocked_user_id"),
  CONSTRAINT "social_blocks_pair_unique" UNIQUE ("blocker_user_id", "blocked_user_id")
);
CREATE INDEX "social_blocks_blocked_user_idx"
  ON "social_blocks" USING btree ("blocked_user_id");

CREATE TABLE "social_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "reporter_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reported_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" "social_report_reason" NOT NULL,
  "details" text,
  "status" "social_report_status" DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_reports_distinct_users_check" CHECK ("reporter_user_id" <> "reported_user_id"),
  CONSTRAINT "social_reports_details_length_check" CHECK ("details" IS NULL OR char_length("details") <= 1000)
);
CREATE INDEX "social_reports_status_created_idx"
  ON "social_reports" USING btree ("status", "created_at");

CREATE TABLE "social_challenges" (
  "id" serial PRIMARY KEY NOT NULL,
  "creator_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source_habit_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "duration_days" integer DEFAULT 22 NOT NULL,
  "habit_template" jsonb NOT NULL,
  "status" "social_challenge_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "social_challenges_duration_check" CHECK ("duration_days" = 22)
);
CREATE INDEX "social_challenges_creator_idx"
  ON "social_challenges" USING btree ("creator_user_id", "created_at");

CREATE TABLE "social_challenge_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "challenge_id" integer NOT NULL REFERENCES "social_challenges"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "habit_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "status" "social_challenge_member_status" DEFAULT 'invited' NOT NULL,
  "target_value_snapshot" double precision,
  "minimum_value_snapshot" double precision,
  "cadence_snapshot" "habit_cadence",
  "custom_days_snapshot" integer[],
  "timezone_snapshot" text,
  "journey_start_date" date,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_challenge_members_challenge_user_unique" UNIQUE ("challenge_id", "user_id")
);
CREATE UNIQUE INDEX "social_challenge_members_habit_unique"
  ON "social_challenge_members" USING btree ("habit_id")
  WHERE "habit_id" IS NOT NULL;
CREATE INDEX "social_challenge_members_user_status_idx"
  ON "social_challenge_members" USING btree ("user_id", "status");

CREATE TABLE "social_group_invitations" (
  "id" serial PRIMARY KEY NOT NULL,
  "group_id" integer NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "inviter_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "invitee_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" "social_group_invitation_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "responded_at" timestamp with time zone,
  CONSTRAINT "social_group_invitations_distinct_users_check" CHECK ("inviter_user_id" <> "invitee_user_id")
);
CREATE UNIQUE INDEX "social_group_invitations_pending_unique"
  ON "social_group_invitations" USING btree ("group_id", "invitee_user_id")
  WHERE "status" = 'pending';
CREATE INDEX "social_group_invitations_incoming_idx"
  ON "social_group_invitations" USING btree ("invitee_user_id", "status", "created_at");

CREATE TABLE "social_group_journey_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "group_id" integer NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "habit_id" integer NOT NULL REFERENCES "habits"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_group_journey_shares_unique" UNIQUE ("group_id", "user_id", "habit_id")
);
CREATE INDEX "social_group_journey_shares_group_idx"
  ON "social_group_journey_shares" USING btree ("group_id", "user_id");

CREATE TABLE "social_activity_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" "social_activity_type" NOT NULL,
  "journey_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_activity_events_actor_key_unique" UNIQUE ("actor_user_id", "idempotency_key")
);
CREATE INDEX "social_activity_events_created_idx"
  ON "social_activity_events" USING btree ("created_at");

CREATE TABLE "social_group_activity_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "group_id" integer NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "actor_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" "social_group_activity_type" NOT NULL,
  "journey_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_group_activity_events_group_key_unique" UNIQUE ("group_id", "idempotency_key")
);
CREATE INDEX "social_group_activity_events_created_idx"
  ON "social_group_activity_events" USING btree ("group_id", "created_at");

CREATE TABLE "social_encouragements" (
  "id" serial PRIMARY KEY NOT NULL,
  "sender_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "receiver_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "journey_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "type" "social_encouragement_type" NOT NULL,
  "template" "social_encouragement_template" NOT NULL,
  "message" text,
  "request_id" text NOT NULL,
  "cooldown_bucket" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_encouragements_distinct_users_check" CHECK ("sender_user_id" <> "receiver_user_id"),
  CONSTRAINT "social_encouragements_message_length_check" CHECK ("message" IS NULL OR char_length("message") <= 120),
  CONSTRAINT "social_encouragements_sender_request_unique" UNIQUE ("sender_user_id", "request_id")
);
CREATE UNIQUE INDEX "social_encouragements_minute_cooldown_unique"
  ON "social_encouragements" USING btree ("sender_user_id", "receiver_user_id", "cooldown_bucket");
CREATE INDEX "social_encouragements_receiver_created_idx"
  ON "social_encouragements" USING btree ("receiver_user_id", "created_at");

CREATE TABLE "social_notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "recipient_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "type" "social_notification_type" NOT NULL,
  "event_key" text NOT NULL,
  "friend_request_id" integer REFERENCES "social_friend_requests"("id") ON DELETE CASCADE,
  "group_invitation_id" integer REFERENCES "social_group_invitations"("id") ON DELETE CASCADE,
  "group_id" integer REFERENCES "groups"("id") ON DELETE CASCADE,
  "challenge_id" integer REFERENCES "social_challenges"("id") ON DELETE CASCADE,
  "encouragement_id" integer REFERENCES "social_encouragements"("id") ON DELETE CASCADE,
  "safe_data" jsonb,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_notifications_recipient_event_unique" UNIQUE ("recipient_user_id", "event_key")
);
CREATE INDEX "social_notifications_unread_idx"
  ON "social_notifications" USING btree ("recipient_user_id", "read_at", "created_at");