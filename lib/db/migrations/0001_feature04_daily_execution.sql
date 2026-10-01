-- Additive Feature 04 schema migration. Apply in development after confirming
-- the connected database is the intended development database; never use a
-- destructive schema push to deploy this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'habit_execution_type') THEN
    CREATE TYPE habit_execution_type AS ENUM ('duration', 'count', 'boolean', 'limit');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'daily_execution_status') THEN
    CREATE TYPE daily_execution_status AS ENUM (
      'pending', 'in_progress', 'paused', 'minimum_reached', 'target_reached',
      'pending_reflection', 'completed', 'missed', 'recovery_available',
      'recovery_active', 'recovered'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'daily_adaptation_decision') THEN
    CREATE TYPE daily_adaptation_decision AS ENUM ('accepted', 'rejected');
  END IF;
END;
$$;

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS execution_type habit_execution_type,
  ADD COLUMN IF NOT EXISTS recovery_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_limit integer NOT NULL DEFAULT 2;

ALTER TABLE habit_days
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS unit habit_unit,
  ADD COLUMN IF NOT EXISTS execution_type habit_execution_type,
  ADD COLUMN IF NOT EXISTS cue_type habit_cue_type,
  ADD COLUMN IF NOT EXISTS cue_time text,
  ADD COLUMN IF NOT EXISTS cue text,
  ADD COLUMN IF NOT EXISTS start_action text;

CREATE TABLE IF NOT EXISTS habit_daily_executions (
  id serial PRIMARY KEY,
  habit_id integer NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date date NOT NULL,
  day_number integer NOT NULL,
  scheduled boolean NOT NULL DEFAULT true,
  title text NOT NULL,
  target_value double precision NOT NULL,
  minimum_value double precision NOT NULL,
  busy_day_value double precision,
  success_limit_value double precision,
  goal_type habit_goal_type NOT NULL,
  execution_type habit_execution_type NOT NULL,
  unit habit_unit NOT NULL,
  plan_revision integer NOT NULL DEFAULT 0,
  cue_type habit_cue_type,
  cue_time text,
  cue text,
  start_action text,
  status daily_execution_status NOT NULL DEFAULT 'pending',
  actual_value double precision,
  actual_seconds integer,
  elapsed_base_seconds integer NOT NULL DEFAULT 0,
  segment_paused_seconds integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  last_resumed_at timestamptz,
  paused_at timestamptz,
  paused_seconds integer NOT NULL DEFAULT 0,
  finished_at timestamptz,
  missed_reason missed_reason,
  note text,
  difficulty checkin_difficulty,
  revision integer NOT NULL DEFAULT 0,
  adaptation_decision daily_adaptation_decision,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT habit_daily_executions_habit_date_unique UNIQUE (habit_id, date)
);

ALTER TABLE habit_daily_executions
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS busy_day_value double precision,
  ADD COLUMN IF NOT EXISTS plan_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS elapsed_base_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS segment_paused_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cue_type habit_cue_type,
  ADD COLUMN IF NOT EXISTS cue_time text,
  ADD COLUMN IF NOT EXISTS cue text,
  ADD COLUMN IF NOT EXISTS start_action text;

CREATE TABLE IF NOT EXISTS habit_daily_action_keys (
  id serial PRIMARY KEY,
  habit_id integer NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date date NOT NULL,
  idempotency_key text NOT NULL,
  action text NOT NULL,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT habit_daily_action_keys_unique UNIQUE (habit_id, date, idempotency_key)
);

ALTER TABLE habit_daily_action_keys
  ADD COLUMN IF NOT EXISTS request_fingerprint text;
UPDATE habit_daily_action_keys
SET request_fingerprint = ''
WHERE request_fingerprint IS NULL;
ALTER TABLE habit_daily_action_keys
  ALTER COLUMN request_fingerprint SET NOT NULL;