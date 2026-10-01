import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";
import sharp from "sharp";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryDir = resolve(apiDir, "../..");
const dbDir = resolve(repositoryDir, "lib/db");
const databaseUrl =
  process.env.API_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "PostgreSQL reward integration tests require API_TEST_DATABASE_URL, TEST_DATABASE_URL, or DATABASE_URL.",
  );
}

const originalDatabaseUrl = process.env.DATABASE_URL;
const schema = `api_reward_it_${randomUUID().replaceAll("-", "")}`;
const quote = (name) => `"${schema}"."${name}"`;
const scopedUrl = new URL(databaseUrl);
const currentOptions = scopedUrl.searchParams.get("options");
scopedUrl.searchParams.set(
  "options",
  [currentOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
);
process.env.DATABASE_URL = scopedUrl.toString();

const dbRequire = createRequire(join(dbDir, "package.json"));
const { Pool } = dbRequire("pg");
const pgEntry = dbRequire.resolve("pg");
const adminPool = new Pool({ connectionString: databaseUrl });
const servicePools = [];
let tempDir;
let cleanupStarted = false;

const ddl = [
  `CREATE SCHEMA "${schema}"`,
  `CREATE TYPE ${quote("motivation_style")} AS ENUM ('encouraging', 'tough_love', 'data_driven')`,
  `CREATE TYPE ${quote("goal_category")} AS ENUM ('health', 'learning', 'productivity', 'mindfulness', 'social', 'creativity', 'finance', 'custom')`,
  `CREATE TYPE ${quote("habit_cadence")} AS ENUM ('daily', 'weekdays', 'weekly', 'custom_days')`,
  `CREATE TYPE ${quote("habit_unit")} AS ENUM ('minutes', 'count', 'pages', 'custom')`,
  `CREATE TYPE ${quote("habit_difficulty")} AS ENUM ('easy', 'medium', 'hard')`,
  `CREATE TYPE ${quote("habit_goal_type")} AS ENUM ('build', 'quit')`,
  `CREATE TYPE ${quote("habit_cue_type")} AS ENUM ('time', 'routine', 'custom')`,
  `CREATE TYPE ${quote("habit_execution_type")} AS ENUM ('duration', 'count', 'boolean', 'limit')`,
  `CREATE TYPE ${quote("daily_execution_status")} AS ENUM ('pending', 'in_progress', 'paused', 'minimum_reached', 'target_reached', 'pending_reflection', 'completed', 'missed', 'recovery_available', 'recovery_active', 'recovered')`,
  `CREATE TYPE ${quote("daily_adaptation_decision")} AS ENUM ('accepted', 'rejected')`,
  `CREATE TYPE ${quote("checkin_difficulty")} AS ENUM ('easy', 'normal', 'hard', 'very_hard')`,
  `CREATE TYPE ${quote("missed_reason")} AS ENUM ('too_difficult', 'no_time', 'forgot', 'lost_motivation', 'unexpected', 'other')`,
  `CREATE TYPE ${quote("coin_transaction_reason")} AS ENUM ('checkin', 'streak_bonus', 'streak_recovery', 'reward_redemption', 'item_purchase', 'challenge_bonus', 'manual')`,
  `CREATE TYPE ${quote("journey_reward_type")} AS ENUM ('physical', 'experience')`,
  `CREATE TYPE ${quote("journey_reward_status")} AS ENUM ('pending', 'unlocked', 'claimed')`,
  `CREATE TYPE ${quote("memory_visibility")} AS ENUM ('private', 'friends', 'selected', 'public')`,
  `CREATE TYPE ${quote("social_activity_type")} AS ENUM ('successful_day', 'milestone', 'journey_completed')`,
  `CREATE TYPE ${quote("social_resource_type")} AS ENUM ('journey', 'memory', 'reward', 'character', 'achievements')`,
  `CREATE TYPE ${quote("social_sharing_visibility")} AS ENUM ('private', 'friends', 'selected')`,
  `CREATE TYPE ${quote("social_group_activity_type")} AS ENUM ('member_joined', 'successful_day', 'milestone', 'journey_completed')`,
  `CREATE TYPE ${quote("social_notification_type")} AS ENUM ('friend_request_received', 'friend_request_accepted', 'challenge_invitation', 'challenge_accepted', 'challenge_declined', 'group_invitation', 'group_member_joined', 'encouragement_received', 'shared_milestone', 'group_milestone')`,
  `CREATE TYPE ${quote("group_privacy")} AS ENUM ('invite_only')`,
  `CREATE TYPE ${quote("group_member_role")} AS ENUM ('owner', 'member')`,
  `CREATE TYPE ${quote("character_item_slot")} AS ENUM ('outfit', 'hat', 'accessory', 'pet', 'background')`,
  `CREATE TABLE ${quote("users")} (
    id text PRIMARY KEY,
    username text UNIQUE,
    display_name text NOT NULL,
    avatar_emoji text NOT NULL DEFAULT '🌱',
    level integer NOT NULL DEFAULT 1,
    xp integer NOT NULL DEFAULT 0,
    coins integer NOT NULL DEFAULT 0,
    motivation_style ${quote("motivation_style")} NOT NULL DEFAULT 'encouraging',
    primary_goal_category ${quote("goal_category")},
    onboarding_completed boolean NOT NULL DEFAULT false,
    timezone text NOT NULL DEFAULT 'UTC',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("character_items")} (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE,
    slot ${quote("character_item_slot")} NOT NULL, emoji text NOT NULL,
    coin_cost integer NOT NULL, level_required integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE ${quote("user_character_items")} (
    id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    item_id integer NOT NULL REFERENCES ${quote("character_items")}(id) ON DELETE CASCADE,
    equipped boolean NOT NULL DEFAULT false, purchased_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, item_id)
  )`,
  `CREATE TABLE ${quote("tracking_sessions")} (
    id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    date date NOT NULL, status text NOT NULL DEFAULT 'active',
    interval_minutes integer NOT NULL DEFAULT 15, started_at timestamptz NOT NULL DEFAULT now(),
    last_checkin_at timestamptz, next_checkin_at timestamptz, finished_at timestamptz,
    UNIQUE(user_id, date)
  )`,
  `CREATE TABLE ${quote("day_analysis_cache")} (
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    date date NOT NULL, data_hash text NOT NULL, analysis jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, date)
  )`,
  `CREATE TABLE ${quote("habits")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    title text NOT NULL,
    emoji text NOT NULL,
    category ${quote("goal_category")} NOT NULL,
    cadence ${quote("habit_cadence")} NOT NULL,
    custom_days integer[],
    unit ${quote("habit_unit")} NOT NULL,
    execution_type ${quote("habit_execution_type")},
    target_value double precision NOT NULL,
    minimum_value double precision,
    busy_day_value double precision,
    baseline_value double precision,
    success_limit_value double precision,
    cue_type ${quote("habit_cue_type")},
    cue_time text,
    cue text,
    start_action text,
    friction text,
    minimum_floor double precision,
    journey_start_date date,
    journey_length integer,
    journey_completed_at timestamptz,
    reward_id integer,
    difficulty ${quote("habit_difficulty")} NOT NULL,
    goal_type ${quote("habit_goal_type")} NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    recovery_enabled boolean NOT NULL DEFAULT false,
    recovery_used integer NOT NULL DEFAULT 0,
    recovery_limit integer NOT NULL DEFAULT 2,
    current_streak integer NOT NULL DEFAULT 0,
    longest_streak integer NOT NULL DEFAULT 0,
    last_checkin_date date,
    last_broken_streak integer,
    streak_broken_at date,
    milestones jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("social_activity_events")} (
    id serial PRIMARY KEY,
    actor_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    event_type ${quote("social_activity_type")} NOT NULL,
    journey_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_user_id, idempotency_key)
  )`,
  `CREATE TABLE ${quote("social_shares")} (
    id serial PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    resource_type ${quote("social_resource_type")} NOT NULL,
    resource_id text NOT NULL,
    visibility ${quote("social_sharing_visibility")} NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, resource_type, resource_id)
  )`,
  `CREATE TABLE ${quote("social_share_recipients")} (
    id serial PRIMARY KEY,
    share_id integer NOT NULL REFERENCES ${quote("social_shares")}(id) ON DELETE CASCADE,
    recipient_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (share_id, recipient_user_id)
  )`,
  `CREATE TABLE ${quote("social_friendships")} (
    id serial PRIMARY KEY, user_low_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    user_high_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    created_from_request_id integer,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_low_id, user_high_id)
  )`,
  `CREATE TABLE ${quote("social_blocks")} (
    id serial PRIMARY KEY, blocker_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    blocked_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(blocker_user_id, blocked_user_id)
  )`,
  `CREATE TABLE ${quote("groups")} (
    id serial PRIMARY KEY, name text NOT NULL, invite_code text NOT NULL UNIQUE,
    goal_description text NOT NULL, description text,
    privacy ${quote("group_privacy")} NOT NULL DEFAULT 'invite_only',
    max_members integer NOT NULL DEFAULT 30, cover_object_path text,
    cover_updated_at timestamptz, start_date date NOT NULL, end_date date,
    created_by text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("group_members")} (
    id serial PRIMARY KEY, group_id integer NOT NULL REFERENCES ${quote("groups")}(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    role ${quote("group_member_role")} NOT NULL DEFAULT 'member',
    joined_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id, user_id)
  )`,
  `CREATE TABLE ${quote("social_group_journey_shares")} (
    id serial PRIMARY KEY, group_id integer NOT NULL REFERENCES ${quote("groups")}(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id, user_id, habit_id)
  )`,
  `CREATE TABLE ${quote("social_group_activity_events")} (
    id serial PRIMARY KEY, group_id integer NOT NULL REFERENCES ${quote("groups")}(id) ON DELETE CASCADE,
    actor_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    event_type ${quote("social_group_activity_type")} NOT NULL,
    journey_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(group_id, idempotency_key)
  )`,
  `CREATE TABLE ${quote("social_notifications")} (
    id serial PRIMARY KEY, recipient_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    actor_user_id text REFERENCES ${quote("users")}(id) ON DELETE SET NULL,
    type ${quote("social_notification_type")} NOT NULL, event_key text NOT NULL,
    friend_request_id integer, group_invitation_id integer, group_id integer,
    challenge_id integer, encouragement_id integer, safe_data jsonb, read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(recipient_user_id, event_key)
  )`,
  `CREATE TABLE ${quote("time_entries")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    habit_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    label text NOT NULL,
    duration_minutes integer NOT NULL,
    date date NOT NULL,
    note text,
    category text NOT NULL DEFAULT 'other',
    source text NOT NULL DEFAULT 'manual',
    start_time timestamptz,
    end_time timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("memories")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    habit_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    habit_day_id integer,
    note text NOT NULL,
    caption text,
    visibility ${quote("memory_visibility")} NOT NULL DEFAULT 'private',
    photo_object_path text,
    date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("journey_rewards")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    habit_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    title text NOT NULL,
    type ${quote("journey_reward_type")} NOT NULL,
    description text,
    image_url text,
    estimated_value double precision,
    status ${quote("journey_reward_status")} NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    unlocked_at timestamptz,
    claimed_at timestamptz,
    CONSTRAINT journey_rewards_habit_unique UNIQUE (habit_id)
  )`,
  `CREATE TABLE ${quote("object_uploads")} (
    object_path text PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX "journey_rewards_owner_created_idx" ON ${quote("journey_rewards")} (user_id, created_at)`,
  `CREATE INDEX "object_uploads_owner_idx" ON ${quote("object_uploads")} (user_id)`,
  `CREATE TABLE ${quote("rewards")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    habit_id integer REFERENCES ${quote("habits")}(id) ON DELETE SET NULL,
    title text NOT NULL,
    emoji text NOT NULL,
    coin_cost integer NOT NULL,
    is_redeemed boolean NOT NULL DEFAULT false,
    redeemed_at timestamptz,
    journey_required boolean NOT NULL DEFAULT false,
    journey_unlocked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("habit_days")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    day_number integer NOT NULL,
    date date NOT NULL,
    scheduled boolean NOT NULL DEFAULT true,
    title text,
    unit ${quote("habit_unit")},
    execution_type ${quote("habit_execution_type")},
    cue_type ${quote("habit_cue_type")},
    cue_time text,
    cue text,
    start_action text,
    target_value double precision NOT NULL,
    minimum_value double precision NOT NULL,
    busy_day_value double precision,
    success_limit_value double precision,
    goal_type ${quote("habit_goal_type")} NOT NULL,
    plan_revision integer NOT NULL DEFAULT 1,
    CONSTRAINT habit_days_habit_day_unique UNIQUE (habit_id, day_number),
    CONSTRAINT habit_days_habit_date_unique UNIQUE (habit_id, date)
  )`,
  `ALTER TABLE ${quote("memories")}
     ADD CONSTRAINT memories_habit_day_fk FOREIGN KEY (habit_day_id)
       REFERENCES ${quote("habit_days")}(id) ON DELETE SET NULL`,
  `CREATE UNIQUE INDEX memories_habit_day_unique ON ${quote("memories")} (habit_day_id)
     WHERE habit_day_id IS NOT NULL`,
  `CREATE TABLE ${quote("habit_plan_revisions")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    effective_from date NOT NULL,
    plan jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT habit_plan_revisions_habit_revision_unique UNIQUE (habit_id, revision)
  )`,
  `CREATE TABLE ${quote("habit_daily_executions")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    date date NOT NULL,
    day_number integer NOT NULL,
    scheduled boolean NOT NULL DEFAULT true,
    title text NOT NULL,
    target_value double precision NOT NULL,
    minimum_value double precision NOT NULL,
    busy_day_value double precision,
    success_limit_value double precision,
    goal_type ${quote("habit_goal_type")} NOT NULL,
    execution_type ${quote("habit_execution_type")} NOT NULL,
    unit ${quote("habit_unit")} NOT NULL,
    plan_revision integer NOT NULL DEFAULT 0,
    cue_type ${quote("habit_cue_type")},
    cue_time text,
    cue text,
    start_action text,
    status ${quote("daily_execution_status")} NOT NULL DEFAULT 'pending',
    actual_value double precision,
    actual_seconds integer,
    elapsed_base_seconds integer NOT NULL DEFAULT 0,
    segment_paused_seconds integer NOT NULL DEFAULT 0,
    started_at timestamptz,
    last_resumed_at timestamptz,
    paused_at timestamptz,
    paused_seconds integer NOT NULL DEFAULT 0,
    finished_at timestamptz,
    missed_reason ${quote("missed_reason")},
    note text,
    difficulty ${quote("checkin_difficulty")},
    revision integer NOT NULL DEFAULT 0,
    adaptation_decision ${quote("daily_adaptation_decision")},
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT habit_daily_executions_habit_date_unique UNIQUE (habit_id, date)
  )`,
  `CREATE TABLE ${quote("habit_daily_action_keys")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    date date NOT NULL,
    idempotency_key text NOT NULL,
    action text NOT NULL,
    request_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT habit_daily_action_keys_unique UNIQUE (habit_id, date, idempotency_key)
  )`,
  `CREATE TABLE ${quote("checkins")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    date date NOT NULL,
    completed boolean NOT NULL,
    value double precision,
    note text,
    mood_rating integer,
    difficulty ${quote("checkin_difficulty")},
    missed_reason ${quote("missed_reason")},
    target_snapshot double precision,
    minimum_snapshot double precision,
    success_limit_snapshot double precision,
    goal_type_snapshot ${quote("habit_goal_type")},
    target_completed boolean NOT NULL DEFAULT false,
    reward_granted boolean NOT NULL DEFAULT false,
    coins_earned integer NOT NULL DEFAULT 0,
    xp_earned integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT checkins_habit_date_unique UNIQUE (habit_id, date)
  )`,
  `CREATE TABLE ${quote("coin_transactions")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    amount integer NOT NULL,
    reason ${quote("coin_transaction_reason")} NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("journey_milestones")} (
    id serial PRIMARY KEY,
    level_required integer NOT NULL UNIQUE,
    title text NOT NULL,
    description text NOT NULL,
    emoji text NOT NULL,
    reward_coins integer NOT NULL
  )`,
  `CREATE TABLE ${quote("user_journey_milestones")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    milestone_id integer NOT NULL REFERENCES ${quote("journey_milestones")}(id) ON DELETE CASCADE,
    reached_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_journey_milestones_user_milestone_unique UNIQUE (user_id, milestone_id)
  )`,
  `CREATE TABLE ${quote("dashboard_write_audit")} (
    table_name text NOT NULL, operation text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
  )`,
];

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try {
    await Promise.all(servicePools.map((pool) => pool.end()));
  } finally {
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await adminPool.end();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
}

async function prepare() {
  for (const statement of ddl) await adminPool.query(statement);
  await adminPool.query(`
    CREATE FUNCTION "${schema}".record_dashboard_write() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO "${schema}".dashboard_write_audit (table_name, operation)
      VALUES (TG_TABLE_NAME, TG_OP);
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
    $$
  `);
  const applicationTables = await adminPool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       AND table_name <> 'dashboard_write_audit'`,
    [schema],
  );
  for (const { table_name: tableName } of applicationTables.rows) {
    await adminPool.query(
      `CREATE TRIGGER dashboard_write_audit
       AFTER INSERT OR UPDATE OR DELETE ON ${quote(tableName)}
       FOR EACH ROW EXECUTE FUNCTION "${schema}".record_dashboard_write()`,
    );
  }
  await adminPool.query(
    `ALTER TABLE ${quote("habit_days")} DROP CONSTRAINT IF EXISTS habit_days_habit_day_unique`,
  );
  await adminPool.query(
    `ALTER TABLE ${quote("habit_days")} DROP CONSTRAINT IF EXISTS habit_days_habit_day_unique`,
  );
  tempDir = await mkdtemp(join(apiDir, ".reward-test-"));
  const testEntry = join(tempDir, "reward-test-entry.ts");
  const serviceBundle = join(tempDir, "reward-test-entry.mjs");
  await writeFile(
    testEntry,
    `
      export { recordCheckin, CheckinConflictError } from ${JSON.stringify(join(apiDir, "src/lib/checkinService.ts"))};
      export { reviseFutureUnrecordedDays } from ${JSON.stringify(join(apiDir, "src/lib/habitPlanService.ts"))};
      export { getDashboardHabitsToday } from ${JSON.stringify(join(apiDir, "src/lib/dashboardService.ts"))};
      export { checkinsForPlanRevision, proposeHabitAdaptation } from ${JSON.stringify(join(apiDir, "src/lib/aiRules.ts"))};
      export { grantRewards } from ${JSON.stringify(join(apiDir, "src/lib/gamificationService.ts"))};
      export { default as habitsRouter } from ${JSON.stringify(join(apiDir, "src/routes/habits.ts"))};
      export { default as checkinsRouter } from ${JSON.stringify(join(apiDir, "src/routes/checkins.ts"))};
      export { default as rewardsRouter } from ${JSON.stringify(join(apiDir, "src/routes/rewards.ts"))};
      export { default as journeyRewardsRouter } from ${JSON.stringify(join(apiDir, "src/routes/journeyRewards.ts"))};
      export { default as dashboardRouter } from ${JSON.stringify(join(apiDir, "src/routes/dashboard.ts"))};
      export { default as memoriesRouter } from ${JSON.stringify(join(apiDir, "src/routes/memories.ts"))};
      export { default as storageRouter } from ${JSON.stringify(join(apiDir, "src/routes/storage.ts"))};
      export { default as dailyRouter } from ${JSON.stringify(join(apiDir, "src/routes/daily.ts"))};
      export {
        getDailyHabitState, changeDailyHabitExecution, saveDailyHabitReflection,
        recordDailyAdaptationDecision, getDailyOverview,
      } from ${JSON.stringify(join(apiDir, "src/lib/dailyExecutionService.ts"))};
      export { mockStorageObjects } from "@google-cloud/storage";
      export { db, pool } from "@workspace/db";
      export { GetDashboardHomeResponse } from "@workspace/api-zod";
      export { getCurrentTrackedAnalysisHash } from ${JSON.stringify(join(apiDir, "src/lib/trackedAnalysisCache.ts"))};
      export { geminiProvider } from ${JSON.stringify(join(apiDir, "src/lib/gemini.ts"))};
    `,
  );
  const adapterPlugin = {
    name: "isolated-postgres-schema",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
        path: "isolated-db-adapter",
        namespace: "isolated-db",
      }));
      esbuild.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
        path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
      }));
      esbuild.onResolve({ filter: /^@clerk\/express$/ }, () => ({
        path: "isolated-clerk-auth",
        namespace: "isolated-clerk",
      }));
      esbuild.onResolve({ filter: /^@google-cloud\/storage$/ }, () => ({
        path: "isolated-google-storage",
        namespace: "isolated-google-storage",
      }));
      esbuild.onResolve({ filter: /^sharp$/ }, () => ({
        path: createRequire(join(apiDir, "package.json")).resolve("sharp"),
        external: true,
      }));
      esbuild.onResolve({ filter: /^pg$/ }, () => ({
        path: pgEntry,
        external: true,
      }));
      esbuild.onResolve({ filter: /^express$/ }, () => ({
        path: "express",
        external: true,
      }));
      esbuild.onLoad({ filter: /.*/, namespace: "isolated-db" }, () => ({
        resolveDir: dbDir,
        loader: "js",
        contents: `
          import pg from "pg";
          import { drizzle } from "drizzle-orm/node-postgres";
          import * as schema from "./src/schema/index.ts";
          const { Pool } = pg;
          export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          export const db = drizzle(pool, { schema });
          export * from "./src/schema/index.ts";
        `,
      }));
      esbuild.onLoad({ filter: /.*/, namespace: "isolated-clerk" }, () => ({
        loader: "js",
        contents: `
          export const getAuth = (req) => ({ userId: req.headers["x-test-user"] ?? null });
          export const clerkClient = { users: { getUser: async () => { throw new Error("No Clerk in integration test"); } } };
        `,
      }));
      esbuild.onLoad({ filter: /.*/, namespace: "isolated-google-storage" }, () => ({
        loader: "js",
        contents: `
          import { Readable } from "node:stream";
          export const mockStorageObjects = new Map();
          class MockFile {
            constructor(key) {
              this.key = key;
              this.name = key;
            }
            async exists() {
              return [mockStorageObjects.has(this.key)];
            }
            async getMetadata() {
              const object = mockStorageObjects.get(this.key);
              if (!object) throw new Error("Mock object not found");
              return [structuredClone(object.metadata)];
            }
            async setMetadata(update) {
              const object = mockStorageObjects.get(this.key);
              if (!object) throw new Error("Mock object not found");
              object.metadata.metadata = {
                ...(object.metadata.metadata ?? {}),
                ...(update.metadata ?? {}),
              };
              return [structuredClone(object.metadata)];
            }
            async save(contents, options = {}) {
              mockStorageObjects.set(this.key, {
                data: Buffer.from(contents),
                metadata: {
                  contentType: options.metadata?.contentType,
                  size: String(contents.length),
                  metadata: structuredClone(options.metadata?.metadata ?? {}),
                },
              });
            }
            async delete() {
              mockStorageObjects.delete(this.key);
            }
            createReadStream() {
              const object = mockStorageObjects.get(this.key);
              object.readCount = (object.readCount ?? 0) + 1;
              return Readable.from([Buffer.from(object.data ?? "mock private image")]);
            }
          }
          export class Storage {
            bucket(bucketName) {
              return {
                file: (objectName) => new MockFile(\`\${bucketName}/\${objectName}\`),
              };
            }
          }
          export class File {}
        `,
      }));
    },
  };
  await build({
    entryPoints: [testEntry],
    outfile: serviceBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [adapterPlugin],
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(serviceBundle).href);
  servicePools.push(module.pool);
  if (typeof module.recordCheckin !== "function") {
    throw new Error("Production checkinService must export recordCheckin.");
  }
  if (typeof module.grantRewards !== "function") {
    throw new Error("Production gamificationService must export grantRewards.");
  }
  if (typeof module.reviseFutureUnrecordedDays !== "function") {
    throw new Error("Production habitJourney must export reviseFutureUnrecordedDays.");
  }
  if (typeof module.getDashboardHabitsToday !== "function") {
    throw new Error("Production dashboardService must export getDashboardHabitsToday.");
  }
  if (typeof module.checkinsForPlanRevision !== "function" || typeof module.proposeHabitAdaptation !== "function") {
    throw new Error("Production aiRules must export revision-aware adaptation helpers.");
  }
  return module;
}

let service;
try {
  service = await prepare();
} catch (error) {
  await cleanup();
  throw error;
}

test.after(cleanup);

async function reset() {
  await adminPool.query(
    `TRUNCATE ${quote("user_journey_milestones")}, ${quote("journey_milestones")},
     ${quote("coin_transactions")}, ${quote("habit_daily_action_keys")}, ${quote("habit_daily_executions")},
     ${quote("tracking_sessions")}, ${quote("day_analysis_cache")}, ${quote("user_character_items")},
     ${quote("habit_plan_revisions")}, ${quote("habit_days")},
      ${quote("checkins")}, ${quote("memories")}, ${quote("time_entries")},
      ${quote("object_uploads")},
     ${quote("journey_rewards")},
      ${quote("rewards")}, ${quote("habits")},
     ${quote("users")} RESTART IDENTITY CASCADE`,
  );
  service.mockStorageObjects.clear();
}

async function seedUser({ id = "reward-test-user", level = 1, xp = 0, coins = 0 } = {}) {
  await adminPool.query(
    `INSERT INTO ${quote("users")} (id, display_name, level, xp, coins)
     VALUES ($1, 'Integration test', $2, $3, $4)`,
    [id, level, xp, coins],
  );
  return id;
}

async function seedHabit({
  userId = "reward-test-user",
  cadence = "daily",
  currentStreak = 0,
  longestStreak = 0,
  lastCheckinDate = null,
} = {}) {
  const result = await adminPool.query(
    `INSERT INTO ${quote("habits")} (
       user_id, title, emoji, category, cadence, unit, target_value,
       minimum_value, difficulty, goal_type, current_streak, longest_streak,
       last_checkin_date, milestones
     ) VALUES ($1, 'Walk', '🌱', 'health', $2, 'minutes', 10, 3, 'easy',
               'build', $3, $4, $5, '[]'::jsonb)
     RETURNING id`,
    [userId, cadence, currentStreak, longestStreak, lastCheckinDate],
  );
  return result.rows[0].id;
}

function addDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function dateInTimezone(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function dashboardSnapshot() {
  const tables = await adminPool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       AND table_name <> 'dashboard_write_audit' ORDER BY table_name`,
    [schema],
  );
  const snapshot = {};
  for (const { table_name: tableName } of tables.rows) {
    const result = await adminPool.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY to_jsonb(row_data)::text), '[]'::jsonb) AS rows
       FROM ${quote(tableName)} AS row_data`,
    );
    snapshot[tableName] = result.rows[0].rows;
  }
  return snapshot;
}

