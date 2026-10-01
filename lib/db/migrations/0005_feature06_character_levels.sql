-- Development schema migration. Managed production schema is applied by Publish.
-- Existing catalog IDs, prices, ownership, equipped state, XP, and coins stay unchanged.
BEGIN;
ALTER TABLE character_items
  ADD COLUMN IF NOT EXISTS level_required integer NOT NULL DEFAULT 0;
COMMIT;