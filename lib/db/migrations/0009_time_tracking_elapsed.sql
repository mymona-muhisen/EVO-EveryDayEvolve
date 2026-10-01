ALTER TABLE "tracking_sessions"
  ADD COLUMN "active_elapsed_ms" integer NOT NULL DEFAULT 0,
  ADD COLUMN "interval_elapsed_ms" integer NOT NULL DEFAULT 0,
  ADD COLUMN "timer_anchor_at" timestamp with time zone;

-- Legacy sessions did not persist accumulated active time or pause boundaries.
-- Start a new, known measurement baseline now rather than inferring earlier time.
UPDATE "tracking_sessions"
SET "timer_anchor_at" = now(),
    "active_elapsed_ms" = 0,
    "interval_elapsed_ms" = 0
WHERE "status" = 'active';

UPDATE "tracking_sessions" SET "next_checkin_at" = NULL;