async function assertDashboardReadOnly(action) {
  await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
  const before = await dashboardSnapshot();
  const result = await action();
  const after = await dashboardSnapshot();
  const writes = await adminPool.query(`SELECT * FROM ${quote("dashboard_write_audit")}`);
  assert.deepEqual(after, before, "dashboard GET changed an application table");
  assert.deepEqual(writes.rows, [], "dashboard GET issued a captured INSERT, UPDATE, or DELETE");
  return result;
}

async function seedDashboardUser({
  id = "dashboard-test-owner",
  timezone = "UTC",
  onboardingCompleted = true,
  level = 1,
  xp = 0,
  coins = 0,
} = {}) {
  await seedUser({ id, level, xp, coins });
  await adminPool.query(
    `UPDATE ${quote("users")} SET timezone = $2, onboarding_completed = $3 WHERE id = $1`,
    [id, timezone, onboardingCompleted],
  );
  return id;
}

async function seedDashboardExecution(habitId, date, {
  status = "pending",
  executionType = "duration",
  unit = "minutes",
  goalType = "build",
  planRevision = 0,
  targetValue = 10,
  minimumValue = 5,
  revision = 0,
  actualValue = null,
  actualSeconds = null,
  startedAt = null,
  lastResumedAt = null,
  missedReason = null,
  adaptationDecision = null,
  finishedAt = null,
} = {}) {
  const dayNumber = Math.max(1, Math.min(22, Math.floor(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dailyToday}T00:00:00Z`)) / 86_400_000,
  ) + 1));
  await adminPool.query(
    `INSERT INTO ${quote("habit_daily_executions")} (
       habit_id, date, day_number, title, target_value, minimum_value, goal_type,
       execution_type, unit, plan_revision, status, revision, actual_value, actual_seconds,
       started_at, last_resumed_at, missed_reason, adaptation_decision, finished_at
     ) VALUES ($1,$2,$3,'Walk',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [habitId, date, dayNumber, targetValue, minimumValue, goalType, executionType, unit, planRevision, status,
      revision, actualValue, actualSeconds, startedAt, lastResumedAt, missedReason,
      adaptationDecision, finishedAt],
  );
}

async function currentDashboardResponse(api) {
  const response = await api.request("/dashboard");
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  service.GetDashboardHomeResponse.parse(body);
  return body;
}

const dailyNow = new Date();
dailyNow.setUTCHours(12, 0, 0, 0);
const dailyToday = dailyNow.toISOString().slice(0, 10);
const validMemoryPng = await sharp({
  create: { width: 8, height: 6, channels: 3, background: { r: 45, g: 120, b: 190 } },
}).png().toBuffer();

async function startJourneyApi(userId) {
  const app = express();
  const requestErrors = [];
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: (...args) => requestErrors.push(args) };
    next();
  });
  app.use(
    service.habitsRouter,
    service.rewardsRouter,
    service.journeyRewardsRouter,
    service.dashboardRouter,
    service.dailyRouter,
    service.memoriesRouter,
    service.storageRouter,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    request: (path, method = "GET", body, authUser = userId) => fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authUser == null ? {} : { "x-test-user": authUser }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
    requestErrors,
  };
}

async function seedDailyJourney(habitId, startDate, {
  length = 22,
  targetValue = 10,
  minimumValue = 5,
  unit = "minutes",
  executionType = "duration",
  goalType = "build",
  cadence = "daily",
} = {}) {
  await adminPool.query(
    `UPDATE ${quote("habits")}
     SET journey_start_date = $2, journey_length = $3, target_value = $4,
         minimum_value = $5, unit = $6, execution_type = $7, goal_type = $8, cadence = $9
     WHERE id = $1`,
    [habitId, startDate, length, targetValue, minimumValue, unit, executionType, goalType, cadence],
  );
  const plan = {
    title: "Walk",
    targetValue,
    minimumValue,
    busyDayValue: null,
    successLimitValue: null,
    goalType,
    unit,
    executionType,
    cadence,
    customDays: null,
    cueType: null,
    cueTime: null,
    cue: null,
    startAction: null,
  };
  await adminPool.query(
    `INSERT INTO ${quote("habit_plan_revisions")} (habit_id, revision, effective_from, plan)
     VALUES ($1, 1, $2, $3::jsonb)`,
    [habitId, startDate, JSON.stringify(plan)],
  );
  for (let dayNumber = 1; dayNumber <= length; dayNumber++) {
    const date = addDays(startDate, dayNumber - 1);
    const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const scheduled = cadence !== "weekdays" || (dayOfWeek >= 1 && dayOfWeek <= 5);
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")}
         (habit_id, day_number, date, scheduled, title, unit, execution_type,
          target_value, minimum_value, goal_type, plan_revision)
       VALUES ($1, $2, $3, $4, 'Walk', $5, $6, $7, $8, $9, 1)`,
      [habitId, dayNumber, date, scheduled, unit, executionType,
        targetValue, minimumValue, goalType],
    );
  }
}

async function applyFuturePlanRevision(habitId, targetValue = 12) {
  const plan = {
    title: "Walk",
    targetValue,
    minimumValue: 5,
    busyDayValue: null,
    successLimitValue: null,
    goalType: "build",
    unit: "minutes",
    executionType: "duration",
    cadence: "daily",
    customDays: null,
    cueType: null,
    cueTime: null,
    cue: null,
    startAction: null,
  };
  await adminPool.query(
    `INSERT INTO ${quote("habit_plan_revisions")} (habit_id, revision, effective_from, plan)
     VALUES ($1, 2, $2, $3::jsonb)`,
    [habitId, addDays(dailyToday, 1), JSON.stringify(plan)],
  );
  await service.db.transaction((tx) => service.reviseFutureUnrecordedDays(
    tx,
    habitId,
    dailyToday,
    2,
    {
      ...plan,
      cadence: "daily",
      customDays: null,
    },
  ));
}

async function seedMilestone(levelRequired = 2, rewardCoins = 25) {
  return adminPool.query(
    `INSERT INTO ${quote("journey_milestones")}
       (level_required, title, description, emoji, reward_coins)
     VALUES ($1, 'Level milestone', 'Integration test milestone', '✨', $2)
     RETURNING id`,
    [levelRequired, rewardCoins],
  ).then((result) => result.rows[0].id);
}

async function seedCheckin({
  habitId,
  userId = "reward-test-user",
  date = "2026-06-01",
  completed = true,
  rewardGranted = false,
  coinsEarned = 0,
  xpEarned = null,
  difficulty = null,
  value = 10,
}) {
  return adminPool.query(
    `INSERT INTO ${quote("checkins")} (
       habit_id, user_id, date, completed, value, target_snapshot,
       minimum_snapshot, target_completed, reward_granted, coins_earned, xp_earned, difficulty
     ) VALUES ($1, $2, $3, $4, $5, 10, 3, $4, $6, $7, $8, $9)
     RETURNING id`,
    [habitId, userId, date, completed, value, rewardGranted, coinsEarned, xpEarned, difficulty],
  ).then((result) => result.rows[0].id);
}

async function seedReward({ userId = "reward-test-user", habitId = null, coinCost = 20 } = {}) {
  return adminPool.query(
    `INSERT INTO ${quote("rewards")} (user_id, habit_id, title, emoji, coin_cost)
     VALUES ($1, $2, 'Reward', '🎁', $3) RETURNING id`,
    [userId, habitId, coinCost],
  ).then((result) => result.rows[0].id);
}

async function seedExecution({
  habitId,
  date,
  dayNumber = 1,
  status = "pending",
  actualValue = null,
  actualSeconds = null,
  missedReason = null,
}) {
  await adminPool.query(
    `INSERT INTO ${quote("habit_daily_executions")} (
       habit_id, date, day_number, title, target_value, minimum_value, goal_type,
       execution_type, unit, status, actual_value, actual_seconds, missed_reason
     ) VALUES ($1, $2, $3, 'Walk', 10, 3, 'build', 'duration', 'minutes',
               $4, $5, $6, $7)`,
    [habitId, date, dayNumber, status, actualValue, actualSeconds, missedReason],
  );
}

function input(date = "2026-06-01", value = 10) {
  return { date: new Date(`${date}T00:00:00.000Z`), value };
}

async function rows(table, orderBy = "id") {
  const result = await adminPool.query(
    `SELECT * FROM ${quote(table)} ORDER BY "${orderBy}"`,
  );
  return result.rows;
}

async function snapshot(userId, habitId) {
  const [users, habits, checkins, transactions, milestones, reached] = await Promise.all([
    adminPool.query(`SELECT * FROM ${quote("users")} WHERE id = $1`, [userId]),
    adminPool.query(`SELECT * FROM ${quote("habits")} WHERE id = $1`, [habitId]),
    adminPool.query(`SELECT * FROM ${quote("checkins")} WHERE habit_id = $1 ORDER BY id`, [habitId]),
    adminPool.query(`SELECT * FROM ${quote("coin_transactions")} WHERE user_id = $1 ORDER BY id`, [userId]),
    adminPool.query(`SELECT * FROM ${quote("journey_milestones")} ORDER BY id`),
    adminPool.query(`SELECT * FROM ${quote("user_journey_milestones")} WHERE user_id = $1 ORDER BY id`, [userId]),
  ]);
  return {
    users: users.rows,
    habits: habits.rows,
    checkins: checkins.rows,
    transactions: transactions.rows,
    milestones: milestones.rows,
    reached: reached.rows,
  };
}

async function installFailure(table, operation, condition) {
  await adminPool.query(`
    CREATE FUNCTION ${quote("reject_test_write")}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'intentional reward integration test write failure';
    END;
    $$`);
  await adminPool.query(`
    CREATE TRIGGER injected_reward_failure
    BEFORE ${operation} ON ${quote(table)}
    FOR EACH ROW
    ${condition ? `WHEN (${condition})` : ""}
    EXECUTE FUNCTION ${quote("reject_test_write")}()`);
}

async function removeFailure(table) {
  await adminPool.query(
    `DROP TRIGGER IF EXISTS injected_reward_failure ON ${quote(table)}`,
  );
  await adminPool.query(
    `DROP FUNCTION IF EXISTS ${quote("reject_test_write")}()`,
  );
}

async function expectSuccessfulRetry({
  userId,
  habitId,
  date = "2026-06-01",
  value = 10,
  expectedXp = 10,
  expectedCoins = 5,
}) {
  const result = await service.recordCheckin(userId, habitId, input(date, value));
  assert.ok(result, "retry should return the successful check-in");
  const [user] = await rows("users");
  const [checkin] = await rows("checkins");
  assert.equal(checkin.reward_granted, true);
  assert.equal(user.xp, expectedXp);
  assert.equal(user.coins, expectedCoins);
}

test("parallel same-day submissions grant one reward; parallel habits retain both XP updates", async (t) => {
  await t.test("same habit and day", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });

    const results = await Promise.all([
      service.recordCheckin(userId, habitId, input()),
      service.recordCheckin(userId, habitId, input()),
    ]);

    assert.ok(results.every(Boolean));
    const [user] = await rows("users");
    const [checkin] = await rows("checkins");
    const transactions = await rows("coin_transactions");
    assert.equal(user.xp, 10);
    assert.equal(user.coins, 5);
    assert.equal(checkin.reward_granted, true);
    assert.equal(checkin.coins_earned, 5);
    assert.equal((await rows("checkins")).length, 1);
    const [habit] = await rows("habits");
    assert.equal(habit.current_streak, 1);
    assert.equal(transactions.length, 1);
  });

  await t.test("different habits for one user", async () => {
    await reset();
    const userId = await seedUser({ xp: 90 });
    await seedMilestone(2, 25);
    const firstHabit = await seedHabit({ userId });
    const secondHabit = await seedHabit({ userId });

    const results = await Promise.all([
      service.recordCheckin(userId, firstHabit, input()),
      service.recordCheckin(userId, secondHabit, input()),
    ]);

    assert.ok(results.every(Boolean));
    const [user] = await rows("users");
    assert.equal(user.level, 2);
    assert.equal(user.xp, 10);
    assert.equal(user.coins, 35);
    assert.equal((await rows("checkins")).length, 2);
    assert.equal((await rows("user_journey_milestones")).length, 1);
    const transactions = await rows("coin_transactions");
    assert.equal(transactions.length, 3);
    assert.equal(transactions.filter(({ reason }) => reason === "manual").length, 1);
  });
});

test("duplicate retry is idempotent, incomplete check-ins can succeed later, and downgrades conflict", async (t) => {
  await t.test("duplicate successful request does not pay twice", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });
    await service.recordCheckin(userId, habitId, input());
    await service.recordCheckin(userId, habitId, input());

    const [user] = await rows("users");
    assert.equal(user.xp, 10);
    assert.equal(user.coins, 5);
    assert.equal((await rows("coin_transactions")).length, 1);
  });

  await t.test("value-only retry preserves the stored reflection and does not pay twice", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });
    const date = dailyToday;
    await adminPool.query(
      `UPDATE ${quote("habits")} SET journey_start_date = $2, journey_length = 22 WHERE id = $1`,
      [habitId, date],
    );
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")}
         (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
       VALUES ($1, 1, $2, true, 10, 3, 'build', 1)`,
      [habitId, date],
    );
    const app = express();
    app.use(express.json());
    app.use(service.checkinsRouter);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    let first;
    let valueOnly;
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const headers = { "content-type": "application/json", "x-test-user": userId };
      const initialResponse = await fetch(`${baseUrl}/habits/${habitId}/checkins`, {
        method: "POST", headers, body: JSON.stringify({ date, value: 5 }),
      });
      assert.equal(initialResponse.status, 201);
      first = await initialResponse.json();
      const reflectionResponse = await fetch(`${baseUrl}/habits/${habitId}/checkins/${date}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ difficulty: "hard", note: "reflection note", moodRating: 4 }),
      });
      assert.equal(reflectionResponse.status, 200);
      const valueOnlyResponse = await fetch(`${baseUrl}/habits/${habitId}/checkins`, {
        method: "POST", headers, body: JSON.stringify({ date, value: 12 }),
      });
      assert.equal(valueOnlyResponse.status, 201);
      valueOnly = await valueOnlyResponse.json();
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.equal(valueOnly.id, first.id);
    assert.equal(valueOnly.value, 12);
    assert.equal(valueOnly.difficulty, "hard");
    assert.equal(valueOnly.note, "reflection note");
    assert.equal(valueOnly.moodRating, 4);
    const [user] = await rows("users");
    const [checkin] = await rows("checkins");
    assert.equal(checkin.reward_granted, true);
    assert.equal(checkin.coins_earned, 5);
    assert.equal(user.coins, 5);
    assert.equal((await rows("coin_transactions")).length, 1);
  });

  await t.test("incomplete check-in later completed", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });
    const date = "2026-06-02";
    const incomplete = await service.recordCheckin(userId, habitId, input(date, 1));
    assert.equal(incomplete.completed, false);
    assert.equal((await rows("coin_transactions")).length, 0);

    const completed = await service.recordCheckin(userId, habitId, input(date, 3));
    assert.equal(completed.completed, true);
    const [user] = await rows("users");
    const [habit] = await rows("habits");
    assert.equal(user.xp, 10);
    assert.equal(user.coins, 5);
    assert.equal(habit.current_streak, 1);
    assert.equal((await rows("checkins")).length, 1);
    assert.equal((await rows("coin_transactions")).length, 1);
  });

  await t.test("failed upgrade preserves the existing incomplete check-in for retry", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });
    const date = "2026-06-03";
    const incomplete = await service.recordCheckin(userId, habitId, input(date, 1));
    assert.equal(incomplete.completed, false);
    const before = await snapshot(userId, habitId);

    await installFailure("checkins", "UPDATE");
    try {
      await assert.rejects(
        service.recordCheckin(userId, habitId, input(date, 3)),
      );
      assert.deepEqual(await snapshot(userId, habitId), before);
    } finally {
      await removeFailure("checkins");
    }

    const [preserved] = await rows("checkins");
    assert.equal(preserved.completed, false);
    assert.equal(preserved.reward_granted, false);
    assert.equal(preserved.coins_earned, 0);
    const retry = await service.recordCheckin(userId, habitId, input(date, 3));
    assert.equal(retry.completed, true);
    const [user] = await rows("users");
    const [habit] = await rows("habits");
    assert.equal(user.xp, 10);
    assert.equal(user.coins, 5);
    assert.equal(habit.current_streak, 1);
    assert.equal((await rows("checkins")).length, 1);
    assert.equal((await rows("coin_transactions")).length, 1);
  });

  await t.test("successful check-in cannot be downgraded", async () => {
    await reset();
    const userId = await seedUser();
    const habitId = await seedHabit({ userId });
    await service.recordCheckin(userId, habitId, input());
    const before = await snapshot(userId, habitId);

    await assert.rejects(
      service.recordCheckin(userId, habitId, input("2026-06-01", 0)),
      (error) => error instanceof service.CheckinConflictError,
    );
    assert.deepEqual(await snapshot(userId, habitId), before);
  });
});

test("legacy reward markers and coins are honored without retroactive grants", async (t) => {
  for (const legacy of [
    { rewardGranted: false, coinsEarned: 0 },
    { rewardGranted: false, coinsEarned: 8 },
    { rewardGranted: true, coinsEarned: 0 },
  ]) {
    await t.test(
      `rewardGranted=${legacy.rewardGranted}, coinsEarned=${legacy.coinsEarned}`,
      async () => {
        await reset();
        const userId = await seedUser();
        const habitId = await seedHabit({ userId });
        await seedCheckin({ habitId, ...legacy });

        await service.recordCheckin(userId, habitId, input());

        const [user] = await rows("users");
        const [checkin] = await rows("checkins");
        assert.equal(user.xp, 0);
        assert.equal(user.coins, 0);
        assert.equal(checkin.reward_granted, legacy.rewardGranted);
        assert.equal(checkin.coins_earned, legacy.coinsEarned);
        assert.equal((await rows("coin_transactions")).length, 0);
      },
    );
  }
});

test("a failed write rolls back the whole check-in transaction and can be retried", async (t) => {
  const failures = [
    { table: "checkins", operation: "INSERT" },
    { table: "habits", operation: "UPDATE" },
    { table: "users", operation: "UPDATE" },
    { table: "coin_transactions", operation: "INSERT" },
    { table: "user_journey_milestones", operation: "INSERT", milestone: true },
    {
      table: "coin_transactions",
      operation: "INSERT",
      condition: "NEW.reason = 'manual'",
      milestone: true,
      label: "manual milestone ledger insert",
    },
  ];

  for (const failure of failures) {
    await t.test(`rollback on ${failure.label ?? `${failure.table} write`}`, async () => {
      await reset();
      const userId = await seedUser({ xp: failure.milestone ? 90 : 0 });
      const habitId = await seedHabit({ userId });
      if (failure.milestone) await seedMilestone();
      const before = await snapshot(userId, habitId);

      await installFailure(failure.table, failure.operation, failure.condition);
      try {
        await assert.rejects(service.recordCheckin(userId, habitId, input()));
        assert.deepEqual(await snapshot(userId, habitId), before);
      } finally {
        await removeFailure(failure.table);
      }

      await expectSuccessfulRetry({
        userId,
        habitId,
        expectedXp: failure.milestone ? 0 : 10,
        expectedCoins: failure.milestone ? 30 : 5,
      });
      if (failure.milestone) {
        const [user] = await rows("users");
        assert.equal(user.level, 2);
        assert.equal(user.xp, 0);
        assert.equal((await rows("user_journey_milestones")).length, 1);
      }
    });
  }
});

test("weekly bonus and level milestone roll back together when the bonus ledger insert fails", async () => {
  await reset();
  const userId = await seedUser({ xp: 90 });
  await seedMilestone(2, 25);
  const habitId = await seedHabit({
    userId,
    currentStreak: 6,
    longestStreak: 6,
    lastCheckinDate: "2026-06-06",
  });
  const date = "2026-06-07";
  const before = await snapshot(userId, habitId);

  await installFailure(
    "coin_transactions",
    "INSERT",
    "NEW.reason = 'streak_bonus'",
  );
  try {
    await assert.rejects(service.recordCheckin(userId, habitId, input(date)));
    assert.deepEqual(await snapshot(userId, habitId), before);
  } finally {
    await removeFailure("coin_transactions");
  }

  const result = await service.recordCheckin(userId, habitId, input(date));
  assert.equal(result.coinsEarned, 15);
  const [user] = await rows("users");
  const [habit] = await rows("habits");
  const [checkin] = await rows("checkins");
  const transactions = await rows("coin_transactions");
  assert.equal(user.level, 2);
  assert.equal(user.xp, 0);
  assert.equal(user.coins, 40);
  assert.equal(habit.current_streak, 7);
  assert.equal(checkin.reward_granted, true);
  assert.equal(checkin.coins_earned, 15);
  assert.deepEqual(
    transactions.map(({ amount, reason }) => [amount, reason]).sort((a, b) => a[1].localeCompare(b[1])),
    [[5, "checkin"], [25, "manual"], [10, "streak_bonus"]].sort((a, b) => a[1].localeCompare(b[1])),
  );
  assert.equal((await rows("user_journey_milestones")).length, 1);
});

test("standalone grantRewards rolls back its user update when wallet logging fails", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const before = await snapshot(userId, habitId);

  await installFailure("coin_transactions", "INSERT");
  try {
    await assert.rejects(
      service.grantRewards(userId, { xp: 10, coins: 5, reason: "checkin" }),
    );
    assert.deepEqual(await snapshot(userId, habitId), before);
  } finally {
    await removeFailure("coin_transactions");
  }

  await service.grantRewards(userId, { xp: 10, coins: 5, reason: "checkin" });
  const [user] = await rows("users");
  assert.equal(user.xp, 10);
  assert.equal(user.coins, 5);
  assert.equal((await rows("coin_transactions")).length, 1);
});

test("a habit owned by another user is not mutated", async () => {
  await reset();
  const owner = await seedUser({ id: "habit-owner" });
  const intruder = await seedUser({ id: "not-the-owner" });
  const habitId = await seedHabit({ userId: owner });
  const before = await snapshot(owner, habitId);

  assert.equal(await service.recordCheckin(intruder, habitId, input()), null);
  assert.deepEqual(await snapshot(owner, habitId), before);
  const [intruderRow] = (await adminPool.query(
    `SELECT * FROM ${quote("users")} WHERE id = $1`,
    [intruder],
  )).rows;
  assert.equal(intruderRow.xp, 0);
  assert.equal(intruderRow.coins, 0);
});

test("recordCheckin evaluates against the date-specific day plan", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
     VALUES ($1, 1, '2026-06-01', true, 8, 4, 'build', 1)`,
    [habitId],
  );
  await adminPool.query(`UPDATE ${quote("habits")} SET target_value = 3, minimum_value = 2 WHERE id = $1`, [habitId]);

  const result = await service.recordCheckin(userId, habitId, input("2026-06-01", 5));
  assert.equal(result.completed, true);
  assert.equal(result.targetCompleted, false);
  assert.equal(result.targetSnapshot, 8);
  assert.equal(result.minimumSnapshot, 4);
  assert.equal(result.goalTypeSnapshot, "build");
});

