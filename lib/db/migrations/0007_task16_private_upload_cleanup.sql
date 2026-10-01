ALTER TABLE object_uploads
  ADD COLUMN IF NOT EXISTS unreferenced_since timestamptz;

ALTER TABLE object_uploads
  ADD COLUMN IF NOT EXISTS last_cleanup_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS object_uploads_cleanup_idx
  ON object_uploads (unreferenced_since, last_cleanup_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS journey_rewards_image_url_idx
  ON journey_rewards (image_url);

CREATE INDEX IF NOT EXISTS memories_photo_object_path_idx
  ON memories (photo_object_path);

CREATE INDEX IF NOT EXISTS groups_cover_object_path_idx
  ON groups (cover_object_path);