CREATE TYPE "memory_visibility" AS ENUM ('private', 'friends', 'selected', 'public');

ALTER TABLE "memories"
  ADD COLUMN "habit_day_id" integer REFERENCES "habit_days"("id") ON DELETE SET NULL,
  ADD COLUMN "caption" text,
  ADD COLUMN "visibility" "memory_visibility" DEFAULT 'private' NOT NULL,
  ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

UPDATE "memories" SET "updated_at" = "created_at";

CREATE UNIQUE INDEX "memories_habit_day_unique"
  ON "memories" USING btree ("habit_day_id")
  WHERE "habit_day_id" IS NOT NULL;

CREATE INDEX "memories_owner_date_idx"
  ON "memories" USING btree ("user_id", "date" DESC);