test("journey bounds and rest days reject check-ins; legacy weekday streaks still continue", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId, cadence: "weekdays" });
  await adminPool.query(
    `UPDATE ${quote("habits")}
     SET journey_start_date = $2, journey_length = 22
     WHERE id = $1`,
    [habitId, dailyToday],
  );
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
     VALUES ($1, 1, $2, false, 10, 3, 'build', 1)`,
    [habitId, dailyToday],
  );

  const untouched = await snapshot(userId, habitId);
  await assert.rejects(
    service.recordCheckin(userId, habitId, input(addDays(dailyToday, -1))),
    /outside the habit's 22-day journey/,
  );
  await assert.rejects(
    service.recordCheckin(userId, habitId, input(addDays(dailyToday, 22))),
    /Future journey dates cannot be completed early/,
  );
  await assert.rejects(service.recordCheckin(userId, habitId, input(dailyToday)), /rest day/);
  assert.deepEqual(await snapshot(userId, habitId), untouched);

  const todayWeekday = new Date(`${dailyToday}T00:00:00.000Z`).getUTCDay();
  const cadence = [0, 6].includes(todayWeekday) ? "daily" : "weekdays";
  let previousScheduledDate = addDays(dailyToday, -1);
  while (cadence === "weekdays"
    && [0, 6].includes(new Date(`${previousScheduledDate}T00:00:00.000Z`).getUTCDay())) {
    previousScheduledDate = addDays(previousScheduledDate, -1);
  }
  const legacyHabitId = await seedHabit({
    userId,
    cadence,
    currentStreak: 1,
    lastCheckinDate: previousScheduledDate,
  });
  const todayCheckin = await service.recordCheckin(userId, legacyHabitId, input(dailyToday));
  assert.equal(todayCheckin.newStreak, 2);
  const { rows: [habit] } = await adminPool.query(
    `SELECT * FROM ${quote("habits")} WHERE id = $1`, [legacyHabitId],
  );
  assert.equal(habit.current_streak, 2);
  assert.equal(habit.last_checkin_date.toISOString?.().slice(0, 10) ?? String(habit.last_checkin_date).slice(0, 10), dailyToday);
  assert.equal((await rows("coin_transactions")).filter((entry) => entry.reason === "checkin").length, 1);
});

test("plan revision persists only on future unrecorded dates", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
     VALUES
       ($1, 1, '2026-05-31', true, 10, 5, 'build', 1),
       ($1, 2, '2026-06-01', true, 10, 5, 'build', 1),
       ($1, 3, '2026-06-02', true, 10, 5, 'build', 1),
       ($1, 4, '2026-06-03', true, 10, 5, 'build', 1)`,
    [habitId],
  );
  await seedCheckin({ habitId, userId, date: "2026-06-02", value: 10 });

  await service.db.transaction((tx) => service.reviseFutureUnrecordedDays(
    tx, habitId, "2026-06-01", 2, {
      targetValue: 6, minimumValue: 3, busyDayValue: 2, successLimitValue: null,
      goalType: "build", cadence: "daily", customDays: null,
    },
  ));

  const result = await adminPool.query(
    `SELECT date::text AS date, target_value, minimum_value, plan_revision
     FROM ${quote("habit_days")} WHERE habit_id = $1 ORDER BY day_number`,
    [habitId],
  );
  assert.deepEqual(result.rows.map((day) => [day.date, day.target_value, day.minimum_value, day.plan_revision]), [
    ["2026-05-31", 10, 5, 1],
    ["2026-06-01", 10, 5, 1],
    ["2026-06-02", 10, 5, 1],
    ["2026-06-03", 6, 3, 2],
  ]);
});

test("accepted numeric plan revision cannot reuse old easy check-ins for another increase", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  await adminPool.query(
    `UPDATE ${quote("habits")} SET target_value = 12, minimum_value = 6 WHERE id = $1`,
    [habitId],
  );
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
     VALUES
       ($1, 1, '2026-06-01', true, 10, 5, 'build', 1),
       ($1, 2, '2026-06-02', true, 10, 5, 'build', 1),
       ($1, 3, '2026-06-03', true, 10, 5, 'build', 1),
       ($1, 4, '2026-06-04', true, 10, 5, 'build', 1)`,
    [habitId],
  );
  for (const date of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
    await seedCheckin({ habitId, userId, date, value: 10 });
  }
  await adminPool.query(`UPDATE ${quote("checkins")} SET difficulty = 'easy' WHERE habit_id = $1`, [habitId]);

  await adminPool.query(
    `INSERT INTO ${quote("habit_plan_revisions")} (habit_id, revision, effective_from, plan)
     VALUES ($1, 2, '2026-06-04', $2::jsonb)`,
    [habitId, JSON.stringify({ targetValue: 12, minimumValue: 6 })],
  );
  await service.db.transaction((tx) => service.reviseFutureUnrecordedDays(
    tx, habitId, "2026-06-03", 2, {
      targetValue: 12, minimumValue: 6, busyDayValue: null, successLimitValue: null,
      goalType: "build", cadence: "daily", customDays: null,
    },
  ));

  const [planDays, latestRevision, history] = await Promise.all([
    adminPool.query(
      `SELECT date::text AS date, plan_revision AS "planRevision"
       FROM ${quote("habit_days")} WHERE habit_id = $1 ORDER BY day_number`,
      [habitId],
    ),
    adminPool.query(
      `SELECT revision FROM ${quote("habit_plan_revisions")} WHERE habit_id = $1 ORDER BY revision DESC LIMIT 1`,
      [habitId],
    ),
    adminPool.query(
      `SELECT date::text AS date, difficulty, missed_reason AS "missedReason", completed
       FROM ${quote("checkins")} WHERE habit_id = $1 ORDER BY date`,
      [habitId],
    ),
  ]);
  assert.deepEqual(planDays.rows.map((day) => day.planRevision), [1, 1, 1, 2]);
  const numericHistory = service.checkinsForPlanRevision(
    history.rows, planDays.rows, latestRevision.rows[0].revision,
  );
  assert.equal(numericHistory.length, 0);
  const nextSuggestion = service.proposeHabitAdaptation({
    targetValue: 12, minimumValue: 6, checkins: history.rows, numericCheckins: numericHistory,
  });
  assert.equal(nextSuggestion.targetValue, 12);
  assert.equal(nextSuggestion.reason, "steady");
});

test("accepted PATCH changes only future rows and immediate adaptation ignores old easy evidence", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (date, days) => {
    const result = new Date(`${date}T00:00:00.000Z`);
    result.setUTCDate(result.getUTCDate() + days);
    return result.toISOString().slice(0, 10);
  };
  const startDate = addDays(today, -3);
  await adminPool.query(
    `UPDATE ${quote("habits")} SET journey_start_date = $2, journey_length = 22 WHERE id = $1`,
    [habitId, startDate],
  );
  await adminPool.query(
    `INSERT INTO ${quote("habit_plan_revisions")} (habit_id, revision, effective_from, plan)
     VALUES ($1, 1, $2, $3::jsonb)`,
    [habitId, startDate, JSON.stringify({ targetValue: 10, minimumValue: 3 })],
  );
  for (let dayNumber = 1; dayNumber <= 22; dayNumber++) {
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")}
         (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
       VALUES ($1, $2, $3, true, 10, 3, 'build', 1)`,
      [habitId, dayNumber, addDays(startDate, dayNumber - 1)],
    );
  }
  for (const date of [addDays(startDate, 0), addDays(startDate, 1), addDays(startDate, 2)]) {
    await seedCheckin({ habitId, userId, date, value: 10 });
  }
  await adminPool.query(`UPDATE ${quote("checkins")} SET difficulty = 'easy' WHERE habit_id = $1`, [habitId]);

  const app = express();
  app.use(express.json());
  app.use(service.habitsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const patchResponse = await fetch(`${baseUrl}/habits/${habitId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": userId },
      body: JSON.stringify({
        targetValue: 11,
        expectedTargetValue: 10,
        expectedMinimumValue: 3,
      }),
    });
    const patchText = await patchResponse.text();
    assert.equal(patchResponse.status, 200, patchText);
    assert.equal(JSON.parse(patchText).targetValue, 11);

    const dayRows = await adminPool.query(
      `SELECT date::text AS date, target_value, plan_revision
       FROM ${quote("habit_days")} WHERE habit_id = $1 ORDER BY day_number`,
      [habitId],
    );
    for (const day of dayRows.rows) {
      if (day.date <= today) {
        assert.equal(day.target_value, 10);
        assert.equal(day.plan_revision, 1);
      } else {
        assert.equal(day.target_value, 11);
        assert.equal(day.plan_revision, 2);
      }
    }

    const adaptationResponse = await fetch(`${baseUrl}/habits/${habitId}/adaptation`, {
      headers: { "x-test-user": userId },
    });
    assert.equal(adaptationResponse.status, 200);
    const adaptation = await adaptationResponse.json();
    assert.equal(adaptation.targetValue, 11);
    assert.equal(adaptation.suggestion, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("dashboard uses today's immutable plan and disables scheduling outside journey dates", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId, cadence: "weekdays" });
  await adminPool.query(
    `UPDATE ${quote("habits")}
     SET target_value = 4, minimum_value = 2, goal_type = 'quit', success_limit_value = 6,
         journey_start_date = '2026-05-31', journey_length = 22
     WHERE id = $1`,
    [habitId],
  );
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value,
        success_limit_value, goal_type, plan_revision)
     VALUES ($1, 2, '2026-06-01', true, 8, 5, 9, 'quit', 1)`,
    [habitId],
  );

  const today = await service.getDashboardHabitsToday(userId, "2026-06-01");
  assert.equal(today.length, 1);
  assert.equal(today[0].targetValue, 8);
  assert.equal(today[0].minimumValue, 5);
  assert.equal(today[0].goalType, "quit");
  assert.equal(today[0].successLimitValue, 9);
  assert.equal(today[0].scheduledToday, true);
  assert.equal(today[0].targetCompleted, false);

  const beforeJourney = await service.getDashboardHabitsToday(userId, "2026-05-30");
  const afterJourney = await service.getDashboardHabitsToday(userId, "2026-06-22");
  assert.equal(beforeJourney[0].scheduledToday, false);
  assert.equal(afterJourney[0].scheduledToday, false);
});

test("daily execution supports minimum success, Continue, Done, reflection, and revision CAS", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, dailyToday);
  const dateInput = new Date(`${dailyToday}T00:00:00.000Z`);
  let current = await service.getDailyHabitState(userId, habitId, dailyToday, dailyNow);
  const change = (action, expectedRevision, now, value, idempotencyKey) =>
    service.changeDailyHabitExecution(userId, habitId, {
      date: dateInput,
      action,
      expectedRevision,
      ...(value === undefined ? {} : { value }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }, now);

  current = (await change("update_progress", current.revision, dailyNow, 360, "manual-base")).execution;
  assert.equal(current.status, "minimum_reached");
  assert.equal(current.checkin, null, "manual progress alone does not complete or reward the day");
  await assert.rejects(
    change("start", 0, dailyNow),
    (error) => error.statusCode === 409,
    "stale execution revisions are rejected",
  );

  current = (await change("start", current.revision, dailyNow)).execution;
  assert.equal(current.status, "in_progress");
  current = (await change("pause", current.revision, new Date(dailyNow.getTime() + 30_000))).execution;
  assert.equal(current.actualSeconds, 390, "six manual minutes plus thirty timer seconds are retained");
  const finish = await change(
    "finish",
    current.revision,
    new Date(dailyNow.getTime() + 30_000),
    undefined,
    "finish-minimum",
  );
  current = finish.execution;
  assert.equal(current.status, "minimum_reached", "successful finish remains open for Continue or Done");
  assert.equal(current.actualSeconds, 390);
  assert.deepEqual(finish.rewardDelta, { xp: 10, coins: 5 });
  const replay = await change(
    "finish",
    current.revision - 1,
    new Date(dailyNow.getTime() + 30_000),
    undefined,
    "finish-minimum",
  );
  assert.deepEqual(replay.rewardDelta, { xp: 0, coins: 0 });

  current = (await change("start", current.revision, new Date(dailyNow.getTime() + 60_000))).execution;
  assert.equal(current.status, "in_progress", "an achieved minimum does not block the timer");
  const continuedFinish = await change("finish", current.revision, new Date(dailyNow.getTime() + 270_000));
  current = continuedFinish.execution;
  assert.equal(current.actualSeconds, 600);
  assert.equal(current.status, "target_reached", "Continue can reach the full target");
  assert.deepEqual(continuedFinish.rewardDelta, { xp: 0, coins: 0 });
  const [paidUser] = await rows("users");
  assert.equal(paidUser.xp, 10, "Continue does not pay a second time");
  assert.equal((await rows("checkins")).length, 1);

  current = (await change("done", current.revision, new Date(dailyNow.getTime() + 271_000))).execution;
  assert.equal(current.status, "pending_reflection");
  const app = express();
  app.use(express.json());
  app.use(service.habitsRouter);
  app.use(service.dailyRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const reflectionResponse = await fetch(
      `${baseUrl}/habits/${habitId}/daily/${dailyToday}/reflection`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-user": userId },
        body: JSON.stringify({ difficulty: "hard", note: "Completed but it felt hard" }),
      },
    );
    const reflectionText = await reflectionResponse.text();
    assert.equal(reflectionResponse.status, 200, reflectionText);
    current = JSON.parse(reflectionText).execution;
    assert.equal(current.status, "completed");

    const getResponse = await fetch(`${baseUrl}/habits/${habitId}/daily/${dailyToday}`, {
      headers: { "x-test-user": userId },
    });
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).status, "completed");

    const patchResponse = await fetch(`${baseUrl}/habits/${habitId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": userId },
      body: JSON.stringify({
        targetValue: 12,
        expectedTargetValue: 10,
        expectedMinimumValue: 5,
      }),
    });
    const patchText = await patchResponse.text();
    assert.equal(patchResponse.status, 200, patchText);
    assert.equal(JSON.parse(patchText).targetValue, 12);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const updateAfterDone = await change("update_progress", current.revision, new Date(dailyNow.getTime() + 120_000), 750);
  assert.equal(updateAfterDone.execution.status, "completed", "same-day successful updates cannot downgrade completion");
  assert.deepEqual(updateAfterDone.rewardDelta, { xp: 0, coins: 0 });
  const [finalUser] = await rows("users");
  assert.equal(finalUser.xp, 10);
  const [checkin] = await rows("checkins");
  assert.equal(checkin.completed, true);
  assert.equal(checkin.value, 12.5);
  const decision = await service.recordDailyAdaptationDecision(
    userId,
    habitId,
    dailyToday,
    { decision: "accepted" },
    new Date(dailyNow.getTime() + 130_000),
  );
  assert.equal(decision.adaptationDecision, "accepted", "today's real hard success can accept a CAS-applied adaptation");
});

test("expired timer elapsed time stays separate from unknown actual and missed reflection is genuine", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const yesterday = addDays(dailyToday, -1);
  await seedDailyJourney(habitId, yesterday);
  const timerStart = new Date(`${yesterday}T23:58:00.000Z`);
  await adminPool.query(
    `INSERT INTO ${quote("habit_daily_executions")}
       (habit_id, date, day_number, scheduled, title, target_value, minimum_value,
        goal_type, execution_type, unit, plan_revision, status, started_at,
        last_resumed_at, elapsed_base_seconds)
     VALUES ($1, $2, 1, true, 'Walk', 10, 5, 'build', 'duration', 'minutes', 1,
             'in_progress', $3, $3, 120)`,
    [habitId, yesterday, timerStart],
  );
  let missed = await service.getDailyHabitState(userId, habitId, yesterday, dailyNow);
  assert.equal(missed.status, "missed");
  assert.equal(missed.actualSeconds, 240);
  assert.equal(missed.actualValue, null, "timer time alone is not a self-reported actual");
  assert.equal(missed.checkin, null);
  assert.equal((await rows("checkins")).length, 0, "expiry does not synthesize check-ins");

  const reflected = await service.saveDailyHabitReflection(
    userId,
    habitId,
    yesterday,
    { missedReason: "no_time", difficulty: "hard", note: "Unexpected delay" },
    dailyNow,
  );
  assert.equal(reflected.execution.status, "missed");
  assert.equal((await rows("checkins")).length, 0, "a missed reflection remains execution evidence only");
  await applyFuturePlanRevision(habitId);
  const decision = await service.recordDailyAdaptationDecision(
    userId,
    habitId,
    yesterday,
    { decision: "accepted" },
    dailyNow,
  );
  assert.equal(decision.adaptationDecision, "accepted", "the newest revision is used after the future-plan CAS");
});

test("daily overview keeps mixed active journeys non-actionable instead of failing the home request", async () => {
  await reset();
  const userId = await seedUser();
  const todayHabit = await seedHabit({ userId });
  const futureHabit = await seedHabit({ userId });
  const endedHabit = await seedHabit({ userId });
  await seedDailyJourney(todayHabit, dailyToday);
  await seedDailyJourney(futureHabit, addDays(dailyToday, 1));
  await seedDailyJourney(endedHabit, addDays(dailyToday, -22));

  const overview = await service.getDailyOverview(userId, dailyToday, dailyNow);
  assert.equal(overview.habits.length, 3);
  const byId = new Map(overview.habits.map((item) => [item.habitId, item]));
  assert.equal(byId.get(todayHabit).scheduledToday, true);
  assert.equal(byId.get(futureHabit).scheduledToday, false);
  assert.equal(byId.get(futureHabit).execution.eligible, false);
  assert.equal(byId.get(futureHabit).eligibleDays, 0);
  assert.ok(byId.get(futureHabit).rewardMilestones.every((stage) => !stage.reached));
  assert.equal(byId.get(endedHabit).scheduledToday, false);
  assert.equal(byId.get(endedHabit).execution.eligible, false);
  assert.equal(byId.get(endedHabit).eligibleDays, 22, "elapsed journey consistency remains available after the journey ends");
  assert.equal(byId.get(endedHabit).successfulDays, 0);
  assert.equal(byId.get(endedHabit).rewardMilestones.find((stage) => stage.days === 22).reached, true);
});

test("legacy consistency counts saved elapsed schedule evidence without filling unknown dates", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const anchor = addDays(dailyToday, -10);
  await adminPool.query(
    `UPDATE ${quote("habits")} SET created_at = $2 WHERE id = $1`,
    [habitId, new Date(`${anchor}T12:00:00.000Z`)],
  );
  const [legacyHabit] = await adminPool.query(
    `SELECT journey_start_date, journey_length FROM ${quote("habits")} WHERE id = $1`,
    [habitId],
  ).then((result) => result.rows);
  assert.equal(legacyHabit.journey_start_date, null);
  assert.equal(legacyHabit.journey_length, null);

  const yesterday = addDays(dailyToday, -1);
  const olderRest = addDays(dailyToday, -6);
  const future = addDays(dailyToday, 1);
  const saveExecution = async (date, scheduled, status) => {
    const dayNumber = Math.floor(
      (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${anchor}T00:00:00.000Z`)) / 86_400_000,
    ) + 1;
    await adminPool.query(
      `INSERT INTO ${quote("habit_daily_executions")}
         (habit_id, date, day_number, scheduled, title, target_value, minimum_value,
          goal_type, execution_type, unit, plan_revision, status)
       VALUES ($1, $2, $3, $4, 'Walk', 10, 3, 'build', 'duration', 'minutes', 0, $5)`,
      [habitId, date, dayNumber, scheduled, status],
    );
  };
  await saveExecution(yesterday, true, "missed");
  await saveExecution(olderRest, false, "pending");
  await saveExecution(future, true, "pending");

  const successful = await service.recordCheckin(userId, habitId, {
    date: new Date(`${dailyToday}T00:00:00.000Z`),
    completed: true,
    value: 3,
  });
  assert.equal(successful.completed, true);
  const [beforeRead] = await rows("users");
  const transactionsBeforeRead = (await rows("coin_transactions")).length;

  const overview = await service.getDailyOverview(userId, dailyToday, dailyNow);
  const item = overview.habits.find((entry) => entry.habitId === habitId);
  assert.ok(item);
  assert.equal(item.successfulDays, 1, "only the real completed check-in counts as successful");
  assert.equal(item.eligibleDays, 2, "yesterday's saved schedule and today's scheduled check-in are known; unknown history, rest and future are excluded");
  const [afterRead] = await rows("users");
  assert.equal(afterRead.xp, beforeRead.xp);
  assert.equal(afterRead.coins, beforeRead.coins);
  assert.equal((await rows("coin_transactions")).length, transactionsBeforeRead);
});

