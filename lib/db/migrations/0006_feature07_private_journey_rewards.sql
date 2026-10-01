CREATE TYPE "journey_reward_type" AS ENUM ('physical', 'experience');
CREATE TYPE "journey_reward_status" AS ENUM ('pending', 'unlocked', 'claimed');

CREATE TABLE "journey_rewards" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "habit_id" integer REFERENCES "habits"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "type" "journey_reward_type" NOT NULL,
  "description" text,
  "image_url" text,
  "estimated_value" double precision,
  "status" "journey_reward_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unlocked_at" timestamp with time zone,
  "claimed_at" timestamp with time zone
);

CREATE UNIQUE INDEX "journey_rewards_habit_unique" ON "journey_rewards" USING btree ("habit_id");
CREATE INDEX "journey_rewards_owner_created_idx" ON "journey_rewards" USING btree ("user_id", "created_at");

CREATE TABLE "object_uploads" (
  "object_path" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "object_uploads_owner_idx" ON "object_uploads" USING btree ("user_id");