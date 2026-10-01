-- Additive Feature 05 persistence. Apply only to the development database
-- after confirming the target; do not backfill historical XP or grant rewards.
ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS journey_completed_at timestamptz;

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS xp_earned integer;

ALTER TABLE rewards
  ADD COLUMN IF NOT EXISTS journey_required boolean NOT NULL DEFAULT false;

ALTER TABLE rewards
  ADD COLUMN IF NOT EXISTS journey_unlocked_at timestamptz;

-- Journey day numbers are relative to each journey, while legacy snapshots
-- from before a journey may use the same numbers and must remain untouched.
ALTER TABLE habit_days
  DROP CONSTRAINT IF EXISTS habit_days_habit_day_unique;

-- Preserve the gate for already-selected, still-unredeemed 22-day rewards.
-- This records only association evidence; it does not infer completion or pay.
UPDATE rewards r
SET journey_required = true
FROM habits h
WHERE (h.reward_id = r.id OR r.habit_id = h.id)
  AND h.user_id = r.user_id
  AND h.journey_start_date IS NOT NULL
  AND h.journey_length = 22
  AND r.is_redeemed = false
  AND r.journey_required = false;