test("a completed weekday calendar journey reaches day 22 independently of its scheduled success count", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const journeyStart = addDays(dailyToday, -21);
  await seedDailyJourney(habitId, journeyStart, { cadence: "weekdays" });
  const { rows: scheduledDays } = await adminPool.query(
    `SELECT date::text AS date FROM ${quote("habit_days")}
     WHERE habit_id = $1 AND scheduled = true ORDER BY date`,
    [habitId],
  );
  assert.ok(scheduledDays.length <= 16 && scheduledDays.length >= 15);
  for (const { date } of scheduledDays) {
    await seedCheckin({ habitId, userId, date, completed: true, value: 6 });
  }

  const [beforeOverview] = await rows("users");
  const transactionsBeforeOverview = (await rows("coin_transactions")).length;
  const overview = await service.getDailyOverview(userId, dailyToday, dailyNow);
  const item = overview.habits.find((entry) => entry.habitId === habitId);
  assert.ok(item);
  assert.equal(item.execution.dayNumber, 22);
  assert.equal(item.successfulDays, scheduledDays.length);
  assert.equal(item.eligibleDays, scheduledDays.length);
  assert.ok(item.successfulDays <= 16);
  assert.equal(item.rewardMilestones.find((stage) => stage.days === 22).reached, true);
  assert.equal(item.rewardMilestones.find((stage) => stage.days === 15).reached, true);
  const [afterOverview] = await rows("users");
  assert.equal(afterOverview.xp, beforeOverview.xp);
  assert.equal(afterOverview.coins, beforeOverview.coins);
  assert.equal((await rows("coin_transactions")).length, transactionsBeforeOverview);
});

test("journey GET commits final eligibility once, preserves pending-today missed counts, and never pays completion rewards", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const habitId = await seedHabit({ userId });
  const rewardId = await seedReward({ userId, coinCost: 15 });
  await adminPool.query(`UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`, [habitId, rewardId]);
  const startDate = addDays(dailyToday, -21);
  await seedDailyJourney(habitId, startDate);

  // A second, unfinished 22-day journey may point at the same reward without
  // blocking the first journey's valid unlock.
  const unfinishedHabitId = await seedHabit({ userId });
  await adminPool.query(`UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`, [unfinishedHabitId, rewardId]);
  await seedDailyJourney(unfinishedHabitId, addDays(dailyToday, -22));

  const api = await startJourneyApi(userId);
  try {
    const beforeResponse = await api.request(`/habits/${habitId}/journey`);
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    assert.equal(before.today.slice(0, 10), dailyToday, "date-only today may serialize as an ISO timestamp");
    assert.equal(before.timezone, "UTC");
    assert.equal(before.status, "active");
    assert.equal(before.currentDay, 22);
    assert.deepEqual(before.consistency, { successfulDays: 0, eligibleDays: 22 });
    assert.equal(before.missedDays, 21, "pending scheduled today is not counted as missed");
    assert.equal(before.days.find((day) => day.date.slice(0, 10) === dailyToday).status, "pending");
    assert.equal(before.rewardUnlocked, false);
    assert.equal(before.finalEligibility.unmetReason, "final_scheduled_day_not_successful");

    const blocked = await api.request(`/rewards/${rewardId}/redeem`, "POST");
    assert.equal(blocked.status, 400);
    const [beforeCompletion] = await rows("users");
    const beforeTransactions = await rows("coin_transactions");
    assert.equal(beforeCompletion.coins, 100);
    assert.equal(beforeCompletion.xp, 0);

    const recorded = await service.recordCheckin(userId, habitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      completed: true,
      value: 5,
    });
    assert.equal(recorded.xpEarned, 10);
    assert.equal(recorded.coinsEarned, 5);
    const [afterCheckin] = await rows("users");
    assert.equal(afterCheckin.xp, 10);
    assert.equal(afterCheckin.coins, 105);

    const [firstResponse, retryResponse] = await Promise.all([
      api.request(`/habits/${habitId}/journey`),
      api.request(`/habits/${habitId}/journey`),
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(retryResponse.status, 200);
    const [first, retry] = await Promise.all([firstResponse.json(), retryResponse.json()]);
    assert.equal(first.status, "completed");
    assert.equal(first.finalEligibility.eligible, true);
    assert.equal(first.finalEligibility.finalDateSuccessful, true);
    assert.equal(first.successful, 1, "22 successful sessions are not required");
    assert.equal(first.consistency.successfulDays, 1);
    assert.equal(first.missedDays, 21);
    assert.equal(first.rewardUnlocked, true);
    assert.equal(first.earnings.xp, 10);
    assert.equal(first.earnings.coins, 5);
    assert.equal(first.earnings.xpComplete, true);
    assert.equal(first.earnings.coinHistoryMayBeIncomplete, false);
    assert.equal(first.completedAt, retry.completedAt, "completedAt is committed once");
    const sharedResponse = await api.request(`/habits/${unfinishedHabitId}/journey`);
    assert.equal(sharedResponse.status, 200);
    const sharedJourney = await sharedResponse.json();
    assert.equal(sharedJourney.status, "expired");
    assert.equal(sharedJourney.rewardUnlocked, true,
      "a shared reward reports unlocked when another selected journey qualifies");
    const [afterJourneyRead] = await rows("users");
    assert.equal(afterJourneyRead.xp, 10);
    assert.equal(afterJourneyRead.coins, 105);
    assert.equal((await rows("coin_transactions")).length, beforeTransactions.length + 1,
      "journey lifecycle reads add no wallet or ledger rewards");

    const redeemed = await api.request(`/rewards/${rewardId}/redeem`, "POST");
    assert.equal(redeemed.status, 200);
    assert.equal((await redeemed.json()).coinsRemaining, 90);
    const duplicateRedeem = await api.request(`/rewards/${rewardId}/redeem`, "POST");
    assert.equal(duplicateRedeem.status, 400);

    const unlinkedRewardId = await seedReward({ userId, coinCost: 5 });
    const oldReward = await api.request(`/rewards/${unlinkedRewardId}/redeem`, "POST");
    assert.equal(oldReward.status, 200, "unlinked legacy rewards keep their old redemption behavior");

    const otherUser = await seedUser({ id: "journey-other-user", coins: 100 });
    const otherApi = await startJourneyApi(otherUser);
    try {
      assert.equal((await otherApi.request(`/habits/${habitId}/journey`)).status, 404);
      assert.equal((await otherApi.request(`/rewards/${rewardId}/redeem`, "POST")).status, 404);
    } finally {
      await otherApi.close();
    }
  } finally {
    await api.close();
  }
});

test("last scheduled weekday success completes a calendar journey whose day 22 is rest", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  let offset = 22;
  let startDate;
  let endDate;
  do {
    startDate = addDays(dailyToday, -offset);
    endDate = addDays(startDate, 21);
    offset += 1;
  } while (![0, 6].includes(new Date(`${endDate}T00:00:00.000Z`).getUTCDay()));
  await seedDailyJourney(habitId, startDate, { cadence: "weekdays" });
  const { rows: scheduledDays } = await adminPool.query(
    `SELECT date::text AS date FROM ${quote("habit_days")}
     WHERE habit_id = $1 AND scheduled ORDER BY date`,
    [habitId],
  );
  const finalScheduledDate = scheduledDays.at(-1).date;
  assert.notEqual(finalScheduledDate, endDate);
  await seedCheckin({ habitId, userId, date: finalScheduledDate, completed: true, value: 5 });
  const api = await startJourneyApi(userId);
  try {
    const response = await api.request(`/habits/${habitId}/journey`);
    assert.equal(response.status, 200);
    const journey = await response.json();
    assert.equal(journey.currentDay, 22);
    assert.equal(journey.status, "completed");
    assert.equal(journey.finalEligibility.finalScheduledDate.slice(0, 10), finalScheduledDate);
    assert.equal(journey.finalEligibility.finalDateSuccessful, true);
    assert.equal(journey.days.at(-1).status, "rest");
  } finally {
    await api.close();
  }
});

test("journey check-ins cannot execute future dates early", async () => {
  await reset();
  const userId = await seedUser({ coins: 20 });
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, dailyToday);
  await assert.rejects(
    service.recordCheckin(userId, habitId, {
      date: new Date(`${addDays(dailyToday, 1)}T00:00:00.000Z`),
      completed: true,
      value: 5,
    }),
    /Future journey dates cannot be completed early/,
  );
  assert.equal((await rows("checkins")).length, 0);
  assert.equal((await rows("coin_transactions")).length, 0);
  const [user] = await rows("users");
  assert.equal(user.xp, 0);
  assert.equal(user.coins, 20);
});

test("starting a journey from a legacy habit preserves history, reuses today's snapshot, and awards nothing", async () => {
  await reset();
  const userId = await seedUser({ xp: 17, coins: 42 });
  const habitId = await seedHabit({ userId, cadence: "weekdays" });
  const rewardId = await seedReward({ userId });
  await adminPool.query(`UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`, [habitId, rewardId]);

  const yesterday = addDays(dailyToday, -1);
  await seedCheckin({ habitId, userId, date: yesterday, value: 7 });
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, title, unit, execution_type,
        target_value, minimum_value, goal_type, plan_revision)
     VALUES
       ($1, 1, $2, true, 'Legacy history', 'minutes', 'duration', 41, 11, 'build', 1),
       ($1, 1, $3, false, 'Saved today', 'minutes', 'duration', 99, 20, 'build', 1)`,
    [habitId, yesterday, dailyToday],
  );
  const [oldCheckinBefore] = await adminPool.query(
    `SELECT * FROM ${quote("checkins")} WHERE habit_id = $1 AND date = $2`, [habitId, yesterday],
  ).then((result) => result.rows);
  const [oldDayBefore] = await adminPool.query(
    `SELECT * FROM ${quote("habit_days")} WHERE habit_id = $1 AND date = $2`, [habitId, yesterday],
  ).then((result) => result.rows);
  const api = await startJourneyApi(userId);
  try {
    const response = await api.request(`/habits/${habitId}/journey`, "POST");
    assert.equal(response.status, 200);
    const journey = await response.json();
    assert.equal(journey.startDate.slice(0, 10), dailyToday);
    assert.equal(journey.length, 22);
    assert.equal(journey.currentDay, 1);
    assert.equal(journey.status, "active");
    assert.equal(journey.days.length, 22);
    assert.deepEqual(journey.days.map(({ dayNumber }) => dayNumber), Array.from({ length: 22 }, (_, i) => i + 1));
    assert.equal(journey.days[0].date.slice(0, 10), dailyToday);
    assert.equal(journey.days[0].scheduled, false);
    assert.equal(journey.days[0].targetValue, 99, "the existing today snapshot remains authoritative");
    assert.ok(journey.days.slice(1).every((day) => day.targetValue === 10));
    for (const day of journey.days.slice(1)) {
      const weekday = new Date(`${day.date.slice(0, 10)}T00:00:00.000Z`).getUTCDay();
      assert.equal(day.scheduled, weekday >= 1 && weekday <= 5);
    }
    assert.equal(journey.successful, 0, "past check-ins are not retroactive journey obligations");
    assert.equal(journey.earnings.xp, 0);
    assert.equal(journey.earnings.coins, 0);

    const [oldCheckinAfter] = await adminPool.query(
      `SELECT * FROM ${quote("checkins")} WHERE habit_id = $1 AND date = $2`, [habitId, yesterday],
    ).then((result) => result.rows);
    const [oldDayAfter] = await adminPool.query(
      `SELECT * FROM ${quote("habit_days")} WHERE habit_id = $1 AND date = $2`, [habitId, yesterday],
    ).then((result) => result.rows);
    assert.deepEqual(oldCheckinAfter, oldCheckinBefore);
    assert.deepEqual(oldDayAfter, oldDayBefore);
    const allDays = await adminPool.query(
      `SELECT * FROM ${quote("habit_days")} WHERE habit_id = $1 ORDER BY date`, [habitId],
    ).then((result) => result.rows);
    assert.equal(allDays.length, 23, "preserved history plus exactly 22 journey calendar nodes");
    const [reward] = await adminPool.query(
      `SELECT journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`, [rewardId],
    ).then((result) => result.rows);
    assert.equal(reward.journey_required, true);
    assert.equal(reward.journey_unlocked_at, null);
    const [user] = await rows("users");
    assert.equal(user.xp, 17);
    assert.equal(user.coins, 42);
    assert.equal((await rows("coin_transactions")).length, 0);
  } finally {
    await api.close();
  }
});

test("starting a legacy journey is owner-checked and parallel retries create only one calendar plan", async () => {
  await reset();
  const userId = await seedUser();
  const otherUserId = await seedUser({ id: "journey-start-other-user" });
  const habitId = await seedHabit({ userId });
  const untouchedHabitId = await seedHabit({ userId });
  await seedDailyJourney(untouchedHabitId, addDays(dailyToday, -5));
  const api = await startJourneyApi(userId);
  const otherApi = await startJourneyApi(otherUserId);
  try {
    assert.equal((await otherApi.request(`/habits/${habitId}/journey`, "POST")).status, 404);
    const [notStarted] = await adminPool.query(
      `SELECT journey_start_date FROM ${quote("habits")} WHERE id = $1`, [habitId],
    ).then((result) => result.rows);
    assert.equal(notStarted.journey_start_date, null);

    const [first, retry] = await Promise.all([
      api.request(`/habits/${habitId}/journey`, "POST"),
      api.request(`/habits/${habitId}/journey`, "POST"),
    ]);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    const [journey, retryJourney] = await Promise.all([first.json(), retry.json()]);
    assert.deepEqual(retryJourney, journey, "idempotent retries return the same enriched journey");
    assert.equal(journey.startDate.slice(0, 10), dailyToday);
    assert.equal(journey.currentDay, 1);
    assert.equal(journey.days.length, 22);
    assert.equal(journey.days[0].dayNumber, 1);
    const [journeyRows, revisions, untouched] = await Promise.all([
      adminPool.query(`SELECT * FROM ${quote("habit_days")} WHERE habit_id = $1`, [habitId]),
      adminPool.query(`SELECT * FROM ${quote("habit_plan_revisions")} WHERE habit_id = $1`, [habitId]),
      adminPool.query(`SELECT journey_start_date FROM ${quote("habits")} WHERE id = $1`, [untouchedHabitId]),
    ]);
    assert.equal(journeyRows.rows.length, 22);
    assert.equal(revisions.rows.length, 1);
    assert.equal(
      untouched.rows[0].journey_start_date.toISOString().slice(0, 10),
      addDays(dailyToday, -5),
    );
    const [user] = await rows("users");
    assert.equal(user.xp, 0);
    assert.equal(user.coins, 0);
    assert.equal((await rows("coin_transactions")).length, 0);
  } finally {
    await Promise.all([api.close(), otherApi.close()]);
  }
});

test("reverse-linked reward creation requires the associated journey before redemption", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, dailyToday);
  const api = await startJourneyApi(userId);
  try {
    const response = await api.request("/rewards", "POST", {
      habitId,
      title: "Reverse-linked reward",
      emoji: "🎁",
      coinCost: 20,
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const [reward] = await adminPool.query(
      `SELECT habit_id, journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`,
      [created.id],
    ).then((result) => result.rows);
    assert.equal(reward.habit_id, habitId);
    assert.equal(reward.journey_required, true);
    assert.equal(reward.journey_unlocked_at, null);

    const preview = await api.request(`/habits/${habitId}/journey`);
    assert.equal(preview.status, 200);
    const journey = await preview.json();
    assert.equal(journey.selectedReward.id, created.id,
      "reverse-linked historical reward remains visible when there is no forward selection");
    assert.equal(journey.rewardUnlocked, false);
    assert.equal((await api.request(`/rewards/${created.id}/redeem`, "POST")).status, 400);
    const [user] = await rows("users");
    assert.equal(user.coins, 100);
    assert.equal((await rows("coin_transactions")).length, 0);
  } finally {
    await api.close();
  }
});

test("reverse-linked reward gate is established when a legacy journey starts and survives habit deletion", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const habitId = await seedHabit({ userId });
  const rewardId = await seedReward({ userId, habitId, coinCost: 20 });
  const api = await startJourneyApi(userId);
  try {
    const started = await api.request(`/habits/${habitId}/journey`, "POST");
    assert.equal(started.status, 200);
    const [afterStart] = await adminPool.query(
      `SELECT journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`,
      [rewardId],
    ).then((result) => result.rows);
    assert.equal(afterStart.journey_required, true);
    assert.equal(afterStart.journey_unlocked_at, null);

    assert.equal((await api.request(`/habits/${habitId}`, "DELETE")).status, 204);
    const [afterDelete] = await adminPool.query(
      `SELECT habit_id, journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`,
      [rewardId],
    ).then((result) => result.rows);
    assert.equal(afterDelete.habit_id, null, "the reverse FK is nulled after preserving its gate");
    assert.equal(afterDelete.journey_required, true);
    assert.equal(afterDelete.journey_unlocked_at, null);
    assert.equal((await api.request(`/rewards/${rewardId}/redeem`, "POST")).status, 400);
    const [user] = await rows("users");
    assert.equal(user.coins, 100);
  } finally {
    await api.close();
  }
});

test("reverse-linked completed journeys unlock shared rewards while forward selection stays preview priority", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const qualifyingReverseHabitId = await seedHabit({ userId });
  const reverseLinkedHabitId = await seedHabit({ userId });
  const previewHabitId = await seedHabit({ userId });
  const forwardPreviewRewardId = await seedReward({ userId, coinCost: 10 });
  const reversePreviewRewardId = await seedReward({ userId, habitId: previewHabitId, coinCost: 10 });
  const sharedRewardId = await seedReward({
    userId,
    habitId: qualifyingReverseHabitId,
    coinCost: 20,
  });
  await seedDailyJourney(qualifyingReverseHabitId, addDays(dailyToday, -21));
  await seedCheckin({
    habitId: qualifyingReverseHabitId,
    userId,
    date: dailyToday,
    completed: true,
    value: 5,
  });
  await seedDailyJourney(reverseLinkedHabitId, dailyToday);
  await seedDailyJourney(previewHabitId, dailyToday);
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [qualifyingReverseHabitId, sharedRewardId],
  );
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [reverseLinkedHabitId, sharedRewardId],
  );
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [previewHabitId, forwardPreviewRewardId],
  );
  const api = await startJourneyApi(userId);
  try {
    const previewResponse = await api.request(`/habits/${previewHabitId}/journey`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.selectedReward.id, forwardPreviewRewardId,
      "the explicit forward selection retains preview priority over reverse-only associations");
    assert.notEqual(preview.selectedReward.id, reversePreviewRewardId);

    const sharedJourneyResponse = await api.request(`/habits/${reverseLinkedHabitId}/journey`);
    assert.equal(sharedJourneyResponse.status, 200);
    const sharedJourney = await sharedJourneyResponse.json();
    assert.equal(sharedJourney.selectedReward.id, sharedRewardId);
    assert.equal(sharedJourney.rewardUnlocked, true,
      "an associated completed reverse-linked journey unlocks the shared reward");
    const qualifyingJourneyResponse = await api.request(`/habits/${qualifyingReverseHabitId}/journey`);
    assert.equal(qualifyingJourneyResponse.status, 200);
    const qualifyingJourney = await qualifyingJourneyResponse.json();
    assert.equal(qualifyingJourney.selectedReward.id, sharedRewardId,
      "reverse-only associations remain visible when no forward reward is chosen");
    assert.equal(qualifyingJourney.finalEligibility.eligible, true);
    assert.equal(qualifyingJourney.rewardUnlocked, true);
    const [sharedReward] = await adminPool.query(
      `SELECT journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`,
      [sharedRewardId],
    ).then((result) => result.rows);
    assert.equal(sharedReward.journey_required, true);
    assert.ok(sharedReward.journey_unlocked_at instanceof Date);
    assert.equal((await api.request(`/rewards/${sharedRewardId}/redeem`, "POST")).status, 200,
      "a qualifying forward-linked alternate unlocks the shared reverse-linked reward");
    const [user] = await rows("users");
    assert.equal(user.coins, 80);
  } finally {
    await api.close();
  }
});

test("cross-owner reverse associations cannot establish or bypass another owner's reward gate", async () => {
  await reset();
  const rewardOwner = await seedUser({ id: "reverse-reward-owner", coins: 100 });
  const habitOwner = await seedUser({ id: "reverse-habit-owner", coins: 100 });
  const foreignHabitId = await seedHabit({ userId: habitOwner });
  const rewardId = await seedReward({ userId: rewardOwner, habitId: foreignHabitId, coinCost: 20 });
  await seedDailyJourney(foreignHabitId, dailyToday);
  const ownerApi = await startJourneyApi(rewardOwner);
  const habitApi = await startJourneyApi(habitOwner);
  try {
    const invalidCreate = await ownerApi.request("/rewards", "POST", {
      habitId: foreignHabitId,
      title: "Cross-owner reverse reward",
      emoji: "🎁",
      coinCost: 5,
    });
    assert.equal(invalidCreate.status, 404);

    const journeyResponse = await habitApi.request(`/habits/${foreignHabitId}/journey`);
    assert.equal(journeyResponse.status, 200);
    const [reward] = await adminPool.query(
      `SELECT journey_required, journey_unlocked_at FROM ${quote("rewards")} WHERE id = $1`,
      [rewardId],
    ).then((result) => result.rows);
    assert.equal(reward.journey_required, false,
      "another owner's reverse-linked reward is not associated with this habit");
    assert.equal(reward.journey_unlocked_at, null);
    assert.equal((await habitApi.request(`/rewards/${rewardId}/redeem`, "POST")).status, 404);
    assert.equal((await ownerApi.request(`/rewards/${rewardId}/redeem`, "POST")).status, 200,
      "the reward owner retains legacy redemption behavior for an invalid cross-owner association");
    const users = await rows("users");
    assert.equal(users.find((user) => user.id === rewardOwner).coins, 80);
    assert.equal(users.find((user) => user.id === habitOwner).coins, 100);
  } finally {
    await Promise.all([ownerApi.close(), habitApi.close()]);
  }
});

test("today is counted missed only with explicit missed execution evidence", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, dailyToday);
  const api = await startJourneyApi(userId);
  try {
    const pendingResponse = await api.request(`/habits/${habitId}/journey`);
    const pending = await pendingResponse.json();
    assert.equal(pending.consistency.eligibleDays, 1);
    assert.equal(pending.missedDays, 0);

    await service.recordCheckin(userId, habitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      completed: false,
      missedReason: "no_time",
    });
    const missedResponse = await api.request(`/habits/${habitId}/journey`);
    const missed = await missedResponse.json();
    assert.equal(missed.consistency.eligibleDays, 1);
    assert.equal(missed.missedDays, 1);
    assert.equal(missed.days[0].status, "missed");
    assert.equal(missed.days[0].actualValue, null);
    assert.equal(missed.days[0].missedReason, "no_time");
  } finally {
    await api.close();
  }
});

test("historical unknown XP stays nullable/partial and never backfills from difficulty or wallet", async () => {
  await reset();
  const userId = await seedUser({ xp: 17, coins: 23 });
  const habitId = await seedHabit({ userId });
  const startDate = addDays(dailyToday, -21);
  await seedDailyJourney(habitId, startDate);
  await seedCheckin({
    habitId,
    userId,
    date: addDays(startDate, 2),
    completed: true,
    difficulty: "hard",
  });
  const api = await startJourneyApi(userId);
  try {
    const response = await api.request(`/habits/${habitId}/journey`);
    assert.equal(response.status, 200);
    const journey = await response.json();
    assert.deepEqual(journey.earnings, {
      xp: 0,
      coins: 0,
      xpComplete: false,
      unknownCheckins: 1,
      coinHistoryMayBeIncomplete: true,
    });
    const [user] = await rows("users");
    assert.equal(user.xp, 17);
    assert.equal(user.coins, 23);
    assert.equal((await rows("coin_transactions")).length, 0);
  } finally {
    await api.close();
  }
});

test("elapsed incomplete journey expires and selected reward remains locked; another owner cannot link a habit", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const otherUser = await seedUser({ id: "journey-owner-2", coins: 100 });
  const habitId = await seedHabit({ userId });
  const otherHabit = await seedHabit({ userId: otherUser });
  const rewardId = await seedReward({ userId, coinCost: 15 });
  await adminPool.query(`UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`, [habitId, rewardId]);
  await seedDailyJourney(habitId, addDays(dailyToday, -22));

  const api = await startJourneyApi(userId);
  try {
    const response = await api.request(`/habits/${habitId}/journey`);
    assert.equal(response.status, 200);
    const journey = await response.json();
    assert.equal(journey.status, "expired");
    assert.equal(journey.rewardUnlocked, false);
    assert.equal(journey.finalEligibility.eligible, false);
    assert.equal((await api.request(`/rewards/${rewardId}/redeem`, "POST")).status, 400);

    const wrongHabitLink = await api.request("/rewards", "POST", {
      habitId: otherHabit, title: "Cross-owner link", emoji: "🎁", coinCost: 5,
    });
    assert.equal(wrongHabitLink.status, 404);
    const [owner] = await rows("users");
    assert.equal(owner.coins, 100, "expired reward gate does not spend coins");
    assert.equal((await rows("coin_transactions")).length, 0);
    assert.ok(otherHabit > 0);
  } finally {
    await api.close();
  }
});

test("historical journey check-ins cannot create or alter completion/actuals but allow reflection-only retries", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const startDate = addDays(dailyToday, -21);
  await seedDailyJourney(habitId, startDate);
  const historicalDate = addDays(startDate, 5);
  await seedCheckin({
    habitId,
    userId,
    date: historicalDate,
    completed: false,
    value: 1,
  });

  await assert.rejects(
    service.recordCheckin(userId, habitId, {
      ...input(historicalDate, 5),
      completed: true,
    }),
    /Past journey check-ins cannot be created or change completion\/actual values/,
  );
  await assert.rejects(
    service.recordCheckin(userId, habitId, {
      date: new Date(`${addDays(startDate, 6)}T00:00:00.000Z`),
      completed: true,
      value: 5,
    }),
    /Past journey check-ins cannot be created or change completion\/actual values/,
  );

  const retry = await service.recordCheckin(userId, habitId, {
    ...input(historicalDate, 1),
    completed: false,
  });
  assert.equal(retry.completed, false);
  const reflection = await service.recordCheckin(userId, habitId, {
    date: new Date(`${historicalDate}T00:00:00.000Z`),
    note: "Reflection only",
    moodRating: 4,
    difficulty: "hard",
  });
  assert.equal(reflection.completed, false);
  const [checkin] = await rows("checkins");
  assert.equal(checkin.value, 1);
  assert.equal(checkin.completed, false);
  assert.equal(checkin.note, "Reflection only");
  assert.equal(checkin.mood_rating, 4);
  assert.equal(checkin.difficulty, "hard");
  assert.equal(checkin.xp_earned, null);
  const [user] = await rows("users");
  assert.equal(user.xp, 0);
  assert.equal(user.coins, 0);
  assert.equal((await rows("coin_transactions")).length, 0);
});

test("journey reward gate survives unlink, reassignment, and habit deletion; another finished selection can unlock it", async () => {
  await reset();
  const userId = await seedUser({ coins: 100 });
  const unfinishedHabitId = await seedHabit({ userId });
  const firstRewardId = await seedReward({ userId, coinCost: 15 });
  const secondRewardId = await seedReward({ userId, coinCost: 15 });
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [unfinishedHabitId, firstRewardId],
  );
  await seedDailyJourney(unfinishedHabitId, dailyToday);

  const api = await startJourneyApi(userId);
  try {
    const unlink = await api.request(`/habits/${unfinishedHabitId}`, "PATCH", { rewardId: null });
    assert.equal(unlink.status, 200);
    let rewards = await rows("rewards");
    assert.equal(rewards[0].journey_required, true);
    assert.equal(rewards[0].journey_unlocked_at, null);
    assert.equal((await api.request(`/rewards/${firstRewardId}/redeem`, "POST")).status, 400);

    const reattach = await api.request(`/habits/${unfinishedHabitId}`, "PATCH", {
      rewardId: firstRewardId,
    });
    assert.equal(reattach.status, 200);
    const change = await api.request(`/habits/${unfinishedHabitId}`, "PATCH", {
      rewardId: secondRewardId,
    });
    assert.equal(change.status, 200);
    const removeHabit = await api.request(`/habits/${unfinishedHabitId}`, "DELETE");
    assert.equal(removeHabit.status, 204);
    rewards = await rows("rewards");
    assert.equal(rewards[0].journey_required, true);
    assert.equal(rewards[0].journey_unlocked_at, null);
    assert.equal(rewards[1].journey_required, true);
    assert.equal(rewards[1].journey_unlocked_at, null);
    assert.equal((await api.request(`/rewards/${firstRewardId}/redeem`, "POST")).status, 400);
    assert.equal((await api.request(`/rewards/${secondRewardId}/redeem`, "POST")).status, 400);

    const qualifyingHabitId = await seedHabit({ userId });
    await adminPool.query(
      `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
      [qualifyingHabitId, firstRewardId],
    );
    const startDate = addDays(dailyToday, -21);
    await seedDailyJourney(qualifyingHabitId, startDate);
    const registerSelection = await api.request(`/habits/${qualifyingHabitId}`, "PATCH", {
      rewardId: firstRewardId,
    });
    assert.equal(registerSelection.status, 200);
    await service.recordCheckin(userId, qualifyingHabitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      completed: true,
      value: 5,
    });
    const journeyResponse = await api.request(`/habits/${qualifyingHabitId}/journey`);
    assert.equal(journeyResponse.status, 200);
    const journey = await journeyResponse.json();
    assert.equal(journey.finalEligibility.eligible, true);
    rewards = await rows("rewards");
    assert.ok(rewards[0].journey_unlocked_at instanceof Date);
    assert.equal(rewards[1].journey_unlocked_at, null);

    const unlockViaOtherJourney = await api.request(`/rewards/${firstRewardId}/redeem`, "POST");
    assert.equal(unlockViaOtherJourney.status, 200);
    assert.equal((await api.request(`/rewards/${secondRewardId}/redeem`, "POST")).status, 400,
      "deleting an incomplete selected journey does not unlock its own reward");
  } finally {
    await api.close();
  }
});

