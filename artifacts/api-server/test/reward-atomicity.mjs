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
     ${quote("checkins")}, ${quote("habits")},
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
  value = 10,
}) {
  return adminPool.query(
    `INSERT INTO ${quote("checkins")} (
       habit_id, user_id, date, completed, value, target_snapshot,
       minimum_snapshot, target_completed, reward_granted, coins_earned
     ) VALUES ($1, $2, $3, $4, $5, 10, 3, $4, $6, $7)
     RETURNING id`,
    [habitId, userId, date, completed, value, rewardGranted, coinsEarned],
  ).then((result) => result.rows[0].id);
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
    const date = "2026-06-01";
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

test("journey check-ins reject dates outside bounds and rest days without effects; Monday continues a weekday streak", async () => {
  await reset();
  const userId = await seedUser();
  const habitId = await seedHabit({ userId, cadence: "weekdays" });
  await adminPool.query(
    `UPDATE ${quote("habits")}
     SET journey_start_date = '2026-06-05', journey_length = 22
     WHERE id = $1`,
    [habitId],
  );
  await adminPool.query(
    `INSERT INTO ${quote("habit_days")}
       (habit_id, day_number, date, scheduled, target_value, minimum_value, goal_type, plan_revision)
     VALUES
       ($1, 1, '2026-06-05', true, 10, 3, 'build', 1),
       ($1, 2, '2026-06-06', false, 10, 3, 'build', 1),
       ($1, 3, '2026-06-07', false, 10, 3, 'build', 1),
       ($1, 4, '2026-06-08', true, 10, 3, 'build', 1)`,
    [habitId],
  );

  const untouched = await snapshot(userId, habitId);
  await assert.rejects(service.recordCheckin(userId, habitId, input("2026-06-04")), /outside the habit's 22-day journey/);
  await assert.rejects(service.recordCheckin(userId, habitId, input("2026-06-27")), /outside the habit's 22-day journey/);
  assert.deepEqual(await snapshot(userId, habitId), untouched);

  const friday = await service.recordCheckin(userId, habitId, input("2026-06-05"));
  assert.equal(friday.newStreak, 1);
  const afterFriday = await snapshot(userId, habitId);
  await assert.rejects(service.recordCheckin(userId, habitId, input("2026-06-06")), /rest day/);
  assert.deepEqual(await snapshot(userId, habitId), afterFriday);
  await assert.rejects(service.recordCheckin(userId, habitId, input("2026-06-07")), /rest day/);
  assert.deepEqual(await snapshot(userId, habitId), afterFriday);

  const monday = await service.recordCheckin(userId, habitId, input("2026-06-08"));
  assert.equal(monday.newStreak, 2);
  const [habit] = await rows("habits");
  assert.equal(habit.current_streak, 2);
  assert.equal(habit.last_checkin_date.toISOString?.().slice(0, 10) ?? String(habit.last_checkin_date).slice(0, 10), "2026-06-08");
  assert.equal((await rows("coin_transactions")).filter((entry) => entry.reason === "checkin").length, 2);
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
    const result = await service.recordCheckin(userId, habitId, {
      date: new Date(`${date}T00:00:00.000Z`),
      completed: true,
      value: 6,
    });
    assert.equal(result.completed, true);
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