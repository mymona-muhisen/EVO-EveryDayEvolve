import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { build } from "esbuild";
import express from "express";
import sharp from "sharp";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryDir = resolve(apiDir, "../..");
const dbDir = resolve(repositoryDir, "lib/db");
// Never use the application's DATABASE_URL here: this test must only run
// against an explicitly configured disposable/test database.
const databaseUrl = process.env.API_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test("social circles HTTP lifecycle (isolated PostgreSQL schema)", {
    skip: "No API_TEST_DATABASE_URL or TEST_DATABASE_URL configured; no application database was touched",
  }, () => {});
} else {
  const schema = `api_social_circles_it_${randomUUID().replaceAll("-", "")}`;
  const quote = (name) => `"${schema}"."${name}"`;
  const scopedUrl = new URL(databaseUrl);
  const currentOptions = scopedUrl.searchParams.get("options");
  scopedUrl.searchParams.set(
    "options",
    [currentOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
  );
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.PRIVATE_OBJECT_DIR = "test-bucket/private";

  const dbRequire = createRequire(join(dbDir, "package.json"));
  const apiRequire = createRequire(join(apiDir, "package.json"));
  const { Pool } = dbRequire("pg");
  const { eq, inArray, sql } = apiRequire("drizzle-orm");
  const pgEntry = dbRequire.resolve("pg");
  const adminPool = new Pool({ connectionString: databaseUrl });
  const servicePools = [];
  let tempDir;
  let server;
  let app;
  let fakeStorage;
  let httpBase;
  let fixture;
  let testApi;

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
    `CREATE TYPE ${quote("coin_transaction_reason")} AS ENUM ('checkin', 'streak_bonus', 'streak_recovery', 'reward_redemption', 'item_purchase', 'challenge_bonus', 'manual')`,
    `CREATE TYPE ${quote("journey_reward_type")} AS ENUM ('physical', 'experience')`,
    `CREATE TYPE ${quote("journey_reward_status")} AS ENUM ('pending', 'unlocked', 'claimed')`,
    `CREATE TYPE ${quote("character_item_slot")} AS ENUM ('outfit', 'hat', 'accessory', 'pet', 'background')`,
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
    `CREATE TABLE ${quote("groups")} (
      id serial PRIMARY KEY,
      name text NOT NULL,
      invite_code text NOT NULL UNIQUE,
      goal_description text NOT NULL,
      start_date date NOT NULL,
      end_date date,
      created_by text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("group_members")} (
      id serial PRIMARY KEY,
      group_id integer NOT NULL REFERENCES ${quote("groups")}(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT group_members_group_user_unique UNIQUE (group_id, user_id)
    )`,
    `CREATE TABLE ${quote("group_reactions")} (
      id serial PRIMARY KEY,
      group_id integer NOT NULL REFERENCES ${quote("groups")}(id) ON DELETE CASCADE,
      from_user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      to_user_id text REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      emoji text NOT NULL,
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
    `CREATE TABLE ${quote("habit_days")} (
      id serial PRIMARY KEY,
      habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
      day_number integer NOT NULL,
      date date NOT NULL,
      scheduled boolean NOT NULL DEFAULT true,
      title text,
      target_value double precision NOT NULL,
      minimum_value double precision NOT NULL,
      busy_day_value double precision,
      success_limit_value double precision,
      goal_type ${quote("habit_goal_type")} NOT NULL,
      unit ${quote("habit_unit")},
      execution_type ${quote("habit_execution_type")},
      cue_type ${quote("habit_cue_type")},
      cue_time text,
      cue text,
      start_action text,
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
    `CREATE TABLE ${quote("checkins")} (
      id serial PRIMARY KEY,
      habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      date date NOT NULL,
      completed boolean NOT NULL,
      note text,
      coins_earned integer NOT NULL DEFAULT 0,
      xp_earned integer,
      CONSTRAINT checkins_habit_date_unique UNIQUE (habit_id, date)
    )`,
    `CREATE TABLE ${quote("coin_transactions")} (
      id serial PRIMARY KEY,
      user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      amount integer NOT NULL,
      reason ${quote("coin_transaction_reason")} NOT NULL,
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
    `CREATE TABLE ${quote("object_uploads")} (
      object_path text PRIMARY KEY,
      user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      unreferenced_since timestamptz,
      last_cleanup_attempt_at timestamptz
    )`,
    `CREATE TABLE ${quote("character_items")} (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      slot ${quote("character_item_slot")} NOT NULL,
      emoji text NOT NULL,
      coin_cost integer NOT NULL,
      level_required integer NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE ${quote("user_character_items")} (
      id serial PRIMARY KEY,
      user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      item_id integer NOT NULL REFERENCES ${quote("character_items")}(id) ON DELETE CASCADE,
      equipped boolean NOT NULL DEFAULT false,
      purchased_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_character_items_user_item_unique UNIQUE (user_id, item_id)
    )`,
  ];

  async function request(userId, method, path, body) {
    const response = await fetch(`${httpBase}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        "x-test-user": userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, headers: response.headers, data };
  }

  async function withDeadline(promise, milliseconds = 10_000) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms`)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForLockWait(pid) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await adminPool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (result.rows[0]?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`PostgreSQL backend ${pid} did not reach the expected lock wait`);
  }

  function addDays(date, count) {
    const result = new Date(`${date}T00:00:00.000Z`);
    result.setUTCDate(result.getUTCDate() + count);
    return result.toISOString().slice(0, 10);
  }

  async function seedHabit(userId, values) {
    const result = await adminPool.query(
      `INSERT INTO ${quote("habits")} (
         user_id, title, emoji, category, cadence, custom_days, unit, execution_type,
         target_value, minimum_value, busy_day_value, baseline_value, success_limit_value,
         cue_type, cue_time, cue, start_action, friction, minimum_floor,
         journey_start_date, journey_length, reward_id, difficulty, goal_type, milestones
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NULL, NULL,
         $11, $12, $13, $14, $15, $16, $17, 22, $18, $19, 'build', '[]'::jsonb
       ) RETURNING id`,
      [
        userId,
        values.title,
        values.emoji,
        values.category,
        values.cadence ?? "daily",
        values.unit,
        values.executionType,
        values.targetValue,
        values.minimumValue,
        values.busyDayValue ?? null,
        values.cueType ?? null,
        values.cueTime ?? null,
        values.cue ?? null,
        values.startAction ?? null,
        values.friction ?? null,
        values.minimumFloor ?? null,
        values.startDate,
        values.rewardId ?? null,
        values.difficulty ?? "hard",
      ],
    );
    const habitId = result.rows[0].id;
    for (let index = 0; index < 22; index += 1) {
      const scheduled = !(values.restDays ?? []).includes(index);
      await adminPool.query(
        `INSERT INTO ${quote("habit_days")} (
           habit_id, day_number, date, scheduled, title, target_value, minimum_value,
           busy_day_value, goal_type, unit, execution_type, cue_type, cue_time, cue,
           start_action, plan_revision
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'build', $9, $10, $11, $12, $13, $14, 1)`,
        [
          habitId,
          index + 1,
          addDays(values.startDate, index),
          scheduled,
          values.title,
          values.targetValue,
          values.minimumValue,
          values.busyDayValue ?? null,
          values.unit,
          values.executionType,
          values.cueType ?? null,
          values.cueTime ?? null,
          values.cue ?? null,
          values.startAction ?? null,
        ],
      );
    }
    return habitId;
  }

  async function financialSnapshot() {
    const balances = await adminPool.query(
      `SELECT id, coins, xp FROM ${quote("users")} ORDER BY id`,
    );
    const [coinTransactions, rewards] = await Promise.all([
      adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")}`),
      adminPool.query(`SELECT count(*)::int AS count FROM ${quote("rewards")}`),
    ]);
    return {
      balances: balances.rows,
      coinTransactions: coinTransactions.rows[0].count,
      rewards: rewards.rows[0].count,
    };
  }

  before(async () => {
    for (const statement of ddl) await adminPool.query(statement);
    const migrationClient = await adminPool.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query(`SET LOCAL search_path TO "${schema}"`);
      await migrationClient.query(
        await readFile(join(dbDir, "migrations/0008_feature09_social.sql"), "utf8"),
      );
      await migrationClient.query("COMMIT");
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationClient.release();
    }
    tempDir = await mkdtemp(join(apiDir, ".social-circles-http-test-"));
    const fakeStoragePath = join(tempDir, "fake-google-cloud-storage.mjs");
    await writeFile(fakeStoragePath, `
      import { Readable } from "node:stream";
      const objects = new Map();
      const keyOf = (bucket, name) => bucket + "/" + name;
      class FixtureFile {
        constructor(bucket, name) {
          this.bucketName = bucket;
          this.name = name;
          this.key = keyOf(bucket, name);
        }
        async exists() { return [objects.has(this.key)]; }
        async getMetadata() {
          const item = objects.get(this.key);
          if (!item) throw new Error("fixture object not found: " + this.key);
          return [{ ...item.metadata, size: String(item.bytes.length), metadata: { ...item.customMetadata } }];
        }
        async setMetadata(input) {
          const item = objects.get(this.key);
          if (!item) throw new Error("fixture object not found: " + this.key);
          item.customMetadata = { ...item.customMetadata, ...(input.metadata ?? {}) };
        }
        createReadStream() {
          const item = objects.get(this.key);
          if (!item) throw new Error("fixture object not found: " + this.key);
          return Readable.from([Buffer.from(item.bytes)]);
        }
        async save(contents, options = {}) {
          const bytes = Buffer.from(contents);
          objects.set(this.key, {
            bytes,
            metadata: { contentType: options.metadata?.contentType ?? "application/octet-stream" },
            customMetadata: {},
          });
        }
        async delete() { objects.delete(this.key); }
      }
      export class Storage {
        bucket(bucketName) {
          return { file: (objectName) => new FixtureFile(bucketName, objectName) };
        }
      }
      export class File extends FixtureFile {}
      export function seedObject(bucketName, objectName, bytes, contentType) {
        objects.set(keyOf(bucketName, objectName), {
          bytes: Buffer.from(bytes),
          metadata: { contentType },
          customMetadata: {},
        });
      }
      export function objectMetadata(bucketName, objectName) {
        const item = objects.get(keyOf(bucketName, objectName));
        return item ? { ...item.metadata, size: item.bytes.length, customMetadata: { ...item.customMetadata } } : null;
      }
    `);
    const entry = join(tempDir, "social-circles-entry.ts");
    const bundle = join(tempDir, "social-circles.mjs");
    await writeFile(entry, `
      export { default as socialCirclesRouter } from ${JSON.stringify(join(apiDir, "src/routes/social-circles.ts"))};
      export { default as legacyGroupsRouter } from ${JSON.stringify(join(apiDir, "src/routes/groups.ts"))};
      export { default as habitsRouter } from ${JSON.stringify(join(apiDir, "src/routes/habits.ts"))};
      export { default as socialFriendsRouter } from ${JSON.stringify(join(apiDir, "src/routes/social-friends.ts"))};
      export {
        inviteUsersToSocialGroup,
        recordSharedGroupActivityOnce,
      } from ${JSON.stringify(join(apiDir, "src/services/social-circles.ts"))};
      export { db, groupsTable, pool, usersTable } from "@workspace/db";
      export { seedObject, objectMetadata } from ${JSON.stringify(fakeStoragePath)};
    `);

    const adapterPlugin = {
      name: "social-circles-isolated-postgres",
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: "isolated-social-db",
          namespace: "isolated-social-db",
        }));
        esbuild.onLoad({ filter: /^isolated-social-db$/, namespace: "isolated-social-db" }, () => ({
          resolveDir: dbDir,
          loader: "js",
          contents: `
            import pg from "pg";
            import { drizzle } from "drizzle-orm/node-postgres";
            import * as schema from "./src/schema/index.ts";
            export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
            export const db = drizzle(pool, { schema });
            export * from "./src/schema/index.ts";
          `,
        }));
        esbuild.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
          path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
        }));
        esbuild.onResolve({ filter: /^pg$/ }, () => ({ path: pgEntry, external: true }));
        esbuild.onResolve({ filter: /^@google-cloud\/storage$/ }, () => ({
          path: fakeStoragePath,
        }));
        esbuild.onResolve({ filter: /^\.\.\/middlewares\/requireAuth$/ }, () => ({
          path: "test-auth",
          namespace: "social-circles-test",
        }));
        esbuild.onLoad({ filter: /^test-auth$/, namespace: "social-circles-test" }, () => ({
          loader: "js",
          contents: `
            export function requireAuth(req, res, next) {
              const userId = req.headers["x-test-user"];
              if (!userId) return res.status(401).json({ error: "Unauthorized" });
              req.userId = userId;
              next();
            }
          `,
        }));
        esbuild.onResolve({ filter: /^\.\.\/lib\/userService$/ }, () => ({
          path: "test-user-service",
          namespace: "social-circles-test",
        }));
        esbuild.onLoad({ filter: /^test-user-service$/, namespace: "social-circles-test" }, () => ({
          loader: "js",
          contents: `export async function ensureUser(userId) { return { id: userId, timezone: "UTC" }; }`,
        }));
      },
    };
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      plugins: [adapterPlugin],
      logLevel: "silent",
    });
    testApi = await import(pathToFileURL(bundle).href);
    servicePools.push(testApi.pool);
    fakeStorage = testApi;

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.log = { error() {} };
      next();
    });
    app.use(testApi.socialCirclesRouter);
    app.use(testApi.legacyGroupsRouter);
    app.use(testApi.socialFriendsRouter);
    app.use(testApi.habitsRouter);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    httpBase = `http://127.0.0.1:${server.address().port}`;

    await adminPool.query(
      `INSERT INTO ${quote("users")} (id, display_name, username, timezone, xp, coins)
       VALUES
         ('user-a', 'Avery', 'avery', 'UTC', 101, 501),
         ('user-b', 'Blair', 'blair', 'UTC', 202, 502),
         ('user-c', 'Casey', 'casey', 'UTC', 303, 503),
         ('user-d', 'Drew', 'drew', 'UTC', 404, 504)`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
       VALUES ('user-a', 'user-b'), ('user-a', 'user-c')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("coin_transactions")} (user_id, amount, reason)
       VALUES ('user-a', 5, 'manual'), ('user-b', 3, 'checkin')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("rewards")} (user_id, title, emoji, coin_cost)
       VALUES ('user-a', 'A reward', '🎁', 10), ('user-b', 'B reward', '🎁', 20)`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("character_items")} (name, slot, emoji, coin_cost)
       VALUES ('Comet hat', 'hat', '☄️', 10)`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("user_character_items")} (user_id, item_id, equipped)
       SELECT 'user-a', id, true FROM ${quote("character_items")} WHERE name = 'Comet hat'`,
    );

    const today = new Date().toISOString().slice(0, 10);
    const startDate = addDays(today, -21);
    fixture = {
      today,
      startDate,
      sourceHabitId: await seedHabit("user-a", {
        title: "Read safely",
        emoji: "📖",
        category: "learning",
        unit: "pages",
        executionType: "count",
        targetValue: 5,
        minimumValue: 2,
        busyDayValue: 4,
        cueType: "time",
        cueTime: "07:30",
        cue: "After coffee",
        startAction: "Open the book",
        friction: "Private profile text",
        minimumFloor: 1,
        startDate,
        rewardId: 999,
        difficulty: "hard",
      }),
      memberHabitId: await seedHabit("user-b", {
        title: "Walk privately",
        emoji: "🚶",
        category: "health",
        unit: "minutes",
        executionType: "duration",
        targetValue: 10,
        minimumValue: 3,
        startDate,
        restDays: [2],
      }),
    };
    await adminPool.query(
      `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, note)
       VALUES
         ($1, 'user-b', $2, true, 'private note one'),
         ($1, 'user-b', $3, true, 'private note two'),
         ($1, 'user-b', $4, true, 'rest-day completion must not count')`,
      [
        fixture.memberHabitId,
        startDate,
        addDays(startDate, 1),
        addDays(startDate, 2),
      ],
    );

    const coverABytes = await sharp({
      create: { width: 12, height: 10, channels: 3, background: "#e85d04" },
    }).png().toBuffer();
    const coverBBytes = await sharp({
      create: { width: 12, height: 10, channels: 3, background: "#0077b6" },
    }).png().toBuffer();
    fakeStorage.seedObject("test-bucket", "private/uploads/upload-a", coverABytes, "image/png");
    fakeStorage.seedObject("test-bucket", "private/uploads/upload-b", coverBBytes, "image/png");
    await adminPool.query(
      `INSERT INTO ${quote("object_uploads")} (object_path, user_id)
       VALUES ('/objects/uploads/upload-a', 'user-a'),
              ('/objects/uploads/upload-b', 'user-b')`,
    );
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
    await Promise.all(servicePools.map((pool) => pool.end()));
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await adminPool.end();
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
      else process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
    }
  });

  test("group and challenge HTTP lifecycle enforces membership, consent, ownership, privacy, and idempotency", async () => {
    const initialFinancials = await financialSnapshot();
    const { sourceHabitId, memberHabitId, startDate } = fixture;

    const createdGroup = await request("user-a", "POST", "/social/groups", {
      name: "Private pair",
      description: "Invite-only",
      goalDescription: "Read and walk",
      maxMembers: 2,
    });
    assert.equal(createdGroup.status, 201, JSON.stringify(createdGroup.data));
    const groupId = createdGroup.data.id;
    assert.equal(createdGroup.data.role, "owner");
    assert.equal(createdGroup.data.memberCount, 1);
    assert.equal("inviteCode" in createdGroup.data, false);
    assert.equal(createdGroup.data.members[0].role, "owner");
    assert.equal(createdGroup.data.members[0].user.id, "user-a");

    const ownerGroups = await request("user-a", "GET", "/social/groups");
    assert.equal(ownerGroups.status, 200);
    assert.equal(ownerGroups.data.length, 1);
    assert.equal(ownerGroups.data[0].role, "owner");
    const outsiderGroups = await request("user-d", "GET", "/social/groups");
    assert.equal(outsiderGroups.status, 200);
    assert.deepEqual(outsiderGroups.data, []);
    assert.equal((await request("user-d", "GET", `/social/groups/${groupId}`)).status, 404);
    assert.equal((await request("user-d", "GET", `/social/groups/${groupId}/shares`)).status, 404);

    const leaveRaceGroup = await request("user-a", "POST", "/social/groups", {
      name: "Leave versus accept",
      goalDescription: "Serialize group access",
      maxMembers: 2,
    });
    assert.equal(leaveRaceGroup.status, 201, JSON.stringify(leaveRaceGroup.data));
    const leaveRaceInvite = await request("user-a", "POST", `/social/groups/${leaveRaceGroup.data.id}/invitations`, {
      inviteeUserIds: ["user-b"],
    });
    assert.equal(leaveRaceInvite.status, 201, JSON.stringify(leaveRaceInvite.data));
    const [leaveRaceAccept, leaveRaceOwner] = await withDeadline(Promise.all([
      request("user-b", "POST", `/social/group-invitations/${leaveRaceInvite.data[0].id}/respond`, {
        decision: "accept",
      }),
      request("user-a", "POST", `/social/groups/${leaveRaceGroup.data.id}/leave`),
    ]));
    assert.equal(leaveRaceOwner.status, 204);
    assert.ok([200, 404].includes(leaveRaceAccept.status), JSON.stringify(leaveRaceAccept.data));
    const leaveRaceState = await adminPool.query(
      `SELECT g.id, gm.user_id, gm.role
       FROM ${quote("groups")} g
       LEFT JOIN ${quote("group_members")} gm ON gm.group_id = g.id
       WHERE g.id = $1`,
      [leaveRaceGroup.data.id],
    );
    if (leaveRaceAccept.status === 200) {
      assert.deepEqual(leaveRaceState.rows, [{ id: leaveRaceGroup.data.id, user_id: "user-b", role: "owner" }]);
    } else {
      assert.deepEqual(leaveRaceState.rows, []);
    }

    const groupCode = (await adminPool.query(
      `SELECT invite_code FROM ${quote("groups")} WHERE id = $1`,
      [groupId],
    )).rows[0].invite_code;
    const legacyCodeJoin = await request("user-d", "POST", "/groups/join", {
      inviteCode: groupCode,
    });
    assert.equal(legacyCodeJoin.status, 403);

    const nonFriendInvite = await request("user-a", "POST", `/social/groups/${groupId}/invitations`, {
      inviteeUserIds: ["user-d"],
    });
    assert.equal(nonFriendInvite.status, 403);
    const inviteB = await request("user-a", "POST", `/social/groups/${groupId}/invitations`, {
      inviteeUserIds: ["user-b"],
    });
    assert.equal(inviteB.status, 201, JSON.stringify(inviteB.data));
    assert.equal(inviteB.data.length, 1);
    assert.equal(inviteB.data[0].status, "pending");
    const capWhilePending = await request("user-a", "POST", `/social/groups/${groupId}/invitations`, {
      inviteeUserIds: ["user-c"],
    });
    assert.equal(capWhilePending.status, 409);

    const incomingB = await request("user-b", "GET", "/social/group-invitations/incoming");
    assert.equal(incomingB.status, 200);
    assert.equal(incomingB.data.length, 1);
    const acceptB = await request(
      "user-b",
      "POST",
      `/social/group-invitations/${inviteB.data[0].id}/respond`,
      { decision: "accept" },
    );
    assert.equal(acceptB.status, 200, JSON.stringify(acceptB.data));
    const memberGroup = await request("user-b", "GET", `/social/groups/${groupId}`);
    assert.equal(memberGroup.status, 200);
    assert.equal(memberGroup.data.role, "member");
    assert.equal(memberGroup.data.memberCount, 2);
    assert.deepEqual(memberGroup.data.members.map((member) => member.role).sort(), ["member", "owner"]);
    assert.equal(memberGroup.data.members.find((member) => member.user.id === "user-b").sharedJourneys.length, 0);

    const preShareActivity = await request("user-a", "GET", `/social/groups/${groupId}/activity`);
    assert.equal(preShareActivity.status, 200);
    assert.equal(preShareActivity.data.some((event) => event.journeyId === memberHabitId), false);

    const unsharedList = await request("user-b", "GET", `/social/groups/${groupId}/shares`);
    assert.deepEqual(unsharedList.data, []);
    const sharedJourney = await request("user-b", "POST", `/social/groups/${groupId}/shares`, {
      journeyId: memberHabitId,
    });
    assert.equal(sharedJourney.status, 201, JSON.stringify(sharedJourney.data));
    assert.equal(sharedJourney.data.journey.journeyId, memberHabitId);
    const milestoneInput = {
      actorUserId: "user-b",
      journeyId: memberHabitId,
      eventType: "milestone",
      idempotencyKey: `milestone:${memberHabitId}:2`,
    };
    await testApi.db.transaction((tx) => testApi.recordSharedGroupActivityOnce(tx, milestoneInput));
    await testApi.db.transaction((tx) => testApi.recordSharedGroupActivityOnce(tx, milestoneInput));
    const positiveActivity = await request("user-a", "GET", `/social/groups/${groupId}/activity`);
    assert.equal(positiveActivity.status, 200);
    assert.equal(positiveActivity.data.filter((event) =>
      event.eventType === "milestone" && event.journey?.journeyId === memberHabitId).length, 1);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("social_group_activity_events")}
       WHERE group_id = $1 AND idempotency_key = $2`,
      [groupId, milestoneInput.idempotencyKey],
    )).rows[0].count, 1);
    const milestoneNotifications = await request("user-a", "GET", "/social/notifications");
    assert.equal(milestoneNotifications.status, 200);
    assert.equal(milestoneNotifications.data.filter((notification) =>
      notification.type === "group_milestone").length, 1);
    const sharedDetail = await request("user-a", "GET", `/social/groups/${groupId}`);
    const memberProgress = sharedDetail.data.members.find((member) => member.user.id === "user-b")
      .sharedJourneys[0];
    assert.equal(memberProgress.journeyId, memberHabitId);
    assert.equal(memberProgress.successfulDayCount, 2);
    assert.equal("note" in memberProgress, false);
    assert.equal("targetValue" in memberProgress, false);
    assert.equal("cue" in memberProgress, false);
    assert.deepEqual(Object.keys(memberProgress).sort(), [
      "completed",
      "emoji",
      "journeyId",
      "journeyLength",
      "progressDay",
      "successfulDayCount",
      "title",
    ]);

    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
       VALUES ('user-a', 'user-d')`,
    );
    await adminPool.query(
      `UPDATE ${quote("groups")} SET max_members = 3 WHERE id = $1`,
      [groupId],
    );
    let groupLockAcquired;
    let allowFanout;
    let invitationLocksAcquired;
    const groupIsLocked = new Promise((resolve) => { groupLockAcquired = resolve; });
    const fanoutMayProceed = new Promise((resolve) => { allowFanout = resolve; });
    const invitationHasLocks = new Promise((resolve) => { invitationLocksAcquired = resolve; });
    const fanoutOperation = testApi.db.transaction(async (tx) => {
      await tx.select({ id: testApi.groupsTable.id }).from(testApi.groupsTable)
        .where(eq(testApi.groupsTable.id, groupId)).for("update").limit(1);
      groupLockAcquired();
      await fanoutMayProceed;
      return testApi.recordSharedGroupActivityOnce(tx, {
        actorUserId: "user-b",
        journeyId: memberHabitId,
        eventType: "milestone",
        idempotencyKey: `milestone:${memberHabitId}:10`,
      });
    });
    await groupIsLocked;
    const invitationOperation = testApi.db.transaction(async (tx) => {
      await tx.select({ id: testApi.usersTable.id }).from(testApi.usersTable)
        .where(inArray(testApi.usersTable.id, ["user-a", "user-d"]))
        .orderBy(testApi.usersTable.id)
        .for("no key update");
      const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      const backendPid = Number(backend.rows[0].pid);
      invitationLocksAcquired(backendPid);
      return testApi.inviteUsersToSocialGroup(tx, groupId, "user-a", ["user-d"]);
    });
    const invitationBackendPid = await invitationHasLocks;
    try {
      await waitForLockWait(invitationBackendPid);
    } finally {
      allowFanout();
    }
    const [, raceInvitations] = await withDeadline(Promise.all([
      fanoutOperation,
      invitationOperation,
    ]));
    assert.equal(raceInvitations.length, 1);
    assert.equal(raceInvitations[0].invitee.id, "user-d");
    await adminPool.query(
      `UPDATE ${quote("social_group_invitations")} SET status = 'canceled'
       WHERE id = $1`,
      [raceInvitations[0].id],
    );

    const cheerRequestId = randomUUID();
    const cheerBody = {
      receiverUserId: "user-b",
      template: "great_job",
      message: "Nice work",
      requestId: cheerRequestId,
    };
    const cheerOne = await request("user-a", "POST", `/social/groups/${groupId}/encouragements`, cheerBody);
    const cheerRetry = await request("user-a", "POST", `/social/groups/${groupId}/encouragements`, cheerBody);
    assert.equal(cheerOne.status, 201);
    assert.equal(cheerRetry.status, 201);
    assert.equal(cheerOne.data.id, cheerRetry.data.id);
    const [cheerCount] = (await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("group_reactions")}
       WHERE group_id = $1 AND request_id = $2`,
      [groupId, cheerRequestId],
    )).rows;
    assert.equal(cheerCount.count, 1);

    const foreignCover = await request("user-a", "PUT", `/social/groups/${groupId}/cover`, {
      imageObjectPath: "/objects/uploads/upload-b",
    });
    assert.equal(foreignCover.status, 403);
    const memberCoverWrite = await request("user-b", "PUT", `/social/groups/${groupId}/cover`, {
      imageObjectPath: "/objects/uploads/upload-b",
    });
    assert.equal(memberCoverWrite.status, 403);
    const coverBefore = (await adminPool.query(
      `SELECT cover_object_path FROM ${quote("groups")} WHERE id = $1`,
      [groupId],
    )).rows[0].cover_object_path;
    assert.equal(coverBefore, null);
    const ownerCover = await request("user-a", "PUT", `/social/groups/${groupId}/cover`, {
      imageObjectPath: "/objects/uploads/upload-a",
    });
    assert.equal(ownerCover.status, 200, JSON.stringify(ownerCover.data));
    assert.match(ownerCover.data.imageUrl, new RegExp(`^/social/groups/${groupId}/cover$`));
    const savedCoverPath = (await adminPool.query(
      `SELECT cover_object_path FROM ${quote("groups")} WHERE id = $1`,
      [groupId],
    )).rows[0].cover_object_path;
    assert.match(savedCoverPath, /^\/objects\/memory-images\//);
    assert.deepEqual(fakeStorage.objectMetadata(
      "test-bucket",
      `private/${savedCoverPath.slice("/objects/".length)}`,
    ).customMetadata["custom:aclPolicy"], JSON.stringify({
      owner: "user-a",
      visibility: "private",
    }));
    const memberCoverRead = await request("user-b", "GET", `/social/groups/${groupId}/cover`);
    assert.equal(memberCoverRead.status, 200);
    assert.equal(memberCoverRead.headers.get("cache-control"), "private, no-store");
    const outsiderCoverRead = await request("user-d", "GET", `/social/groups/${groupId}/cover`);
    assert.equal(outsiderCoverRead.status, 404);

    const revokeJourneyShare = await request(
      "user-b",
      "DELETE",
      `/social/groups/${groupId}/shares/${memberHabitId}`,
    );
    assert.equal(revokeJourneyShare.status, 204);
    await testApi.db.transaction((tx) => testApi.recordSharedGroupActivityOnce(tx, {
      actorUserId: "user-b",
      journeyId: memberHabitId,
      eventType: "successful_day",
      idempotencyKey: `successful-day:${memberHabitId}:${fixture.today}`,
    }));
    const revokedActivity = await request("user-a", "GET", `/social/groups/${groupId}/activity`);
    assert.equal(revokedActivity.data.some((event) =>
      event.journey?.journeyId === memberHabitId), false);
    const notificationsAfterRevoke = await request("user-a", "GET", "/social/notifications");
    assert.equal(notificationsAfterRevoke.status, 200);
    assert.equal(notificationsAfterRevoke.data.some((notification) =>
      notification.type === "group_milestone"), false);

    const legacyGroup = await request("user-a", "POST", "/groups", {
      name: "Legacy private group",
      goalDescription: "No progress counts",
      startDate: new Date(`${startDate}T00:00:00.000Z`).toISOString(),
    });
    assert.equal(legacyGroup.status, 201, JSON.stringify(legacyGroup.data));
    assert.equal(legacyGroup.data.inviteCode, "");
    await adminPool.query(
      `INSERT INTO ${quote("group_members")} (group_id, user_id, role)
       VALUES ($1, 'user-b', 'member')`,
      [legacyGroup.data.id],
    );
    const legacyReaction = await request("user-b", "POST", `/groups/${legacyGroup.data.id}/reactions`, {
      toUserId: "user-a",
      emoji: "🌟",
    });
    assert.equal(legacyReaction.status, 201, JSON.stringify(legacyReaction.data));
    const legacyReactionRetry = await request("user-b", "POST", `/groups/${legacyGroup.data.id}/reactions`, {
      toUserId: "user-a",
      emoji: "🌟",
    });
    assert.equal(legacyReactionRetry.status, 409);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("group_reactions")}
       WHERE group_id = $1 AND from_user_id = 'user-b'`,
      [legacyGroup.data.id],
    )).rows[0].count, 1);
    const legacyDetail = await request("user-b", "GET", `/groups/${legacyGroup.data.id}`);
    assert.equal(legacyDetail.status, 200);
    assert.equal(legacyDetail.data.inviteCode, "");
    assert.equal(legacyDetail.data.memberCount, 2);
    assert.ok(legacyDetail.data.members.every((member) =>
      !("progress" in member) && !("checkinCount" in member) && !("successfulDayCount" in member),
    ));
    assert.equal((await request("user-d", "GET", `/groups/${legacyGroup.data.id}`)).status, 404);
    const legacyGroupCode = (await adminPool.query(
      `SELECT invite_code FROM ${quote("groups")} WHERE id = $1`,
      [legacyGroup.data.id],
    )).rows[0].invite_code;
    const legacyUnjoined = await request("user-d", "POST", "/groups/join", {
      inviteCode: legacyGroupCode,
    });
    assert.equal(legacyUnjoined.status, 403);

    await adminPool.query(
      `INSERT INTO ${quote("social_blocks")} (blocker_user_id, blocked_user_id)
       VALUES ('user-a', 'user-b')`,
    );
    const ownerAfterBlock = await request("user-a", "GET", `/social/groups/${groupId}`);
    const memberAfterBlock = await request("user-b", "GET", `/social/groups/${groupId}`);
    assert.equal(ownerAfterBlock.status, 200);
    assert.equal(ownerAfterBlock.data.members.some((member) => member.user.id === "user-b"), false);
    assert.equal(memberAfterBlock.status, 200);
    assert.equal(memberAfterBlock.data.members.some((member) => member.user.id === "user-a"), false);
    const blockedEncouragement = await request("user-b", "POST", `/social/groups/${groupId}/encouragements`, {
      receiverUserId: "user-a",
      template: "keep_going",
      requestId: randomUUID(),
    });
    assert.equal(blockedEncouragement.status, 404);

    const leaveB = await request("user-b", "POST", `/social/groups/${groupId}/leave`);
    assert.equal(leaveB.status, 204);
    const sharesAfterLeave = await request("user-a", "GET", `/social/groups/${groupId}/shares`);
    assert.equal(sharesAfterLeave.status, 200);
    assert.deepEqual(sharesAfterLeave.data, []);
    const groupAfterLeave = await request("user-a", "GET", `/social/groups/${groupId}`);
    assert.equal(groupAfterLeave.data.memberCount, 1);
    assert.equal(groupAfterLeave.data.members.some((member) => member.user.id === "user-b"), false);

    const inviteC = await request("user-a", "POST", `/social/groups/${groupId}/invitations`, {
      inviteeUserIds: ["user-c"],
    });
    assert.equal(inviteC.status, 201, JSON.stringify(inviteC.data));
    assert.equal(inviteC.data[0].status, "pending");
    const declineC = await request(
      "user-c",
      "POST",
      `/social/group-invitations/${inviteC.data[0].id}/respond`,
      { decision: "decline" },
    );
    assert.equal(declineC.status, 200, JSON.stringify(declineC.data));
    assert.equal(declineC.data.status, "declined");
    const reinviteC = await request("user-a", "POST", `/social/groups/${groupId}/invitations`, {
      inviteeUserIds: ["user-c"],
    });
    assert.equal(reinviteC.status, 201, JSON.stringify(reinviteC.data));
    await adminPool.query(
      `INSERT INTO ${quote("social_blocks")} (blocker_user_id, blocked_user_id)
       VALUES ('user-a', 'user-c')`,
    );
    const blockedCIncoming = await request("user-c", "GET", "/social/group-invitations/incoming");
    assert.deepEqual(blockedCIncoming.data, []);
    const acceptBlockedC = await request(
      "user-c",
      "POST",
      `/social/group-invitations/${reinviteC.data[0].id}/respond`,
      { decision: "accept" },
    );
    assert.equal(acceptBlockedC.status, 404);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("group_members")}
       WHERE group_id = $1 AND user_id = 'user-c'`,
      [groupId],
    )).rows[0].count, 0);

    await adminPool.query(
      `DELETE FROM ${quote("social_blocks")} WHERE blocker_user_id = 'user-a' AND blocked_user_id = 'user-b'`,
    );
    const challengeCreated = await request("user-a", "POST", "/social/challenges", {
      sourceHabitId,
      title: "A safe independent challenge",
      description: "Each participant controls their plan",
    });
    assert.equal(challengeCreated.status, 201, JSON.stringify(challengeCreated.data));
    const challengeId = challengeCreated.data.id;
    const challengeInvite = await request("user-a", "POST", `/social/challenges/${challengeId}/invitations`, {
      inviteeUserIds: ["user-b"],
    });
    assert.equal(challengeInvite.status, 201, JSON.stringify(challengeInvite.data));
    const beforeAcceptHabits = (await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habits")} WHERE user_id = 'user-b'`,
    )).rows[0].count;
    const invitedChallenge = await request("user-b", "GET", `/social/challenges/${challengeId}`);
    assert.equal(invitedChallenge.status, 200);
    assert.equal(invitedChallenge.data.myStatus, "invited");
    assert.equal(invitedChallenge.data.members.find((member) => member.user.id === "user-b").journeyId, null);
    assert.equal(invitedChallenge.data.members.find((member) => member.user.id === "user-b").progressDay, null);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habits")} WHERE user_id = 'user-b'`,
    )).rows[0].count, beforeAcceptHabits);

    const acceptBody = {
      decision: "accept",
      targetValue: 11,
      minimumValue: 3,
      difficulty: "medium",
      cadence: "weekdays",
    };
    const concurrentAccepts = await Promise.all([
      request("user-b", "POST", `/social/challenges/${challengeId}/respond`, acceptBody),
      request("user-b", "POST", `/social/challenges/${challengeId}/respond`, acceptBody),
    ]);
    assert.deepEqual(concurrentAccepts.map((item) => item.status), [200, 200]);
    const acceptedHabitIds = concurrentAccepts.map((result) =>
      result.data.members.find((member) => member.user.id === "user-b").journeyId,
    );
    assert.ok(acceptedHabitIds[0] > 0);
    assert.equal(acceptedHabitIds[1], acceptedHabitIds[0]);
    const challengeHabitId = acceptedHabitIds[0];
    assert.notEqual(challengeHabitId, sourceHabitId);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habits")} WHERE user_id = 'user-b'`,
    )).rows[0].count, beforeAcceptHabits + 1);
    const [challengeHabit] = (await adminPool.query(
      `SELECT * FROM ${quote("habits")} WHERE id = $1 AND user_id = 'user-b'`,
      [challengeHabitId],
    )).rows;
    assert.ok(challengeHabit);
    assert.equal(challengeHabit.target_value, 11);
    assert.equal(challengeHabit.minimum_value, 3);
    assert.equal(challengeHabit.difficulty, "medium");
    assert.equal(challengeHabit.cadence, "weekdays");
    assert.equal(challengeHabit.cue_type, null);
    assert.equal(challengeHabit.cue_time, null);
    assert.equal(challengeHabit.cue, null);
    assert.equal(challengeHabit.start_action, null);
    assert.equal(challengeHabit.friction, null);
    assert.equal(challengeHabit.minimum_floor, null);
    assert.equal(challengeHabit.reward_id, null);
    assert.equal(challengeHabit.busy_day_value, null);
    assert.equal(challengeHabit.baseline_value, null);
    assert.deepEqual(challengeHabit.milestones, []);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habit_days")} WHERE habit_id = $1`,
      [challengeHabitId],
    )).rows[0].count, 22);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("habit_plan_revisions")} WHERE habit_id = $1`,
      [challengeHabitId],
    )).rows[0].count, 1);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("social_challenge_members")}
       WHERE challenge_id = $1 AND user_id = 'user-b' AND habit_id = $2
         AND status = 'accepted'`,
      [challengeId, challengeHabitId],
    )).rows[0].count, 1);

    const creatorTemplate = challengeCreated.data.template;
    assert.equal("cue" in creatorTemplate, false);
    assert.equal("cueTime" in creatorTemplate, false);
    assert.equal("startAction" in creatorTemplate, false);
    assert.equal("friction" in creatorTemplate, false);
    assert.equal("minimumFloor" in creatorTemplate, false);
    assert.equal("rewardId" in creatorTemplate, false);
    assert.equal("baselineValue" in creatorTemplate, false);
    assert.equal("busyDayValue" in creatorTemplate, false);
    const ownerReadForeignHabit = await request("user-a", "GET", `/habits/${challengeHabitId}`);
    assert.equal(ownerReadForeignHabit.status, 404);
    const ownerEditForeignHabit = await request("user-a", "PATCH", `/habits/${challengeHabitId}`, {
      title: "Cross-owner edit attempt",
    });
    assert.equal(ownerEditForeignHabit.status, 404);
    const unchangedChallengeTitle = (await adminPool.query(
      `SELECT title FROM ${quote("habits")} WHERE id = $1`,
      [challengeHabitId],
    )).rows[0].title;
    assert.equal(unchangedChallengeTitle, "Read safely");
    const ownerChallengeView = await request("user-a", "GET", `/social/challenges/${challengeId}`);
    assert.equal(ownerChallengeView.status, 200);
    const acceptedMember = ownerChallengeView.data.members.find((member) => member.user.id === "user-b");
    assert.equal(acceptedMember.status, "accepted");
    assert.equal(acceptedMember.journeyId, challengeHabitId);
    assert.equal(acceptedMember.consistencyPercentage, 0);
    const privateProfileChallenge = await request("user-b", "GET", `/social/challenges/${challengeId}`);
    assert.deepEqual(
      privateProfileChallenge.data.members.find((member) => member.user.id === "user-a").character,
      [],
    );
    const profileShare = await adminPool.query(
      `INSERT INTO ${quote("social_shares")} (owner_user_id, resource_type, resource_id, visibility)
       VALUES ('user-a', 'character', 'profile', 'selected') RETURNING id`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_share_recipients")} (share_id, recipient_user_id)
       VALUES ($1, 'user-b')`,
      [profileShare.rows[0].id],
    );
    const selectedProfileChallenge = await request("user-b", "GET", `/social/challenges/${challengeId}`);
    assert.deepEqual(
      selectedProfileChallenge.data.members.find((member) => member.user.id === "user-a").character,
      [{ slot: "hat", name: "Comet hat", emoji: "☄️" }],
    );

    const elapsedStart = addDays(fixture.today, -2);
    await adminPool.query(
      `UPDATE ${quote("habits")} SET journey_start_date = $2 WHERE id = $1`,
      [challengeHabitId, elapsedStart],
    );
    await adminPool.query(
      `UPDATE ${quote("social_challenge_members")} SET journey_start_date = $2
       WHERE challenge_id = $1 AND user_id = 'user-b'`,
      [challengeId, elapsedStart],
    );
    await adminPool.query(
      `UPDATE ${quote("habit_days")}
       SET date = $2::date + (day_number - 1), scheduled = day_number IN (1, 3, 4)
       WHERE habit_id = $1`,
      [challengeHabitId, elapsedStart],
    );
    await adminPool.query(
      `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed, note)
       VALUES
         ($1, 'user-b', $2, true, NULL),
         ($1, 'user-b', $3, true, NULL),
         ($1, 'user-b', $4, false, NULL),
         ($1, 'user-b', $5, true, NULL)`,
      [
        challengeHabitId,
        elapsedStart,
        addDays(elapsedStart, 1),
        fixture.today,
        addDays(fixture.today, 1),
      ],
    );
    const consistencyView = await request("user-a", "GET", `/social/challenges/${challengeId}`);
    assert.equal(
      consistencyView.data.members.find((member) => member.user.id === "user-b").consistencyPercentage,
      50,
    );

    await adminPool.query(
      `DELETE FROM ${quote("social_blocks")} WHERE blocker_user_id = 'user-a' AND blocked_user_id = 'user-c'`,
    );
    const inviteCForChallenge = await request(
      "user-a",
      "POST",
      `/social/challenges/${challengeId}/invitations`,
      { inviteeUserIds: ["user-c"] },
    );
    assert.equal(inviteCForChallenge.status, 201, JSON.stringify(inviteCForChallenge.data));
    const race = await Promise.all([
      request("user-c", "POST", `/social/challenges/${challengeId}/respond`, { decision: "accept" }),
      request("user-a", "POST", "/social/blocks", { blockedUserId: "user-c" }),
    ]);
    assert.equal(race[1].status, 201, JSON.stringify(race[1].data));
    assert.ok([200, 409].includes(race[0].status), JSON.stringify(race[0].data));
    const cChallengeMember = (await adminPool.query(
      `SELECT status, habit_id FROM ${quote("social_challenge_members")}
       WHERE challenge_id = $1 AND user_id = 'user-c'`,
      [challengeId],
    )).rows[0];
    if (race[0].status === 200) {
      assert.equal(cChallengeMember.status, "accepted");
      assert.ok(cChallengeMember.habit_id);
    } else {
      assert.equal(cChallengeMember.status, "declined");
      assert.equal(cChallengeMember.habit_id, null);
    }

    const leaveChallenge = await request("user-b", "POST", `/social/challenges/${challengeId}/leave`);
    assert.equal(leaveChallenge.status, 200);
    assert.equal(leaveChallenge.data.myStatus, "left");
    const ownerAfterChallengeLeave = await request("user-a", "GET", `/social/challenges/${challengeId}`);
    assert.equal(ownerAfterChallengeLeave.status, 200);
    assert.equal(ownerAfterChallengeLeave.data.members.some((member) => member.user.id === "user-b"), false);
    assert.equal((await adminPool.query(
      `SELECT status FROM ${quote("social_challenge_members")}
       WHERE challenge_id = $1 AND user_id = 'user-b'`,
      [challengeId],
    )).rows[0].status, "left");

    const finalFinancials = await financialSnapshot();
    assert.deepEqual(finalFinancials, initialFinancials);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("checkins")}`,
    )).rows[0].count, 7);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("coin_transactions")}`,
    )).rows[0].count, initialFinancials.coinTransactions);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS count FROM ${quote("rewards")}`,
    )).rows[0].count, initialFinancials.rewards);
  });
}