test("journey reward migration backfills only owner-matched, unredeemed defined selections and is repeatable", async () => {
  await reset();
  const userId = await seedUser();
  const otherUser = await seedUser({ id: "journey-migration-other" });
  const definedHabitId = await seedHabit({ userId });
  const legacyHabitId = await seedHabit({ userId });
  const foreignRewardHabitId = await seedHabit({ userId: otherUser });
  const forwardOwnerMismatchHabitId = await seedHabit({ userId });
  const definedRewardId = await seedReward({ userId });
  const reverseDefinedRewardId = await seedReward({ userId, habitId: definedHabitId });
  const redeemedRewardId = await seedReward({ userId });
  const foreignReverseRewardId = await seedReward({ userId, habitId: foreignRewardHabitId });
  const foreignForwardRewardId = await seedReward({ userId: otherUser });
  await seedDailyJourney(definedHabitId, dailyToday);
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [definedHabitId, definedRewardId],
  );
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [legacyHabitId, redeemedRewardId],
  );
  await adminPool.query(
    `UPDATE ${quote("habits")} SET reward_id = $2 WHERE id = $1`,
    [forwardOwnerMismatchHabitId, foreignForwardRewardId],
  );
  await seedDailyJourney(foreignRewardHabitId, dailyToday);
  await seedDailyJourney(forwardOwnerMismatchHabitId, dailyToday);
  await adminPool.query(`UPDATE ${quote("rewards")} SET is_redeemed = true WHERE id = $1`, [redeemedRewardId]);
  const backfill = `UPDATE ${quote("rewards")} r
    SET journey_required = true
    FROM ${quote("habits")} h
    WHERE (h.reward_id = r.id OR r.habit_id = h.id) AND h.user_id = r.user_id
      AND h.journey_start_date IS NOT NULL AND h.journey_length = 22
      AND r.is_redeemed = false AND r.journey_required = false`;
  await adminPool.query(backfill);
  await adminPool.query(backfill);
  const rewardRows = await rows("rewards");
  assert.equal(rewardRows[0].journey_required, true);
  assert.equal(rewardRows[0].journey_unlocked_at, null);
  assert.equal(rewardRows[1].journey_required, true, "reverse-only owner-matched associations are backfilled");
  assert.equal(rewardRows[2].journey_required, false, "already redeemed rewards stay unchanged");
  assert.equal(rewardRows[3].journey_required, false, "cross-owner reverse associations do not backfill");
  assert.equal(rewardRows[4].journey_required, false, "cross-owner forward associations do not backfill");
  assert.ok(legacyHabitId > 0);
});

test("real check-ins override stale execution status; elapsed execution-only activity is missed with unknown actuals null", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId });
  const startDate = addDays(dailyToday, -21);
  await seedDailyJourney(habitId, startDate);
  const elapsedExecutionStatuses = [
    "in_progress", "paused", "minimum_reached", "target_reached", "pending_reflection", "completed",
  ];
  for (let index = 0; index < elapsedExecutionStatuses.length; index++) {
    await seedExecution({
      habitId,
      date: addDays(startDate, index + 1),
      dayNumber: index + 2,
      status: elapsedExecutionStatuses[index],
      actualSeconds: 300,
    });
  }
  await seedExecution({
    habitId,
    date: dailyToday,
    dayNumber: 22,
    status: "completed",
    actualSeconds: 900,
  });
  const api = await startJourneyApi(userId);
  try {
    const firstResponse = await api.request(`/habits/${habitId}/journey`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    for (let index = 0; index < elapsedExecutionStatuses.length; index++) {
      const day = first.days.find((item) => item.date.slice(0, 10) === addDays(startDate, index + 1));
      assert.equal(day.status, "missed", `${elapsedExecutionStatuses[index]} cannot imply elapsed success`);
      assert.equal(day.actualValue, null);
    }
    assert.equal(first.days.at(-1).status, "pending",
      "an execution marked completed without a real check-in is not a success");
    assert.equal(first.days.at(-1).actualValue, null);
    assert.equal(first.missedDays, 21, "timer/execution state alone does not make today missed or successful");

    await adminPool.query(
      `UPDATE ${quote("habit_daily_executions")}
       SET status = 'missed', missed_reason = 'no_time'
       WHERE habit_id = $1 AND date = $2`,
      [habitId, dailyToday],
    );
    const missedResponse = await api.request(`/habits/${habitId}/journey`);
    const missed = await missedResponse.json();
    assert.equal(missed.days.at(-1).status, "missed", "explicit missed execution today remains missed");
    assert.equal(missed.missedDays, 22);

    await service.recordCheckin(userId, habitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      completed: true,
      value: 5,
    });
    const successfulResponse = await api.request(`/habits/${habitId}/journey`);
    const successful = await successfulResponse.json();
    assert.equal(successful.days.at(-1).status, "completed",
      "a real successful check-in takes precedence over stale missed execution state");
    assert.equal(successful.days.at(-1).actualValue, 5);
    assert.equal(successful.missedDays, 21);
  } finally {
    await api.close();
  }
});

test("private journey rewards unlock and claim from server journey state without touching coin rewards", async () => {
  await reset();
  const userId = await seedUser({ id: "journey-reward-owner", coins: 37, xp: 12 });
  const otherUserId = await seedUser({ id: "journey-reward-other" });
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, addDays(dailyToday, -21));

  const ownerApi = await startJourneyApi(userId);
  const otherApi = await startJourneyApi(otherUserId);
  try {
    const create = await ownerApi.request("/journey-rewards", "POST", {
      habitId,
      title: "A day at the coast",
      type: "experience",
      description: "Take a real break after completing the journey.",
      estimatedValue: 75,
    });
    assert.equal(create.status, 201);
    const pending = await create.json();
    assert.equal(pending.status, "pending");
    assert.equal(pending.currentDay, 22);
    assert.equal(pending.daysRemaining, 0);
    const prematureClaim = await ownerApi.request(`/journey-rewards/${pending.id}/claim`, "POST");
    assert.equal(prematureClaim.status, 409, "calendar completion alone cannot unlock the reward");

    await service.recordCheckin(userId, habitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      completed: true,
      value: 5,
    });
    const staleUnlink = await ownerApi.request(`/journey-rewards/${pending.id}`, "PATCH", {
      confirm: true,
      habitId: null,
    });
    assert.equal(staleUnlink.status, 409,
      "a completed journey is synchronized before a pending reward can be detached");
    const beforeClaimWallet = (await adminPool.query(
      `SELECT coins, xp FROM ${quote("users")} WHERE id = $1`,
      [userId],
    )).rows[0];
    const beforeClaimLedger = await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id = $1`,
      [userId],
    );
    const refreshed = await ownerApi.request(`/journey-rewards/${pending.id}`);
    assert.equal(refreshed.status, 200);
    const unlocked = await refreshed.json();
    assert.equal(unlocked.status, "unlocked");
    assert.ok(unlocked.unlockedAt);

    const dashboardResponse = await ownerApi.request("/dashboard/today");
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.realRewards.length, 1);
    assert.equal(dashboard.realRewards[0].status, "unlocked");
    assert.equal(dashboard.realRewards[0].progressPercent, 100);

    const wrongOwner = await otherApi.request(`/journey-rewards/${pending.id}`);
    assert.equal(wrongOwner.status, 404);
    assert.deepEqual(await (await otherApi.request("/journey-rewards")).json(), []);

    const firstClaim = await ownerApi.request(`/journey-rewards/${pending.id}/claim`, "POST");
    assert.equal(firstClaim.status, 200);
    const claimed = await firstClaim.json();
    assert.equal(claimed.status, "claimed");
    assert.ok(claimed.claimedAt);
    const repeatedClaim = await ownerApi.request(`/journey-rewards/${pending.id}/claim`, "POST");
    assert.equal(repeatedClaim.status, 200);
    assert.equal((await repeatedClaim.json()).claimedAt, claimed.claimedAt);

    const afterClaimWallet = (await adminPool.query(
      `SELECT coins, xp FROM ${quote("users")} WHERE id = $1`,
      [userId],
    )).rows[0];
    const afterClaimLedger = await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id = $1`,
      [userId],
    );
    assert.deepEqual(afterClaimWallet, beforeClaimWallet,
      "claiming a real-world reward does not grant or spend XP/coins");
    assert.equal(afterClaimLedger.rows[0].count, beforeClaimLedger.rows[0].count);
    assert.equal((await rows("rewards")).length, 0, "journey rewards stay outside the coin store");
  } finally {
    await Promise.all([ownerApi.close(), otherApi.close()]);
  }
});

