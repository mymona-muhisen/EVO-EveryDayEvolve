-- Idempotently cover reverse-only reward.habit_id associations. Migration
-- 0002 may already be applied in environments where this relationship was
-- omitted from its original backfill.
UPDATE rewards r
SET journey_required = true
FROM habits h
WHERE (h.reward_id = r.id OR r.habit_id = h.id)
  AND h.user_id = r.user_id
  AND h.journey_start_date IS NOT NULL
  AND h.journey_length = 22
  AND r.is_redeemed = false
  AND r.journey_required = false;