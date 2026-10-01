import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";

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
  `CREATE TABLE ${quote("users")} (
    id text PRIMARY KEY,
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
      export { default as dailyRouter } from ${JSON.stringify(join(apiDir, "src/routes/daily.ts"))};
      export {
        getDailyHabitState, changeDailyHabitExecution, saveDailyHabitReflection,
        recordDailyAdaptationDecision, getDailyOverview,
      } from ${JSON.stringify(join(apiDir, "src/lib/dailyExecutionService.ts"))};
      export { db, pool } from "@workspace/db";
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
     ${quote("habit_plan_revisions")}, ${quote("habit_days")},
      ${quote("checkins")}, ${quote("rewards")}, ${quote("habits")},
     ${quote("users")} RESTART IDENTITY CASCADE`,
  );
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

const dailyNow = new Date();
dailyNow.setUTCHours(12, 0, 0, 0);
const dailyToday = dailyNow.toISOString().slice(0, 10);

async function startJourneyApi(userId) {
  const app = express();
  app.use(express.json());
  app.use(service.habitsRouter, service.rewardsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    request: (path, method = "GET", body) => fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
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