test("journey reward ownership, strict request fields, image provenance, and one-reward attachment are enforced", async () => {
  await reset();
  const userId = await seedUser({ id: "journey-reward-validation" });
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, addDays(dailyToday, -1));
  const api = await startJourneyApi(userId);
  try {
    const [beforeHabits, forgedCreate] = await Promise.all([
      adminPool.query(`SELECT count(*)::int AS count FROM ${quote("habits")} WHERE user_id = $1`, [userId]),
      api.request("/journey-rewards", "POST", {
        title: "Forged",
        type: "physical",
        status: "unlocked",
        userId: "someone-else",
        currentDay: 22,
      }),
    ]);
    assert.equal(forgedCreate.status, 400, "server state and owner fields are rejected");

    const [first, second] = await Promise.all([
      api.request("/journey-rewards", "POST", {
        habitId, title: "One reward", type: "physical",
      }),
      api.request("/journey-rewards", "POST", {
        habitId, title: "Duplicate reward", type: "physical",
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const reward = first.status === 201 ? await first.json() : await second.json();
    assert.equal(reward.status, "pending");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("journey_rewards")} WHERE habit_id = $1`,
      [habitId],
    )).rows[0].count, 1);

    const forgedUpdate = await api.request(`/journey-rewards/${reward.id}`, "PATCH", {
      confirm: true,
      status: "claimed",
      habitId: null,
    });
    assert.equal(forgedUpdate.status, 400);

    const invalidImageHabit = await api.request("/habits", "POST", {
      title: "With unclaimed image",
      emoji: "🌱",
      category: "health",
      cadence: "daily",
      unit: "minutes",
      targetValue: 10,
      difficulty: "easy",
      goalType: "build",
      journeyReward: {
        title: "Unclaimed photo",
        type: "physical",
        imageObjectPath: "/objects/uploads/not-owned",
      },
    });
    assert.equal(invalidImageHabit.status, 400,
      "an image not issued to this user cannot be attached to a new journey");
    const afterHabits = await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habits")} WHERE user_id = $1`,
      [userId],
    );
    assert.equal(afterHabits.rows[0].count, beforeHabits.rows[0].count,
      "failed image validation leaves no partially-created habit");

    const createdWithForgedOwner = await api.request("/habits", "POST", {
      title: "Forged ownership",
      emoji: "🌱",
      category: "health",
      cadence: "daily",
      unit: "minutes",
      targetValue: 10,
      difficulty: "easy",
      goalType: "build",
      userId: "another-user",
    });
    assert.equal(createdWithForgedOwner.status, 400);
  } finally {
    await api.close();
  }
});

test("minimum-success final check-in, private unlock, and coin grant roll back together then retry once", async () => {
  await reset();
  const userId = await seedUser({ id: "journey-reward-atomic-boundary", coins: 9, xp: 2 });
  const habitId = await seedHabit({ userId });
  await seedDailyJourney(habitId, addDays(dailyToday, -21), {
    targetValue: 10,
    minimumValue: 5,
  });
  const rewardInsert = await adminPool.query(
    `INSERT INTO ${quote("journey_rewards")} (user_id, habit_id, title, type)
     VALUES ($1, $2, 'Minimum finish reward', 'physical') RETURNING id`,
    [userId, habitId],
  );
  const rewardId = rewardInsert.rows[0].id;
  const before = (await adminPool.query(
    `SELECT u.coins, u.xp, h.current_streak, h.journey_completed_at
     FROM ${quote("users")} u JOIN ${quote("habits")} h ON h.user_id = u.id
     WHERE u.id = $1 AND h.id = $2`,
    [userId, habitId],
  )).rows[0];
  const ledgerBefore = (await adminPool.query(
    `SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id = $1`,
    [userId],
  )).rows[0].count;

  await adminPool.query(`
    CREATE FUNCTION ${quote("reject_journey_reward_unlock")}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF OLD.status = 'pending' AND NEW.status = 'unlocked' THEN
        RAISE EXCEPTION 'injected journey reward unlock failure';
      END IF;
      RETURN NEW;
    END;
    $function$`);
  let triggerInstalled = false;
  try {
    await adminPool.query(
      `CREATE TRIGGER reject_journey_reward_unlock
       BEFORE UPDATE ON ${quote("journey_rewards")}
       FOR EACH ROW EXECUTE FUNCTION ${quote("reject_journey_reward_unlock")}()`,
    );
    triggerInstalled = true;
    await assert.rejects(service.recordCheckin(userId, habitId, {
      date: new Date(`${dailyToday}T00:00:00.000Z`),
      value: 5,
    }));

    const failedBoundary = (await adminPool.query(
      `SELECT u.coins, u.xp, h.current_streak, h.journey_completed_at,
              r.status, r.unlocked_at,
              (SELECT count(*)::int FROM ${quote("checkins")} c
               WHERE c.habit_id = h.id AND c.date = $3) AS checkin_count,
              (SELECT count(*)::int FROM ${quote("coin_transactions")} ct
               WHERE ct.user_id = u.id) AS ledger_count
       FROM ${quote("users")} u
       JOIN ${quote("habits")} h ON h.user_id = u.id
       JOIN ${quote("journey_rewards")} r ON r.habit_id = h.id
       WHERE u.id = $1 AND h.id = $2`,
      [userId, habitId, dailyToday],
    )).rows[0];
    assert.equal(failedBoundary.coins, before.coins);
    assert.equal(failedBoundary.xp, before.xp);
    assert.equal(failedBoundary.current_streak, before.current_streak);
    assert.equal(failedBoundary.journey_completed_at, null);
    assert.equal(failedBoundary.status, "pending");
    assert.equal(failedBoundary.unlocked_at, null);
    assert.equal(failedBoundary.checkin_count, 0);
    assert.equal(failedBoundary.ledger_count, ledgerBefore);
  } finally {
    if (triggerInstalled) {
      await adminPool.query(
        `DROP TRIGGER reject_journey_reward_unlock ON ${quote("journey_rewards")}`,
      );
    }
    await adminPool.query(`DROP FUNCTION ${quote("reject_journey_reward_unlock")}()`);
  }

  const successfulMinimum = await service.recordCheckin(userId, habitId, {
    date: new Date(`${dailyToday}T00:00:00.000Z`),
    value: 5,
  });
  assert.equal(successfulMinimum.completed, true);
  assert.equal(successfulMinimum.targetCompleted, false,
    "minimum success completes the scheduled day without reaching the full target");
  assert.ok(successfulMinimum.habit.journeyCompletedAt);
  const successfulState = (await adminPool.query(
    `SELECT u.coins, u.xp, r.status, r.unlocked_at,
            (SELECT count(*)::int FROM ${quote("checkins")} c WHERE c.habit_id = h.id) AS checkin_count,
            (SELECT count(*)::int FROM ${quote("coin_transactions")} ct WHERE ct.user_id = u.id) AS ledger_count
     FROM ${quote("users")} u
     JOIN ${quote("habits")} h ON h.user_id = u.id
     JOIN ${quote("journey_rewards")} r ON r.habit_id = h.id
     WHERE u.id = $1 AND h.id = $2`,
    [userId, habitId],
  )).rows[0];
  assert.equal(successfulState.status, "unlocked");
  assert.ok(successfulState.unlocked_at);
  assert.equal(successfulState.checkin_count, 1);
  assert.ok(successfulState.coins > before.coins);
  assert.ok(successfulState.xp > before.xp);

  await service.recordCheckin(userId, habitId, {
    date: new Date(`${dailyToday}T00:00:00.000Z`),
    value: 5,
  });
  const retriedState = (await adminPool.query(
    `SELECT u.coins, u.xp, r.status, r.unlocked_at,
            (SELECT count(*)::int FROM ${quote("checkins")} c WHERE c.habit_id = h.id) AS checkin_count,
            (SELECT count(*)::int FROM ${quote("coin_transactions")} ct WHERE ct.user_id = u.id) AS ledger_count
     FROM ${quote("users")} u
     JOIN ${quote("habits")} h ON h.user_id = u.id
     JOIN ${quote("journey_rewards")} r ON r.habit_id = h.id
     WHERE u.id = $1 AND h.id = $2`,
    [userId, habitId],
  )).rows[0];
  assert.deepEqual(retriedState, successfulState,
    "a same-day retry cannot duplicate the check-in, wallet grant, or unlock timestamp");

  const api = await startJourneyApi(userId);
  try {
    const firstClaim = await api.request(`/journey-rewards/${rewardId}/claim`, "POST");
    assert.equal(firstClaim.status, 200);
    const first = await firstClaim.json();
    assert.equal(first.status, "claimed");
    const secondClaim = await api.request(`/journey-rewards/${rewardId}/claim`, "POST");
    assert.equal(secondClaim.status, 200);
    assert.equal((await secondClaim.json()).claimedAt, first.claimedAt);

    const afterClaims = (await adminPool.query(
      `SELECT u.coins, u.xp,
              (SELECT count(*)::int FROM ${quote("coin_transactions")} ct WHERE ct.user_id = u.id) AS ledger_count
       FROM ${quote("users")} u WHERE u.id = $1`,
      [userId],
    )).rows[0];
    assert.deepEqual(afterClaims, {
      coins: retriedState.coins,
      xp: retriedState.xp,
      ledger_count: retriedState.ledger_count,
    }, "claim retries do not touch the coin or XP wallets");
  } finally {
    await api.close();
  }
});

function memoryStorageKey(objectPath) {
  return `test-bucket/private/${objectPath.slice("/objects/".length)}`;
}

function setMemoryStorageObject(objectPath, {
  userId,
  contentType = "image/png",
  contents = validMemoryPng,
  acl = userId ? { owner: userId, visibility: "private" } : null,
  retainedMetadata = undefined,
  reportedSize = contents.length,
} = {}) {
  const metadata = {
    contentType,
    size: String(reportedSize),
    metadata: {
      ...(acl ? { "custom:aclPolicy": JSON.stringify(acl) } : {}),
      ...(retainedMetadata ? { "custom:retained": retainedMetadata } : {}),
    },
  };
  service.mockStorageObjects.set(memoryStorageKey(objectPath), {
    data: Buffer.from(contents),
    metadata,
  });
  return service.mockStorageObjects.get(memoryStorageKey(objectPath));
}

async function seedMemoryJourney(userId, id, startDate = addDays(dailyToday, -3)) {
  await seedUser({ id });
  const habitId = await seedHabit({ userId: id });
  await seedDailyJourney(habitId, startDate);
  await seedCheckin({
    userId: id,
    habitId,
    date: startDate,
    value: 12,
    difficulty: "hard",
    xpEarned: 7,
    coinsEarned: 3,
    rewardGranted: true,
  });
  return { userId: id, habitId, startDate };
}

async function memoryFinancialAndCompletionState(userId, habitId, date) {
  const result = await adminPool.query(
    `SELECT u.coins, u.xp, h.current_streak, h.longest_streak,
            h.last_checkin_date, h.journey_completed_at,
            c.completed, c.value, c.difficulty, c.xp_earned,
            c.coins_earned, c.reward_granted,
            (SELECT count(*)::int FROM ${quote("coin_transactions")} t WHERE t.user_id = u.id) AS ledger_count
     FROM ${quote("users")} u
     JOIN ${quote("habits")} h ON h.user_id = u.id AND h.id = $2
     JOIN ${quote("checkins")} c ON c.habit_id = h.id AND c.user_id = u.id AND c.date = $3
     WHERE u.id = $1`,
    [userId, habitId, date],
  );
  return result.rows[0];
}

test("private memory CRUD preserves ownership, saved-day context, and financial/check-in invariants", async () => {
  await reset();
  const owner = await seedMemoryJourney("memory-photo-owner", "memory-photo-owner");
  const attacker = await seedMemoryJourney("memory-photo-attacker", "memory-photo-attacker");
  await seedCheckin({
    userId: owner.userId,
    habitId: owner.habitId,
    date: addDays(owner.startDate, 1),
    value: 8,
    difficulty: "normal",
  });

  const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const foreignPhotoPath = "/objects/uploads/owner-photo";
  const ownerUploadPath = "/objects/uploads/owner-upload";
  const foreignObject = setMemoryStorageObject(foreignPhotoPath, {
    userId: owner.userId,
    retainedMetadata: "owner metadata",
  });
  const ownerUpload = setMemoryStorageObject(ownerUploadPath, {
    userId: owner.userId,
    acl: null,
    contentType: "image/png",
    contents: validMemoryPng,
  });
  await adminPool.query(
    `INSERT INTO ${quote("object_uploads")} (object_path, user_id) VALUES ($1, $2)`,
    [ownerUploadPath, owner.userId],
  );

  const ownerApi = await startJourneyApi(owner.userId);
  const attackerApi = await startJourneyApi(attacker.userId);
  try {
    const before = await memoryFinancialAndCompletionState(
      owner.userId, owner.habitId, owner.startDate,
    );
    const originalMetadata = structuredClone(foreignObject.metadata);

    const forgedCreate = await ownerApi.request("/memories", "POST", {
      habitId: owner.habitId,
      date: owner.startDate,
      photoObjectPath: foreignPhotoPath,
      journeyId: owner.habitId,
      userId: owner.userId,
    });
    assert.equal(forgedCreate.status, 400, "server-derived association and identity fields are rejected");
    assert.equal(foreignObject.readCount ?? 0, 0, "invalid requests never read object bytes");

    const attackResponse = await attackerApi.request("/memories", "POST", {
      habitId: attacker.habitId,
      date: attacker.startDate,
      photoObjectPath: foreignPhotoPath,
      caption: "Try to attach someone else's image",
    });
    assert.equal(attackResponse.status, 403);
    assert.match((await attackResponse.json()).error, /owned by this user/i);
    assert.equal(foreignObject.readCount ?? 0, 0, "foreign object bytes are never read");
    assert.deepEqual(foreignObject.metadata, originalMetadata,
      "foreign rejection preserves the original object metadata");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("memories")} WHERE user_id = $1`,
      [attacker.userId],
    )).rows[0].count, 0);

    const createdResponse = await ownerApi.request("/memories", "POST", {
      habitId: owner.habitId,
      date: owner.startDate,
      photoObjectPath: foreignPhotoPath,
      caption: "A saved-day memory",
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.note, "A saved-day memory");
    assert.equal(created.caption, "A saved-day memory");
    assert.equal(created.visibility, "private");
    assert.equal(created.habitId, owner.habitId);
    assert.equal(created.journeyId, owner.habitId);
    assert.equal(created.dayNumber, 1);
    assert.equal(created.journeyLength, 22);
    assert.equal(created.habitTitle, "Walk");
    assert.equal(created.targetValue, 10);
    assert.equal(created.actualValue, 12);
    assert.equal(created.unit, "minutes");
    assert.equal(created.difficulty, "hard");
    assert.ok(created.habitDayId > 0);
    assert.ok(created.updatedAt);

    const optimizedPath = created.photoUrl.replace("/api/storage", "");
    assert.notEqual(optimizedPath, foreignPhotoPath, "the source object is never overwritten");
    const optimizedObject = service.mockStorageObjects.get(memoryStorageKey(optimizedPath));
    assert.ok(optimizedObject, "a new optimized object is saved");
    assert.equal(optimizedObject.metadata.contentType, "image/webp");
    assert.deepEqual(JSON.parse(optimizedObject.metadata.metadata["custom:aclPolicy"]), {
      owner: owner.userId,
      visibility: "private",
    });
    assert.equal((await sharp(optimizedObject.data).metadata()).format, "webp");
    const derivedMetadata = await sharp(optimizedObject.data).metadata();
    assert.ok(derivedMetadata.width <= 1920 && derivedMetadata.height <= 1920);
    const storageRouteForPhoto = created.photoUrl.replace("/api", "");
    const optimizedOwnerRead = await ownerApi.request(storageRouteForPhoto);
    assert.equal(optimizedOwnerRead.status, 200);
    assert.deepEqual(Buffer.from(await optimizedOwnerRead.arrayBuffer()), optimizedObject.data);
    assert.equal((await attackerApi.request(storageRouteForPhoto)).status, 403,
      "the optimized memory photo is served only through its owner ACL");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("object_uploads")} WHERE object_path = $1 AND user_id = $2`,
      [optimizedPath, owner.userId],
    )).rows[0].count, 1, "optimized output provenance is registered");
    assert.deepEqual(foreignObject.metadata, originalMetadata,
      "processing a same-owner private object retains its source metadata");

    const uploadedResponse = await ownerApi.request("/memories", "POST", {
      habitId: owner.habitId,
      date: addDays(owner.startDate, 1),
      photoObjectPath: ownerUploadPath,
      caption: null,
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.caption, null);
    assert.equal(uploaded.note, "");
    assert.equal(uploaded.dayNumber, 2);
    assert.deepEqual(ownerUpload.metadata, {
      contentType: "image/png",
      size: String(validMemoryPng.length),
      metadata: {},
    }, "a provenance-verified source upload is not modified");

    const legacyNote = `Preserved legacy memory note: ${"old note ".repeat(45)}`;
    const legacyCreatedAt = new Date("2020-01-02T03:04:05.000Z");
    const legacyId = (await adminPool.query(
      `INSERT INTO ${quote("memories")}
         (user_id, habit_id, note, photo_object_path, date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [owner.userId, owner.habitId, legacyNote, foreignPhotoPath, owner.startDate, legacyCreatedAt],
    )).rows[0].id;
    const legacyResponse = await ownerApi.request(`/memories/${legacyId}`);
    assert.equal(legacyResponse.status, 200);
    const legacyMemory = await legacyResponse.json();
    assert.equal(legacyMemory.note, legacyNote);
    assert.equal(legacyMemory.caption, null,
      "oversized legacy notes remain intact as the note alias without violating the new caption limit");
    assert.equal(legacyMemory.photoUrl, `/api/storage${foreignPhotoPath}`);
    assert.equal(new Date(legacyMemory.createdAt).toISOString(), legacyCreatedAt.toISOString());
    assert.equal(legacyMemory.habitDayId, null);
    assert.equal(legacyMemory.journeyId, null,
      "a same-date legacy row is not inferred to belong to a journey day");
    assert.equal(legacyMemory.dayNumber, null);

    const duplicate = await ownerApi.request("/memories", "POST", {
      habitId: owner.habitId,
      date: owner.startDate,
      photoObjectPath: foreignPhotoPath,
    });
    assert.equal(duplicate.status, 409, "only one linked memory is allowed per saved day");

    const listed = await ownerApi.request(
      `/memories?habitId=${owner.habitId}&journeyId=${owner.habitId}`,
    );
    assert.equal(listed.status, 200);
    const list = await listed.json();
    assert.equal(list.length, 2);
    assert.ok(list.every((memory) => memory.visibility === "private"));
    assert.equal((await (await ownerApi.request(`/memories?habitId=${owner.habitId}`)).json()).length, 3);
    assert.deepEqual(
      await (await ownerApi.request(`/memories?journeyId=${owner.habitId + 1}`)).json(),
      [],
      "journey filters do not infer associations from legacy habit/date fields",
    );
    assert.equal((await attackerApi.request("/memories")).status, 200);
    assert.deepEqual(await (await attackerApi.request("/memories")).json(), []);
    assert.equal((await attackerApi.request(`/memories/${created.id}`)).status, 404);
    assert.equal((await attackerApi.request(`/memories/${created.id}`, "PATCH", {
      caption: "unauthorized",
    })).status, 404);
    assert.equal((await attackerApi.request(`/memories/${created.id}`, "DELETE")).status, 404);

    const detailResponse = await ownerApi.request(`/memories/${created.id}`);
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json()).habitDayId, created.habitDayId);

    const forgedUpdate = await ownerApi.request(`/memories/${created.id}`, "PATCH", {
      caption: "forged",
      photoObjectPath: "/objects/uploads/another-file",
    });
    assert.equal(forgedUpdate.status, 400);
    const updatedResponse = await ownerApi.request(`/memories/${created.id}`, "PATCH", {
      caption: "Updated caption",
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.caption, "Updated caption");
    assert.equal(updated.note, "Updated caption");
    assert.ok(new Date(updated.updatedAt).getTime() >= new Date(created.updatedAt).getTime());
    const clearedResponse = await ownerApi.request(`/memories/${created.id}`, "PATCH", {
      caption: null,
    });
    assert.equal(clearedResponse.status, 200);
    const cleared = await clearedResponse.json();
    assert.equal(cleared.caption, null);
    assert.equal(cleared.note, "");

    const journey = await ownerApi.request(`/habits/${owner.habitId}/journey`);
    assert.equal(journey.status, 200);
    const journeyPayload = await journey.json();
    const journeyDay = journeyPayload.days.find((day) => day.habitDayId === created.habitDayId);
    assert.equal(journeyDay.memoryId, created.id, "journey map exposes the owner-associated memory ID");
    const dailyState = await service.getDailyHabitState(
      owner.userId,
      owner.habitId,
      owner.startDate,
      dailyNow,
    );
    assert.equal(dailyState.habitDayId, created.habitDayId);
    assert.equal(dailyState.memoryId, created.id, "daily detail exposes the owner-associated memory ID");

    const beforeDelete = await memoryFinancialAndCompletionState(
      owner.userId, owner.habitId, owner.startDate,
    );
    const deleteResponse = await ownerApi.request(`/memories/${created.id}`, "DELETE");
    assert.equal(deleteResponse.status, 204);
    assert.equal((await ownerApi.request(`/memories/${created.id}`)).status, 404);
    assert.ok(service.mockStorageObjects.has(memoryStorageKey(optimizedPath)),
      "deleting a memory does not delete its potentially shared private object");
    const afterDelete = await memoryFinancialAndCompletionState(
      owner.userId, owner.habitId, owner.startDate,
    );
    assert.deepEqual(afterDelete, beforeDelete,
      "memory create/update/delete never changes check-ins, difficulty, XP, coins, or reward ledger");
    assert.deepEqual(afterDelete, before,
      "memory operations leave the original completion and financial state unchanged");
    const updatedJourney = await ownerApi.request(`/habits/${owner.habitId}/journey`);
    const updatedJourneyPayload = await updatedJourney.json();
    assert.equal(
      updatedJourneyPayload.days.find((day) => day.habitDayId === created.habitDayId).memoryId,
      null,
    );

    const ownerRead = await ownerApi.request("/storage/objects/uploads/owner-photo");
    assert.equal(ownerRead.status, 200, "the original owner retains access to their unchanged source");
    assert.deepEqual(Buffer.from(await ownerRead.arrayBuffer()), validMemoryPng);
    const attackerRead = await attackerApi.request("/storage/objects/uploads/owner-photo");
    assert.equal(attackerRead.status, 403, "the foreign caller cannot read the original object");
    const foreignUploadRead = await attackerApi.request("/storage/objects/uploads/owner-upload");
    assert.equal(foreignUploadRead.status, 403);
  } finally {
    await Promise.all([ownerApi.close(), attackerApi.close()]);
    if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
  }
});

test("memory capture rejects forged, future, rest, missing, unsuccessful, and out-of-journey days", async () => {
  await reset();
  const owner = await seedMemoryJourney("memory-eligibility-owner", "memory-eligibility-owner");
  const start = owner.startDate;
  const restDate = addDays(start, 2);
  const unsuccessfulDate = addDays(start, 1);
  const missingDate = addDays(start, 3);
  await adminPool.query(
    `UPDATE ${quote("habit_days")} SET scheduled = false WHERE habit_id = $1 AND date = $2`,
    [owner.habitId, restDate],
  );
  await seedCheckin({
    userId: owner.userId,
    habitId: owner.habitId,
    date: unsuccessfulDate,
    completed: false,
    value: 0,
  });
  await adminPool.query(
    `DELETE FROM ${quote("habit_days")} WHERE habit_id = $1 AND date = $2`,
    [owner.habitId, missingDate],
  );

  const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const sourcePath = "/objects/uploads/eligibility-source";
  const source = setMemoryStorageObject(sourcePath, { userId: owner.userId });
  const api = await startJourneyApi(owner.userId);
  try {
    const cases = [
      [{ habitId: owner.habitId, date: start, photoObjectPath: sourcePath, habitDayId: 1 }, 400],
      [{ habitId: owner.habitId, date: addDays(dailyToday, 1), photoObjectPath: sourcePath }, 400],
      [{ habitId: owner.habitId, date: restDate, photoObjectPath: sourcePath }, 400],
      [{ habitId: owner.habitId, date: missingDate, photoObjectPath: sourcePath }, 400],
      [{ habitId: owner.habitId, date: unsuccessfulDate, photoObjectPath: sourcePath }, 400],
      [{ habitId: owner.habitId, date: addDays(start, -1), photoObjectPath: sourcePath }, 400],
      [{ habitId: 999999, date: start, photoObjectPath: sourcePath }, 404],
      [{ habitId: owner.habitId, date: start, photoObjectPath: sourcePath, visibility: "friends" }, 400],
    ];
    for (const [body, expectedStatus] of cases) {
      const response = await api.request("/memories", "POST", body);
      assert.equal(response.status, expectedStatus, JSON.stringify(body));
    }
    assert.equal(source.readCount ?? 0, 0,
      "eligibility and unsupported fields are checked before any source bytes are read");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("memories")}`,
    )).rows[0].count, 0);

    const validHistorical = await api.request("/memories", "POST", {
      habitId: owner.habitId,
      date: start,
      photoObjectPath: sourcePath,
    });
    assert.equal(validHistorical.status, 201,
      "a historical successful day in the saved journey remains eligible");
  } finally {
    await api.close();
    if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
  }
});

