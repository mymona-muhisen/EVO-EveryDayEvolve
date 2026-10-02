-- Additive only. Unknown legacy intentions must remain unknown, not backfilled
-- from a target that might already have been adapted.
ALTER TABLE habits ADD COLUMN IF NOT EXISTS original_goal text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS desired_target double precision;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS desired_unit habit_unit;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS recommended_starting_target double precision;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS origin jsonb;