test("memory photo validation enforces MIME/signature, size, pixels, and optimized private output", async () => {
  await reset();
  const userId = await seedUser({ id: "memory-image-validation" });
  const habitId = await seedHabit({ userId });
  const startDate = addDays(dailyToday, -5);
  await seedDailyJourney(habitId, startDate);
  for (let offset = 0; offset < 5; offset++) {
    await seedCheckin({
      userId,
      habitId,
      date: addDays(startDate, offset),
      value: 10 + offset,
      difficulty: "normal",
    });
  }

  const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const jpeg = await sharp(validMemoryPng).jpeg().toBuffer();
  const webp = await sharp(validMemoryPng).webp().toBuffer();
  const tooManyPixels = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: { r: 20, g: 30, b: 40 } },
  }).png().toBuffer();
  const oneByteOver = Buffer.concat([
    jpeg,
    Buffer.alloc(10 * 1024 * 1024 + 1 - jpeg.length),
  ]);
  const exactLimit = Buffer.concat([
    jpeg,
    Buffer.alloc(10 * 1024 * 1024 - jpeg.length),
  ]);
  const cases = [
    { path: "/objects/uploads/valid-png", contents: validMemoryPng, contentType: "image/png", date: startDate, expected: 201 },
    { path: "/objects/uploads/valid-jpeg", contents: jpeg, contentType: "image/jpeg", date: addDays(startDate, 1), expected: 201 },
    { path: "/objects/uploads/valid-webp", contents: webp, contentType: "image/webp", date: addDays(startDate, 2), expected: 201 },
    { path: "/objects/uploads/exact-limit", contents: exactLimit, contentType: "image/jpeg", date: addDays(startDate, 3), expected: 201 },
  ];
  const objects = new Map();
  for (const item of cases) {
    objects.set(item.path, setMemoryStorageObject(item.path, {
      userId,
      contents: item.contents,
      contentType: item.contentType,
    }));
  }
  const overPath = "/objects/uploads/over-limit";
  const overObject = setMemoryStorageObject(overPath, {
    userId,
    contents: oneByteOver,
    contentType: "image/jpeg",
  });
  const corruptPath = "/objects/uploads/corrupt";
  const corruptObject = setMemoryStorageObject(corruptPath, {
    userId,
    contents: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    contentType: "image/png",
  });
  const mismatchPath = "/objects/uploads/mime-mismatch";
  const mismatchObject = setMemoryStorageObject(mismatchPath, {
    userId,
    contents: jpeg,
    contentType: "image/png",
  });
  const unsupportedPath = "/objects/uploads/unsupported";
  const unsupportedObject = setMemoryStorageObject(unsupportedPath, {
    userId,
    contents: validMemoryPng,
    contentType: "image/gif",
  });
  const pixelsPath = "/objects/uploads/pixel-limit";
  const pixelsObject = setMemoryStorageObject(pixelsPath, {
    userId,
    contents: tooManyPixels,
    contentType: "image/png",
  });
  const api = await startJourneyApi(userId);
  try {
    for (const item of cases) {
      const response = await api.request("/memories", "POST", {
        habitId,
        date: item.date,
        photoObjectPath: item.path,
      });
      assert.equal(response.status, item.expected, item.path);
      const memory = await response.json();
      const optimizedPath = memory.photoUrl.replace("/api/storage", "");
      const optimizedObject = service.mockStorageObjects.get(memoryStorageKey(optimizedPath));
      assert.equal(optimizedObject.metadata.contentType, "image/webp");
      assert.equal((await sharp(optimizedObject.data).metadata()).format, "webp");
      assert.ok(optimizedObject.data.length <= 10 * 1024 * 1024);
      assert.deepEqual(JSON.parse(optimizedObject.metadata.metadata["custom:aclPolicy"]), {
        owner: userId,
        visibility: "private",
      });
    }

    const invalidCases = [
      { path: overPath, date: addDays(startDate, 4), status: 413 },
      { path: corruptPath, date: addDays(startDate, 4), status: 400 },
      { path: mismatchPath, date: addDays(startDate, 4), status: 415 },
      { path: unsupportedPath, date: addDays(startDate, 4), status: 415 },
      { path: pixelsPath, date: addDays(startDate, 4), status: 413 },
    ];
    for (const item of invalidCases) {
      const response = await api.request("/memories", "POST", {
        habitId,
        date: item.date,
        photoObjectPath: item.path,
      });
      assert.equal(response.status, item.status, item.path);
      assert.ok((await response.json()).error);
    }
    assert.equal(overObject.readCount ?? 0, 0, "oversized input is rejected from metadata before reading bytes");
    assert.equal(unsupportedObject.readCount ?? 0, 0, "unsupported declared MIME is rejected before reading bytes");
    assert.ok(corruptObject.readCount > 0);
    assert.ok(mismatchObject.readCount > 0);
    assert.ok(pixelsObject.readCount > 0);
    assert.equal(objects.get(cases[0].path).metadata.contentType, "image/png");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("memories")}`,
    )).rows[0].count, cases.length);
  } finally {
    await api.close();
    if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
  }
});

test("memory database failure cleans only its unreferenced derived object and cannot touch check-in rewards", async () => {
  await reset();
  const owner = await seedMemoryJourney("memory-write-failure", "memory-write-failure");
  const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const sourcePath = "/objects/uploads/write-failure-source";
  const source = setMemoryStorageObject(sourcePath, {
    userId: owner.userId,
    retainedMetadata: "source stays intact",
  });
  const sourceMetadata = structuredClone(source.metadata);
  await adminPool.query(
    `CREATE FUNCTION ${quote("reject_memory_insert")}() RETURNS trigger
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'injected memory insert failure';
     END;
     $$`,
  );
  await adminPool.query(
    `CREATE TRIGGER reject_memory_insert BEFORE INSERT ON ${quote("memories")}
     FOR EACH ROW EXECUTE FUNCTION ${quote("reject_memory_insert")}()`,
  );
  const api = await startJourneyApi(owner.userId);
  try {
    const before = await memoryFinancialAndCompletionState(
      owner.userId, owner.habitId, owner.startDate,
    );
    const response = await api.request("/memories", "POST", {
      habitId: owner.habitId,
      date: owner.startDate,
      photoObjectPath: sourcePath,
      caption: "The database insert will fail",
    });
    assert.equal(response.status, 500);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("memories")}`,
    )).rows[0].count, 0);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("object_uploads")}
       WHERE object_path LIKE '/objects/memory-images/%'`,
    )).rows[0].count, 0, "verified unreferenced output provenance is cleaned on insert failure");
    assert.equal([...service.mockStorageObjects.keys()]
      .some((key) => key.includes("/memory-images/")), false,
    "the unique unreferenced derived image is removed");
    assert.deepEqual(source.metadata, sourceMetadata, "failed persistence never modifies source metadata");
    assert.deepEqual(source.data, validMemoryPng, "failed persistence never modifies source bytes");
    assert.deepEqual(
      await memoryFinancialAndCompletionState(owner.userId, owner.habitId, owner.startDate),
      before,
      "memory persistence failure does not alter successful check-in, XP, coins, or reward state",
    );
  } finally {
    await api.close();
    await adminPool.query(`DROP TRIGGER IF EXISTS reject_memory_insert ON ${quote("memories")}`);
    await adminPool.query(`DROP FUNCTION IF EXISTS ${quote("reject_memory_insert")}()`);
    if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
  }
});

test("social check-in fanout is event-time, transition-only, and includes current group shares", async () => {
  await reset();
  const ownerId = await seedUser({ id: "social-checkin-owner" });
  await seedUser({ id: "social-checkin-friend" });
  await adminPool.query(
    `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
     VALUES ('social-checkin-friend', 'social-checkin-owner')`,
  );
  const privateHabitId = await seedHabit({ userId: ownerId });
  await seedDailyJourney(privateHabitId, dailyToday);
  await service.recordCheckin(ownerId, privateHabitId, input(dailyToday));
  await adminPool.query(
    `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
     VALUES ($1, 'journey', $2, 'friends')`,
    [ownerId, String(privateHabitId)],
  );
  await service.recordCheckin(ownerId, privateHabitId, input(dailyToday));
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_activity_events")} WHERE journey_id = $1`,
    [privateHabitId],
  )).rows[0].n, 0, "sharing enabled after a success does not publish or backfill the historical transition");

  const sharedHabitId = await seedHabit({ userId: ownerId });
  const journeyStart = addDays(dailyToday, -4);
  await seedDailyJourney(sharedHabitId, journeyStart);
  for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
    await adminPool.query(
      `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, value)
       VALUES ($1, $2, $3, true, 10)`,
      [sharedHabitId, ownerId, addDays(journeyStart, dayOffset)],
    );
  }
  await adminPool.query(
    `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
     VALUES ($1, 'journey', $2, 'friends')`,
    [ownerId, String(sharedHabitId)],
  );
  const group = (await adminPool.query(
    `INSERT INTO ${quote("groups")}
       (name, invite_code, goal_description, start_date, created_by)
     VALUES ('Shared journey group', 'SOCIAL-CHECKIN', 'Make progress', $1, $2)
     RETURNING id`,
    [dailyToday, ownerId],
  )).rows[0];
  await adminPool.query(
    `INSERT INTO ${quote("group_members")} (group_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, 'social-checkin-friend', 'member')`,
    [group.id, ownerId],
  );
  await adminPool.query(
    `INSERT INTO ${quote("social_group_journey_shares")} (group_id, user_id, habit_id)
     VALUES ($1, $2, $3)`,
    [group.id, ownerId, sharedHabitId],
  );
  await service.recordCheckin(ownerId, sharedHabitId, input(dailyToday));
  await service.recordCheckin(ownerId, sharedHabitId, input(dailyToday));
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_activity_events")}
     WHERE journey_id = $1 AND event_type = 'successful_day'`,
    [sharedHabitId],
  )).rows[0].n, 1);
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_group_activity_events")}
     WHERE group_id = $1 AND journey_id = $2 AND event_type = 'successful_day'`,
    [group.id, sharedHabitId],
  )).rows[0].n, 1, "a current group journey share emits only one successful-day event");
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_group_activity_events")}
     WHERE group_id = $1 AND journey_id = $2 AND event_type = 'milestone'`,
    [group.id, sharedHabitId],
  )).rows[0].n, 1, "the fifth scheduled success emits one group milestone");
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_notifications")}
     WHERE recipient_user_id = 'social-checkin-friend'
       AND type = 'shared_milestone'`,
  )).rows[0].n, 1, "the live friend audience receives the milestone notification once");
  assert.equal((await adminPool.query(
    `SELECT count(*)::int AS n FROM ${quote("social_notifications")}
     WHERE recipient_user_id = 'social-checkin-friend'
       AND type = 'group_milestone'`,
  )).rows[0].n, 1, "the current group audience receives its milestone notification once");
});

test("Feature 10 dashboard PostgreSQL HTTP acceptance matrix", async (t) => {
  await t.test("authentication, empty/new/no-habit, concurrency, and the whole-row no-write boundary", async () => {
    await reset();
    const ownerId = await seedDashboardUser({ onboardingCompleted: false });
    const api = await startJourneyApi(ownerId);
    try {
      const unauthorized = await api.request("/dashboard", "GET", undefined, null);
      assert.equal(unauthorized.status, 401);
      await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
      const before = await dashboardSnapshot();
      const responses = await Promise.all([
        api.request("/dashboard"),
        api.request("/dashboard"),
        api.request("/dashboard"),
      ]);
      const homes = await Promise.all(responses.map(async (response) => {
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json();
        service.GetDashboardHomeResponse.parse(body);
        return body;
      }));
      assert.ok(homes.every((home) => home.state === "new_user"));
      assert.ok(homes.every((home) => home.sectionStatus.habits === "empty"));
      assert.ok(homes.every((home) => home.focus === null && home.missedDay === null));
      assert.ok(homes.every((home) => home.completion === null));
      assert.deepEqual(await dashboardSnapshot(), before);
      assert.deepEqual((await adminPool.query(`SELECT * FROM ${quote("dashboard_write_audit")}`)).rows, []);

      await adminPool.query(`UPDATE ${quote("users")} SET onboarding_completed = true WHERE id = $1`, [ownerId]);
      const noHabit = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(noHabit.state, "no_habit");
      assert.equal(noHabit.completion, null);
      assert.equal(noHabit.profile.coins, 0);
      assert.equal(noHabit.character.walletCoins, 0);
    } finally {
      await api.close();
    }
  });

  await t.test("tracking active/paused contexts and analysis-available versus rest-day states", async () => {
    await reset();
    const ownerId = await seedDashboardUser({ id: "dashboard-context-owner" });
    const habit = await seedHabit({ userId: ownerId });
    await seedDailyJourney(habit, dailyToday);
    await adminPool.query(
      `UPDATE ${quote("habit_days")} SET scheduled = false WHERE habit_id = $1 AND date = $2`,
      [habit, dailyToday],
    );
    await adminPool.query(
      `INSERT INTO ${quote("tracking_sessions")} (user_id, date, status, interval_minutes)
       VALUES ($1,$2,'active',15)`,
      [ownerId, dailyToday],
    );
    const api = await startJourneyApi(ownerId);
    try {
      const active = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(active.focus, null);
      assert.equal(active.state, "tracking_active");
      await adminPool.query(
        `UPDATE ${quote("tracking_sessions")} SET status = 'paused' WHERE user_id = $1 AND date = $2`,
        [ownerId, dailyToday],
      );
      const paused = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(paused.state, "tracking_paused");
      await adminPool.query(`DELETE FROM ${quote("tracking_sessions")} WHERE user_id = $1`, [ownerId]);
      const rest = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(rest.state, "rest_day");
      const analysis = {
        status: "ready", headline: "Saved", observation: "", pattern: "", opportunity: "",
        suggestedChange: null, replacements: [],
      };
      await adminPool.query(
        `INSERT INTO ${quote("day_analysis_cache")} (user_id, date, data_hash, analysis)
         VALUES ($1,$2,'old-hash',$3::jsonb)`,
        [ownerId, dailyToday, JSON.stringify(analysis)],
      );
      const available = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(available.state, "analysis_available");
      await adminPool.query(
        `UPDATE ${quote("habit_days")} SET scheduled = true WHERE habit_id = $1 AND date = $2`,
        [habit, dailyToday],
      );
      const journeyFocus = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(journeyFocus.focus.habit.id, habit);
      assert.equal(journeyFocus.journey.habitId, habit, "the focused 22-day journey owns the primary journey preview");
      assert.equal(journeyFocus.journey.status, "active");
    } finally {
      await api.close();
    }
  });

  await t.test("confirmed time, Arabic categories, cached/stale coach inputs, and owner-only character/memory/social projections", async () => {
    await reset();
    const ownerId = await seedDashboardUser({
      id: "dashboard-owner-projection", timezone: "Asia/Riyadh", level: 4, xp: 55, coins: 123,
    });
    const friendId = await seedDashboardUser({ id: "dashboard-friend-projection", level: 9, xp: 88, coins: 777 });
    const ownerHabit = await seedHabit({ userId: ownerId });
    const riyadhToday = dateInTimezone(new Date(), "Asia/Riyadh");
    await adminPool.query(
      `INSERT INTO ${quote("time_entries")} (user_id, label, duration_minutes, date, category, source)
       VALUES ($1,'Study',25,$2,'study','manual'),($1,'Study 2',15,$2,'study','manual'),
             ($1,'Exercise',20,$2,'exercise','manual')`,
      [ownerId, riyadhToday],
    );
    await adminPool.query(
      `INSERT INTO ${quote("tracking_sessions")} (user_id, date, status, interval_minutes, started_at)
       VALUES ($1,$2,'active',15,now())`,
      [ownerId, riyadhToday],
    );
    await adminPool.query(
      `INSERT INTO ${quote("memories")} (user_id, habit_id, note, caption, visibility, date)
       VALUES ($1,$2,'owner-private-memory','Owner caption','private',$3),
             ($4,$2,'foreign-private-memory','Foreign caption','private',$3)`,
      [ownerId, ownerHabit, riyadhToday, friendId],
    );
    const [item] = (await adminPool.query(
      `INSERT INTO ${quote("character_items")} (name, slot, emoji, coin_cost, level_required)
       VALUES ('Dashboard Hat','hat','🎩',20,2) RETURNING id`,
    )).rows;
    await adminPool.query(
      `INSERT INTO ${quote("user_character_items")} (user_id, item_id, equipped) VALUES ($1,$2,true)`,
      [ownerId, item.id],
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id) VALUES ($1,$2)`,
      [ownerId < friendId ? ownerId : friendId, ownerId < friendId ? friendId : ownerId],
    );
    const friendHabit = await seedHabit({ userId: friendId });
    await seedDailyJourney(friendHabit, dailyToday);
    await adminPool.query(
      `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
       VALUES ($1,'journey',$2,'friends'),($1,'character','profile','private')`,
      [friendId, String(friendHabit)],
    );
    const hash = await service.getCurrentTrackedAnalysisHash(ownerId, riyadhToday, "Asia/Riyadh", null);
    const analysis = {
      status: "ready", headline: "A steady day", observation: "Confirmed work was logged.",
      pattern: "Study led today's time.", opportunity: "Keep the routine.",
      suggestedChange: null, replacements: [],
    };
    await adminPool.query(
      `INSERT INTO ${quote("day_analysis_cache")} (user_id, date, data_hash, analysis)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [ownerId, riyadhToday, hash, JSON.stringify(analysis)],
    );
    let providerCalls = 0;
    const originalGenerateText = service.geminiProvider.generateText;
    service.geminiProvider.generateText = async () => {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return JSON.stringify(analysis);
    };
    const api = await startJourneyApi(ownerId);
    try {
      const home = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(home.time.trackedMinutes, 60);
      assert.deepEqual(home.time.categoryTotals.map(({ category }) => category), ["study", "exercise"]);
      assert.equal(home.time.categoryTotals[0].label, "الدراسة");
      assert.equal(home.time.categoryTotals[1].label, "الرياضة");
      assert.equal(home.time.session.status, "active");
      assert.equal(home.coach.analysis.headline, analysis.headline);
      assert.equal(home.coach.isStale, false);
      assert.equal(home.profile.coins, 123);
      assert.equal(home.character.walletCoins, 123);
      assert.equal(home.character.level, 4);
      assert.equal(home.character.totalXp, 415);
      assert.deepEqual(home.character.equippedItems.map(({ name }) => name), ["Dashboard Hat"]);
      assert.equal(home.memory.note, "owner-private-memory");
      assert.equal(JSON.stringify(home).includes("foreign-private-memory"), false);
      assert.equal(home.friends.length, 1);
      assert.equal(home.friends[0].journey.title, "Walk");
      assert.deepEqual(home.friends[0].character, [], "private character ACL does not hide independently shared journey");
      assert.equal(providerCalls, 0, "dashboard must never call the analysis provider");

      await adminPool.query(
        `INSERT INTO ${quote("time_entries")} (user_id, label, duration_minutes, date, category, source)
         VALUES ($1,'New confirmed category',1,$2,'rest','manual')`,
        [ownerId, riyadhToday],
      );
      await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
      const stale = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(stale.coach.isStale, true, "confirmed analysis-input change marks saved analysis stale");
      assert.equal(stale.time.trackedMinutes, 61);
      assert.equal(providerCalls, 0);

      await adminPool.query(
        `UPDATE ${quote("social_shares")} SET visibility = 'friends'
         WHERE owner_user_id = $1 AND resource_type = 'character'`,
        [friendId],
      );
      const friendItem = (await adminPool.query(
        `INSERT INTO ${quote("character_items")} (name, slot, emoji, coin_cost, level_required)
         VALUES ('Friend Hoodie','outfit','🧥',30,3) RETURNING id`,
      )).rows[0];
      await adminPool.query(
        `INSERT INTO ${quote("user_character_items")} (user_id, item_id, equipped) VALUES ($1,$2,true)`,
        [friendId, friendItem.id],
      );
      const sharedCharacter = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.ok(sharedCharacter.friends[0].character.length > 0);
      assert.equal(sharedCharacter.friends[0].journey.title, "Walk");
      await adminPool.query(
        `UPDATE ${quote("social_shares")} SET visibility = 'private'
         WHERE owner_user_id = $1 AND resource_type = 'journey'`,
        [friendId],
      );
      const revokedJourney = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(revokedJourney.friends[0].journey, null);
      assert.ok(revokedJourney.friends[0].character.length > 0, "journey revocation does not revoke separately shared character");
      await adminPool.query(
        `INSERT INTO ${quote("social_blocks")} (blocker_user_id, blocked_user_id) VALUES ($1,$2)`,
        [friendId, ownerId],
      );
      const blocked = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.deepEqual(blocked.friends, []);
    } finally {
      service.geminiProvider.generateText = originalGenerateText;
      await api.close();
    }
  });

  await t.test("active and paused tracking, deterministic multiple focus, snapshot types, and virtual revision-zero start/finish", async () => {
    await reset();
    const ownerId = await seedDashboardUser({ id: "dashboard-focus-owner" });
    const ids = [];
    for (let index = 0; index < 6; index++) ids.push(await seedHabit({ userId: ownerId }));
    await seedDashboardExecution(ids[0], dailyToday, { status: "completed" });
    await seedDashboardExecution(ids[1], dailyToday, { status: "pending", executionType: "count", unit: "count" });
    await seedDashboardExecution(ids[2], dailyToday, { status: "paused", executionType: "boolean", unit: "custom", goalType: "quit" });
    await seedDashboardExecution(ids[3], dailyToday, {
      status: "in_progress", lastResumedAt: new Date(Date.now() - 30_000),
      startedAt: new Date(Date.now() - 60_000), executionType: "duration",
    });
    await seedDashboardExecution(ids[4], dailyToday, { status: "minimum_reached", executionType: "limit", unit: "count", goalType: "quit" });
    await seedDashboardExecution(ids[5], dailyToday, {
      status: "target_reached", targetValue: 0.5, minimumValue: 0.25, actualValue: 0.5,
    });
    const api = await startJourneyApi(ownerId);
    try {
      const active = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(active.state, "habit_in_progress", JSON.stringify(active));
      assert.equal(active.focus.habit.id, ids[3]);
      assert.equal(active.focus.execution.actualValue, null, "elapsed timer time is not recorded activity");
      assert.ok(active.focus.execution.elapsedSeconds > 0);
      assert.equal(active.otherHabits.length, 5);
      assert.deepEqual(active.otherHabits.map(({ habit }) => habit.id), [ids[2], ids[1], ids[4], ids[0], ids[5]]);
      assert.equal(active.otherHabits[0].execution.executionType, "boolean");
      assert.equal(active.otherHabits[1].execution.status, "pending");
      assert.equal(active.otherHabits[2].execution.status, "minimum_reached");
      assert.equal(active.otherHabits[2].execution.executionType, "limit");
      assert.equal(active.otherHabits[2].execution.goalType, "quit");
      assert.equal(active.otherHabits[4].execution.status, "target_reached");
      assert.equal(active.otherHabits[4].execution.targetValue, 0.5);
      assert.equal(active.otherHabits[4].execution.actualValue, 0.5);

      await reset();
      const adaptedOwner = await seedDashboardUser({ id: "dashboard-adapted-snapshot-owner" });
      const adaptedHabit = await seedHabit({ userId: adaptedOwner });
      await seedDailyJourney(adaptedHabit, dailyToday, {
        targetValue: 0.5, minimumValue: 0.25, unit: "minutes", executionType: "duration",
      });
      await applyFuturePlanRevision(adaptedHabit, 17);
      const adaptedApi = await startJourneyApi(adaptedOwner);
      try {
        const adapted = await assertDashboardReadOnly(() => currentDashboardResponse(adaptedApi));
        assert.equal(adapted.focus.execution.planRevision, 1);
        assert.equal(adapted.focus.execution.targetValue, 0.5);
        assert.equal(adapted.focus.execution.minimumValue, 0.25);
        const future = await adminPool.query(
          `SELECT plan_revision, target_value, minimum_value FROM ${quote("habit_days")}
           WHERE habit_id = $1 AND date = $2`,
          [adaptedHabit, addDays(dailyToday, 1)],
        );
        assert.deepEqual(future.rows[0], { plan_revision: 2, target_value: 17, minimum_value: 5 });
      } finally {
        await adaptedApi.close();
      }

      await reset();
      const freshOwner = await seedDashboardUser({ id: "dashboard-virtual-owner" });
      const virtualHabit = await seedHabit({ userId: freshOwner });
      await seedDailyJourney(virtualHabit, dailyToday, {
        targetValue: 0.0001, minimumValue: 0.0001, unit: "minutes", executionType: "duration",
      });
      const virtualApi = await startJourneyApi(freshOwner);
      try {
        const virtual = await assertDashboardReadOnly(() => currentDashboardResponse(virtualApi));
        assert.equal(virtual.focus.execution.revision, 0);
        assert.equal(virtual.focus.execution.planRevision, 1);
        assert.equal(virtual.focus.execution.status, "pending");
        const started = await virtualApi.request(`/habits/${virtualHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "start", expectedRevision: 0,
        });
        assert.equal(started.status, 200, await started.clone().text());
        const startedBody = await started.json();
        assert.equal(startedBody.execution.revision, 1);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const finished = await virtualApi.request(`/habits/${virtualHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "finish", expectedRevision: 1,
        });
        assert.equal(finished.status, 200, await finished.clone().text());
        assert.equal((await finished.json()).execution.status, "target_reached");
        const row = await adminPool.query(
          `SELECT revision, status FROM ${quote("habit_daily_executions")} WHERE habit_id = $1 AND date = $2`,
          [virtualHabit, dailyToday],
        );
        assert.deepEqual(row.rows[0], { revision: 2, status: "target_reached" });
      } finally {
        await virtualApi.close();
      }

      await reset();
      const countOwner = await seedDashboardUser({ id: "dashboard-paid-count-owner", coins: 40 });
      const countHabit = await seedHabit({ userId: countOwner });
      await seedDailyJourney(countHabit, dailyToday, {
        targetValue: 10, minimumValue: 5, unit: "count", executionType: "count",
      });
      const countApi = await startJourneyApi(countOwner);
      try {
        const initial = await assertDashboardReadOnly(() => currentDashboardResponse(countApi));
        let revision = initial.focus.execution.revision;
        const paid = await countApi.request(`/habits/${countHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "done", value: 5, expectedRevision: revision,
        });
        assert.equal(paid.status, 200, await paid.clone().text());
        let result = await paid.json();
        assert.equal(result.execution.status, "pending_reflection");
        assert.equal(result.execution.actualValue, 5);
        assert.ok(result.rewardDelta.coins > 0);
        assert.ok(result.rewardDelta.xp > 0);
        const initialReward = result.rewardDelta;
        revision = result.execution.revision;
        for (let value = 6; value <= 10; value++) {
          const updated = await countApi.request(`/habits/${countHabit}/daily/actions`, "POST", {
            date: dailyToday, action: "update_progress", value, expectedRevision: revision,
          });
          assert.equal(updated.status, 200, `count update ${value}: ${await updated.clone().text()}`);
          result = await updated.json();
          assert.equal(result.execution.status, "pending_reflection");
          assert.equal(result.execution.actualValue, value);
          assert.deepEqual(result.rewardDelta, { xp: 0, coins: 0 });
          revision = result.execution.revision;
        }
        const [checkin] = (await adminPool.query(
          `SELECT completed, value, coins_earned, xp_earned, reward_granted, note
           FROM ${quote("checkins")} WHERE habit_id = $1 AND date = $2`,
          [countHabit, dailyToday],
        )).rows;
        assert.deepEqual(checkin, {
          completed: true,
          value: 10,
          coins_earned: initialReward.coins,
          xp_earned: initialReward.xp,
          reward_granted: true,
          note: null,
        });
        assert.equal((await adminPool.query(
          `SELECT coins FROM ${quote("users")} WHERE id = $1`, [countOwner],
        )).rows[0].coins, 40 + initialReward.coins);
        assert.equal((await adminPool.query(
          `SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id = $1`,
          [countOwner],
        )).rows[0].count, 1);
      } finally {
        await countApi.close();
      }

      await reset();
      const durationOwner = await seedDashboardUser({ id: "dashboard-paid-duration-owner", coins: 40 });
      const durationHabit = await seedHabit({ userId: durationOwner });
      await seedDailyJourney(durationHabit, dailyToday, {
        targetValue: 10, minimumValue: 5, unit: "minutes", executionType: "duration",
      });
      const durationApi = await startJourneyApi(durationOwner);
      try {
        const initial = await assertDashboardReadOnly(() => currentDashboardResponse(durationApi));
        const paid = await durationApi.request(`/habits/${durationHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "done", value: 300, expectedRevision: initial.focus.execution.revision,
        });
        assert.equal(paid.status, 200, await paid.clone().text());
        const paidState = await paid.json();
        assert.equal(paidState.execution.status, "pending_reflection");
        assert.equal(paidState.execution.actualValue, 5);
        assert.ok(paidState.rewardDelta.coins > 0);
        const initialReward = paidState.rewardDelta;
        const started = await durationApi.request(`/habits/${durationHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "start", expectedRevision: paidState.execution.revision,
        });
        assert.equal(started.status, 200, await started.clone().text());
        const startedState = await started.json();
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const finished = await durationApi.request(`/habits/${durationHabit}/daily/actions`, "POST", {
          date: dailyToday, action: "finish", expectedRevision: startedState.execution.revision,
        });
        assert.equal(finished.status, 200, await finished.clone().text());
        const finishedState = await finished.json();
        assert.equal(finishedState.execution.status, "minimum_reached");
        assert.ok(finishedState.execution.actualValue >= 5);
        assert.ok(finishedState.execution.actualValue < 10);
        assert.deepEqual(finishedState.rewardDelta, { xp: 0, coins: 0 });
        const [checkin] = (await adminPool.query(
          `SELECT value, coins_earned, xp_earned, reward_granted FROM ${quote("checkins")}
           WHERE habit_id = $1 AND date = $2`,
          [durationHabit, dailyToday],
        )).rows;
        assert.equal(checkin.value, finishedState.execution.actualValue);
        assert.deepEqual(
          { coins: checkin.coins_earned, xp: checkin.xp_earned, rewardGranted: checkin.reward_granted },
          { coins: initialReward.coins, xp: initialReward.xp, rewardGranted: true },
        );
        assert.equal((await adminPool.query(
          `SELECT coins FROM ${quote("users")} WHERE id = $1`, [durationOwner],
        )).rows[0].coins, 40 + initialReward.coins);
        assert.equal((await adminPool.query(
          `SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id = $1`,
          [durationOwner],
        )).rows[0].count, 1);
      } finally {
        await durationApi.close();
      }
    } finally {
      await api.close();
    }
  });

  await t.test("missed-day reflection/adaptation API, valid 22nd success, expiration, rest, and persisted reward are read-only on GET", async () => {
    await reset();
    const ownerId = await seedDashboardUser({ id: "dashboard-lifecycle-owner", coins: 50 });
    const adaptationHabit = await seedHabit({ userId: ownerId });
    const adaptationStart = addDays(dailyToday, -3);
    await seedDailyJourney(adaptationHabit, adaptationStart);
    const missedDate = addDays(dailyToday, -1);
    await seedDashboardExecution(adaptationHabit, missedDate, { status: "missed", missedReason: "no_time" });
    const api = await startJourneyApi(ownerId);
    try {
      let home = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(home.missedDay.execution.missedReason, "no_time");
      assert.equal(home.missedDay.execution.adaptationDecision, null);
      assert.equal(home.state, "adaptation_required");
      const reflection = await api.request(
        `/habits/${adaptationHabit}/daily/${missedDate}/reflection`, "PATCH",
        { missedReason: "no_time", note: "Schedule was unexpectedly full." },
      );
      assert.equal(reflection.status, 200, await reflection.clone().text());
      const decision = await api.request(
        `/habits/${adaptationHabit}/daily/${missedDate}/adaptation-decision`, "POST",
        { decision: "rejected" },
      );
      assert.equal(decision.status, 200, await decision.clone().text());
      const changedMiss = await adminPool.query(
        `SELECT missed_reason, adaptation_decision FROM ${quote("habit_daily_executions")}
         WHERE habit_id = $1 AND date = $2`,
        [adaptationHabit, missedDate],
      );
      assert.deepEqual(changedMiss.rows[0], { missed_reason: "no_time", adaptation_decision: "rejected" });

      await reset();
      const completionOwner = await seedDashboardUser({ id: "dashboard-completion-owner", coins: 19 });
      const completedHabit = await seedHabit({ userId: completionOwner });
      const completionStart = addDays(dailyToday, -21);
      await seedDailyJourney(completedHabit, completionStart);
      for (let dayNumber = 1; dayNumber <= 22; dayNumber++) {
        if (dayNumber === 5) continue;
        const date = addDays(completionStart, dayNumber - 1);
        await adminPool.query(
          `INSERT INTO ${quote("checkins")} (
             habit_id, user_id, date, completed, value, target_completed, coins_earned, xp_earned
           ) VALUES ($1,$2,$3,true,10,true,0,5)`,
          [completedHabit, completionOwner, date],
        );
      }
      const legacyFocusHabit = await seedHabit({ userId: completionOwner });
      await adminPool.query(
        `UPDATE ${quote("habits")} SET created_at = created_at - interval '7 days' WHERE id = $1`,
        [legacyFocusHabit],
      );
      await seedDashboardExecution(legacyFocusHabit, addDays(dailyToday, -1), { status: "missed" });
      const activeJourneyHabit = await seedHabit({ userId: completionOwner });
      await seedDailyJourney(activeJourneyHabit, addDays(dailyToday, -3));
      for (let offset = 1; offset <= 3; offset++) {
        await adminPool.query(
          `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, value)
           VALUES ($1,$2,$3,true,10)`,
          [activeJourneyHabit, completionOwner, addDays(dailyToday, -offset)],
        );
      }
      await adminPool.query(
        `INSERT INTO ${quote("journey_rewards")} (user_id, habit_id, title, type, status)
         VALUES ($1,$2,'Persisted reward','experience','pending')`,
        [completionOwner, completedHabit],
      );
      await adminPool.query(
        `INSERT INTO ${quote("journey_rewards")} (user_id, habit_id, title, type, status)
         VALUES ($1,$2,'Active context reward','experience','pending')`,
        [completionOwner, activeJourneyHabit],
      );
      await adminPool.query(
        `UPDATE ${quote("habits")} SET is_active = false WHERE id = $1`,
        [completedHabit],
      );
      const foreignOwner = await seedDashboardUser({ id: "dashboard-foreign-reward-owner" });
      const foreignHabit = await seedHabit({ userId: foreignOwner });
      await seedDailyJourney(foreignHabit, addDays(dailyToday, -21));
      await adminPool.query(
        `INSERT INTO ${quote("journey_rewards")} (user_id, habit_id, title, type, status)
         VALUES ($1,$2,'foreign-secret-reward','experience','claimed')`,
        [foreignOwner, foreignHabit],
      );
      const completionApi = await startJourneyApi(completionOwner);
      try {
        await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
        const persistedRewards = await adminPool.query(`SELECT * FROM ${quote("journey_rewards")} ORDER BY id`);
        await adminPool.query(
          `ALTER TABLE ${quote("journey_rewards")} RENAME TO "journey_rewards_dashboard_completion_failure"`,
        );
        try {
          const response = await completionApi.request("/dashboard");
          assert.equal(response.status, 200, await response.clone().text());
          const rewardUnavailable = service.GetDashboardHomeResponse.parse(await response.json());
          assert.equal(rewardUnavailable.sectionStatus.reward, "unavailable");
          assert.equal(rewardUnavailable.completion?.journey.habitId, completedHabit,
            `${JSON.stringify(rewardUnavailable)} errors=${JSON.stringify(completionApi.requestErrors)}`);
          assert.equal(rewardUnavailable.completion.reward, null);
          assert.equal(rewardUnavailable.journey.habitId, activeJourneyHabit);
          assert.deepEqual((await adminPool.query(`SELECT * FROM ${quote("dashboard_write_audit")}`)).rows, []);
          assert.deepEqual(
            (await adminPool.query(
              `SELECT * FROM ${quote("journey_rewards_dashboard_completion_failure")} ORDER BY id`,
            )).rows,
            persistedRewards.rows,
          );
        } finally {
          await adminPool.query(
            `ALTER TABLE ${quote("journey_rewards_dashboard_completion_failure")} RENAME TO "journey_rewards"`,
          );
        }
        const completion = await assertDashboardReadOnly(() => currentDashboardResponse(completionApi));
        assert.equal(completion.focus.habit.id, legacyFocusHabit, "the different current action remains the primary focus");
        assert.equal(completion.journey.status, "active", "the separate current active journey remains the main journey context");
        assert.equal(completion.journey.habitId, activeJourneyHabit);
        assert.equal(completion.reward.title, "Active context reward");
        assert.equal(completion.completion.journey.status, "completed");
        assert.equal(completion.completion.journey.habitId, completedHabit);
        assert.equal(completion.completion.journey.currentDay, 22);
        assert.equal(completion.completion.reward.currentDay, 22);
        assert.equal(completion.completion.reward.daysRemaining, 0);
        assert.equal(completion.completion.reward.title, "Persisted reward", "completion reward belongs to the completed habit, not the active context");
        assert.equal(completion.state, "missed_day", "the completion celebration does not hide the current action or earlier reflection");
        assert.equal(String(completion.missedDay.execution.date).slice(0, 10), addDays(dailyToday, -1));
        assert.equal(completion.completion.reward.status, "pending", "GET does not unlock persisted rewards");
        assert.equal(JSON.stringify(completion).includes("foreign-secret-reward"), false);
        const reward = await adminPool.query(
          `SELECT status FROM ${quote("journey_rewards")} WHERE user_id = $1 AND habit_id = $2`,
          [completionOwner, completedHabit],
        );
        assert.equal(reward.rows[0].status, "pending");
        const wallet = await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id = $1`, [completionOwner]);
        assert.equal(wallet.rows[0].coins, 19);
      } finally {
        await completionApi.close();
      }

      await reset();
      const expiredOwner = await seedDashboardUser({ id: "dashboard-expired-owner" });
      const expiredHabit = await seedHabit({ userId: expiredOwner });
      const expiredStart = addDays(dailyToday, -22);
      await seedDailyJourney(expiredHabit, expiredStart);
      for (let dayNumber = 1; dayNumber <= 21; dayNumber++) {
        await adminPool.query(
          `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, value)
           VALUES ($1,$2,$3,true,10)`,
          [expiredHabit, expiredOwner, addDays(expiredStart, dayNumber - 1)],
        );
      }
      const oldCompletedHabit = await seedHabit({ userId: expiredOwner });
      const oldCompletedStart = addDays(dailyToday, -45);
      await seedDailyJourney(oldCompletedHabit, oldCompletedStart);
      for (let dayNumber = 1; dayNumber <= 22; dayNumber++) {
        await adminPool.query(
          `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, value)
           VALUES ($1,$2,$3,true,10)`,
          [oldCompletedHabit, expiredOwner, addDays(oldCompletedStart, dayNumber - 1)],
        );
      }
      const renewedHabit = await seedHabit({ userId: expiredOwner });
      await seedDailyJourney(renewedHabit, addDays(dailyToday, -2));
      const expiredApi = await startJourneyApi(expiredOwner);
      try {
        const expired = await assertDashboardReadOnly(() => currentDashboardResponse(expiredApi));
        assert.equal(expired.journey.status, "active", "an expired older journey does not replace the active current journey");
        assert.equal(expired.journey.habitId, renewedHabit);
        assert.equal(expired.completion, null);
        assert.equal(expired.state, "missed_day");
        assert.equal(expired.missedDay.habit.id, expiredHabit, "the old expired journey remains available as its own unresolved missed day");
        assert.equal(expired.journey.successfulDays, 0);
      } finally {
        await expiredApi.close();
      }

      await reset();
      const restOwner = await seedDashboardUser({ id: "dashboard-final-rest-owner" });
      const restHabit = await seedHabit({ userId: restOwner });
      let finalRestDate = addDays(dailyToday, -1);
      while (new Date(`${finalRestDate}T00:00:00Z`).getUTCDay() !== 6) {
        finalRestDate = addDays(finalRestDate, -1);
      }
      const restStart = addDays(finalRestDate, -21);
      await seedDailyJourney(restHabit, restStart, { cadence: "weekdays" });
      const scheduledDays = await adminPool.query(
        `SELECT date FROM ${quote("habit_days")} WHERE habit_id = $1 AND scheduled = true ORDER BY date`,
        [restHabit],
      );
      for (const { date } of scheduledDays.rows) {
        await adminPool.query(
          `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, value)
           VALUES ($1,$2,$3,true,10)`,
          [restHabit, restOwner, date],
        );
      }
      const restApi = await startJourneyApi(restOwner);
      try {
        const finalRest = await assertDashboardReadOnly(() => currentDashboardResponse(restApi));
        assert.equal(finalRest.journey.status, "completed");
        assert.equal(finalRest.journey.currentDay, 22);
        assert.equal(finalRest.completion.journey.habitId, restHabit);
        assert.equal(finalRest.completion.journey.currentDay, 22);
        assert.equal(finalRest.focus, null, "day 22 is a saved rest day with no action");
        assert.equal(finalRest.state, "journey_complete");
      } finally {
        await restApi.close();
      }
    } finally {
      await api.close();
    }
  });

  await t.test("read-only expired-timer virtual revision remains compatible with real reflection materialization", async () => {
    await reset();
    const ownerId = await seedDashboardUser({ id: "dashboard-expired-timer-owner" });
    const habit = await seedHabit({ userId: ownerId });
    const yesterday = addDays(dailyToday, -1);
    await seedDailyJourney(habit, yesterday);
    const resumedAt = new Date(`${yesterday}T12:00:00.000Z`);
    await seedDashboardExecution(habit, yesterday, {
      status: "in_progress", planRevision: 1, revision: 7,
      executionType: "duration", startedAt: resumedAt, lastResumedAt: resumedAt,
    });
    const api = await startJourneyApi(ownerId);
    try {
      const home = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(home.missedDay.execution.status, "missed");
      assert.equal(home.missedDay.execution.revision, 7);
      assert.equal(new Date(home.missedDay.execution.lastResumedAt).toISOString(), resumedAt.toISOString());
      assert.equal(home.missedDay.execution.actualSeconds, null);
      const persistedBefore = await adminPool.query(
        `SELECT status, revision, last_resumed_at, actual_seconds FROM ${quote("habit_daily_executions")}
         WHERE habit_id = $1 AND date = $2`,
        [habit, yesterday],
      );
      assert.equal(persistedBefore.rows[0].status, "in_progress");
      assert.equal(persistedBefore.rows[0].revision, 7);
      const materialized = await api.request(`/habits/${habit}/daily/${yesterday}`);
      assert.equal(materialized.status, 200, await materialized.clone().text());
      const materializedState = await materialized.json();
      assert.equal(materializedState.revision, home.missedDay.execution.revision);
      assert.equal(materializedState.status, "missed");
      const persistedMaterialized = await adminPool.query(
        `SELECT revision, status, last_resumed_at FROM ${quote("habit_daily_executions")}
         WHERE habit_id = $1 AND date = $2`,
        [habit, yesterday],
      );
      assert.equal(persistedMaterialized.rows[0].revision, 7);
      assert.equal(persistedMaterialized.rows[0].status, "missed");
      assert.equal(persistedMaterialized.rows[0].last_resumed_at, null);
      const reflection = await api.request(
        `/habits/${habit}/daily/${yesterday}/reflection`, "PATCH",
        { missedReason: "forgot", note: "A historical timer expired locally." },
      );
      assert.equal(reflection.status, 200, await reflection.clone().text());
      const persistedAfter = await adminPool.query(
        `SELECT status, revision, last_resumed_at, actual_seconds FROM ${quote("habit_daily_executions")}
         WHERE habit_id = $1 AND date = $2`,
        [habit, yesterday],
      );
      assert.equal(persistedAfter.rows[0].status, "missed");
      assert.equal(persistedAfter.rows[0].revision, 8, "only the reflection mutation increments the revision after virtual expiry");
      assert.equal(persistedAfter.rows[0].last_resumed_at, null);
      assert.ok(persistedAfter.rows[0].actual_seconds > 0);
    } finally {
      await api.close();
    }
  });

  await t.test("every independently-read section contains SQL failure; profile failure is a generic 500", async () => {
    const cases = [
      { section: "habits", table: "habit_days", expected: 200 },
      { section: "character", table: "character_items", expected: 200 },
      { section: "character", table: "user_character_items", expected: 200 },
      { section: "time", table: "time_entries", expected: 200 },
      { section: "time", table: "tracking_sessions", expected: 200 },
      { section: "coach", table: "day_analysis_cache", expected: 200 },
      { section: "social", table: "social_friendships", expected: 200 },
      { section: "social", table: "social_blocks", expected: 200 },
      { section: "social", table: "social_shares", expected: 200 },
      { section: "social", table: "social_share_recipients", expected: 200 },
      { section: "social", table: "user_character_items", expected: 200 },
      { section: "social", table: "character_items", expected: 200 },
      { section: "memory", table: "memories", expected: 200 },
      { section: "reward", table: "journey_rewards", expected: 200 },
    ];
    await reset();
    const ownerId = await seedDashboardUser({ id: "dashboard-failure-owner" });
    const habit = await seedHabit({ userId: ownerId });
    await seedDailyJourney(habit, dailyToday);
    const friendId = await seedDashboardUser({ id: "dashboard-failure-friend" });
    const [userLowId, userHighId] = [ownerId, friendId].sort();
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id) VALUES ($1,$2)`,
      [userLowId, userHighId],
    );
    const friendHabit = await seedHabit({ userId: friendId });
    await seedDailyJourney(friendHabit, dailyToday);
    const [friendItem] = (await adminPool.query(
      `INSERT INTO ${quote("character_items")} (name, slot, emoji, coin_cost)
       VALUES ('failure-projection-item','hat','🎩',0) RETURNING id`,
    )).rows;
    await adminPool.query(
      `INSERT INTO ${quote("user_character_items")} (user_id, item_id, equipped) VALUES ($1,$2,true)`,
      [friendId, friendItem.id],
    );
    const [journeyShare] = (await adminPool.query(
      `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
       VALUES ($1,'journey',$2,'selected') RETURNING id`,
      [friendId, String(friendHabit)],
    )).rows;
    await adminPool.query(
      `INSERT INTO ${quote("social_share_recipients")} (share_id, recipient_user_id) VALUES ($1,$2)`,
      [journeyShare.id, ownerId],
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
       VALUES ($1,'character','profile','friends')`,
      [friendId],
    );
    const api = await startJourneyApi(ownerId);
    try {
      const baseline = await assertDashboardReadOnly(() => currentDashboardResponse(api));
      assert.equal(baseline.friends.length, 1);
      assert.ok(baseline.friends[0].journey);
      assert.ok(baseline.friends[0].character.length);
      for (const { section, table } of cases) {
        await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
        const hiddenName = `${table}_dashboard_failure`;
        await adminPool.query(`ALTER TABLE ${quote(table)} RENAME TO "${hiddenName}"`);
        try {
          const response = await api.request("/dashboard");
          assert.equal(response.status, 200, `${section} failure should not fail dashboard: ${await response.clone().text()}`);
          const body = service.GetDashboardHomeResponse.parse(await response.json());
          assert.equal(body.sectionStatus[section], "unavailable", `${section} must expose its partial failure`);
          assert.ok(body.profile, `${section} failure retains owner profile`);
          if (!["habits", "reward"].includes(section)) {
            assert.ok(body.focus, `${section} failure retains independently-loaded habit actions`);
          }
          if (section === "memory") {
            assert.equal(body.sectionStatus.habits, "ready");
            assert.equal(body.focus.execution.memoryId, null);
          }
          if (section === "habits") {
            assert.equal(body.state, "unavailable");
            assert.equal(body.sectionStatus.journey, "unavailable", "shared saved-plan SQL failure is isolated but accurately marked");
          }
          assert.deepEqual((await adminPool.query(`SELECT * FROM ${quote("dashboard_write_audit")}`)).rows, []);
        } finally {
          await adminPool.query(`ALTER TABLE ${quote(hiddenName)} RENAME TO "${table}"`);
        }
      }

      await adminPool.query(`TRUNCATE ${quote("dashboard_write_audit")}`);
      await adminPool.query(`ALTER TABLE ${quote("checkins")} RENAME TO "checkins_dashboard_failure"`);
      try {
        const response = await api.request("/dashboard");
        assert.equal(response.status, 200);
        const body = service.GetDashboardHomeResponse.parse(await response.json());
        assert.equal(body.sectionStatus.habits, "unavailable");
        assert.equal(body.sectionStatus.journey, "unavailable");
        assert.equal(body.sectionStatus.time, "empty");
        assert.equal(body.profile.id, ownerId);
        assert.deepEqual((await adminPool.query(`SELECT * FROM ${quote("dashboard_write_audit")}`)).rows, []);
      } finally {
        await adminPool.query(`ALTER TABLE "${schema}"."checkins_dashboard_failure" RENAME TO "checkins"`);
      }

      await adminPool.query(`ALTER TABLE ${quote("users")} RENAME TO "users_dashboard_failure"`);
      try {
        const response = await api.request("/dashboard");
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "Dashboard unavailable" });
      } finally {
        await adminPool.query(`ALTER TABLE "${schema}"."users_dashboard_failure" RENAME TO "users"`);
      }
    } finally {
      await api.close();
    }
  });
});