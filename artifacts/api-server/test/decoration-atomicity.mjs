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
const databaseUrl = process.env.API_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Decoration integration tests require API_TEST_DATABASE_URL, TEST_DATABASE_URL, or DATABASE_URL.");
}

const schema = `api_decorations_it_${randomUUID().replaceAll("-", "")}`;
const quote = (name) => `"${schema}"."${name}"`;
const scopedUrl = new URL(databaseUrl);
const options = scopedUrl.searchParams.get("options");
scopedUrl.searchParams.set("options", [options, `-c search_path=${schema}`].filter(Boolean).join(" "));
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = scopedUrl.toString();
const dbRequire = createRequire(join(dbDir, "package.json"));
const { Pool } = dbRequire("pg");
const pgEntry = dbRequire.resolve("pg");
const adminPool = new Pool({ connectionString: databaseUrl });
let servicePool;
let tempDir;
let server;

async function cleanup() {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (servicePool) await servicePool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
}

async function setup() {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const ddl = [
    `CREATE TYPE ${quote("motivation_style")} AS ENUM ('encouraging', 'tough_love', 'data_driven')`,
    `CREATE TYPE ${quote("goal_category")} AS ENUM ('health', 'learning', 'productivity', 'mindfulness', 'social', 'creativity', 'finance', 'custom')`,
    `CREATE TYPE ${quote("coin_transaction_reason")} AS ENUM ('checkin', 'streak_bonus', 'streak_recovery', 'reward_redemption', 'item_purchase', 'challenge_bonus', 'manual')`,
    `CREATE TYPE ${quote("character_item_slot")} AS ENUM ('outfit', 'hat', 'accessory', 'pet', 'background')`,
    `CREATE TABLE ${quote("users")} (
      id text PRIMARY KEY, display_name text NOT NULL, avatar_emoji text NOT NULL DEFAULT '🌱',
      level integer NOT NULL DEFAULT 1, xp integer NOT NULL DEFAULT 0, coins integer NOT NULL DEFAULT 0,
      motivation_style ${quote("motivation_style")} NOT NULL DEFAULT 'encouraging',
      primary_goal_category ${quote("goal_category")}, onboarding_completed boolean NOT NULL DEFAULT false,
      timezone text NOT NULL DEFAULT 'UTC', created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("habits")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE ${quote("coin_transactions")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      amount integer NOT NULL, reason ${quote("coin_transaction_reason")} NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("decoration_items")} (
      id serial PRIMARY KEY, name text NOT NULL UNIQUE, asset_file text NOT NULL UNIQUE,
      source_asset text NOT NULL UNIQUE, coin_cost integer NOT NULL CHECK (coin_cost > 0)
    )`,
    `CREATE TABLE ${quote("user_decorations")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      item_id integer NOT NULL REFERENCES ${quote("decoration_items")}(id) ON DELETE CASCADE,
      purchased_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, item_id)
    )`,
    `CREATE TABLE ${quote("habit_decorations")} (
      id serial PRIMARY KEY, habit_id integer NOT NULL REFERENCES ${quote("habits")}(id) ON DELETE CASCADE,
      item_id integer NOT NULL REFERENCES ${quote("decoration_items")}(id) ON DELETE CASCADE,
      island_id text NOT NULL CHECK (island_id IN ('beginnings','study','forest','dreams','heart','adventure')),
      slot integer NOT NULL CHECK (slot BETWEEN 0 AND 5), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (habit_id, item_id), UNIQUE (habit_id, island_id, slot)
    )`,
    `CREATE TABLE ${quote("decoration_purchase_keys")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
      item_id integer NOT NULL REFERENCES ${quote("decoration_items")}(id) ON DELETE CASCADE,
      purchased boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key)
    )`,
    `CREATE TABLE ${quote("rewards")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE ${quote("character_items")} (
      id serial PRIMARY KEY, name text NOT NULL UNIQUE, slot ${quote("character_item_slot")} NOT NULL,
      emoji text NOT NULL, coin_cost integer NOT NULL
    )`,
    `CREATE TABLE ${quote("journey_milestones")} (
      id serial PRIMARY KEY, level_required integer NOT NULL UNIQUE, title text NOT NULL,
      description text NOT NULL, emoji text NOT NULL, reward_coins integer NOT NULL
    )`,
  ];
  for (const statement of ddl) await adminPool.query(statement);

  tempDir = await mkdtemp(join(apiDir, ".decoration-test-"));
  const entry = join(tempDir, "decoration-test-entry.ts");
  const bundle = join(tempDir, "decoration-test-entry.mjs");
  await writeFile(entry, `
    export { default as decorationsRouter } from ${JSON.stringify(join(apiDir, "src/routes/decorations.ts"))};
    export { seedCatalogs } from ${JSON.stringify(join(apiDir, "src/lib/seed.ts"))};
    export { pool } from "@workspace/db";
  `);
  const adapterPlugin = {
    name: "isolated-decoration-schema",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "isolated-db", namespace: "isolated-db" }));
      esbuild.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
        path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
      }));
      esbuild.onResolve({ filter: /^@clerk\/express$/ }, () => ({ path: "isolated-clerk", namespace: "isolated-clerk" }));
      esbuild.onResolve({ filter: /^pg$/ }, () => ({ path: pgEntry, external: true }));
      esbuild.onResolve({ filter: /^express$/ }, () => ({ path: "express", external: true }));
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
        contents: `export const getAuth = (req) => ({ userId: req.headers["x-test-user"] ?? null });
          export const clerkClient = { users: { getUser: async () => { throw new Error("No Clerk in integration test"); } } };`,
      }));
    },
  };
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm",
    packages: "external", plugins: [adapterPlugin], logLevel: "silent",
  });
  const module = await import(pathToFileURL(bundle).href);
  servicePool = module.pool;
  await module.seedCatalogs();
  const seededCatalog = await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("decoration_items")}`);
  assert.equal(seededCatalog.rows[0].count, 23, "the existing startup seed hook seeds all 23 canonical decorations");
  const app = express();
  app.use(express.json());
  app.use(module.decorationsRouter);
  app.use((_error, _req, res, _next) => res.status(500).json({ error: "Internal test error" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (userId, path, method = "GET", body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, seedCatalogs: module.seedCatalogs };
}

test("decoration purchases and placements are atomic, scoped, and independent of rewards", async () => {
  try {
    const { request, seedCatalogs } = await setup();
    const owner = `owner_${randomUUID()}`;
    const other = `other_${randomUUID()}`;
    await adminPool.query(`INSERT INTO ${quote("users")} (id, display_name, coins) VALUES ($1, 'Owner', 100), ($2, 'Other', 100)`, [owner, other]);
    const { rows: [ownedHabit] } = await adminPool.query(`INSERT INTO ${quote("habits")} (user_id) VALUES ($1) RETURNING id`, [owner]);
    const { rows: [otherHabit] } = await adminPool.query(`INSERT INTO ${quote("habits")} (user_id) VALUES ($1) RETURNING id`, [other]);
    await adminPool.query(`INSERT INTO ${quote("rewards")} (user_id) VALUES ($1)`, [owner]);

    const purchasePath = (id) => `/decorations/items/${id}/purchase`;
    const parallel = await Promise.all([
      request(owner, purchasePath(1), "POST", { idempotencyKey: "parallel-key" }),
      request(owner, purchasePath(1), "POST", { idempotencyKey: "parallel-key" }),
    ]);
    assert.deepEqual(parallel.map((response) => response.status), [200, 200]);
    const parallelBodies = await Promise.all(parallel.map((response) => response.json()));
    assert.equal(parallelBodies.filter((body) => body.purchased).length, 2, "same-key replay reflects the committed purchase");
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [owner])).rows[0].coins, 90);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1`, [owner])).rows[0].count, 1);

    await adminPool.query(`UPDATE ${quote("users")} SET coins=97 WHERE id=$1`, [owner]);
    const replay = await request(owner, purchasePath(1), "POST", { idempotencyKey: "parallel-key" });
    assert.equal((await replay.json()).walletCoins, 97, "replay reports current authoritative wallet balance");
    const ownedAgain = await request(owner, purchasePath(1), "POST", { idempotencyKey: "new-owned-key" });
    assert.equal((await ownedAgain.json()).purchased, false, "owned item with a fresh key does not charge");
    const conflictingKey = await request(owner, purchasePath(2), "POST", { idempotencyKey: "parallel-key" });
    assert.equal(conflictingKey.status, 409);
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [owner])).rows[0].coins, 97);

    const [differentKeyA, differentKeyB] = await Promise.all([
      request(other, purchasePath(2), "POST", { idempotencyKey: "other-a" }),
      request(other, purchasePath(2), "POST", { idempotencyKey: "other-b" }),
    ]);
    assert.equal(differentKeyA.status, 200);
    assert.equal(differentKeyB.status, 200);
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [other])).rows[0].coins, 80,
      "parallel distinct keys cannot buy the globally owned item twice");
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1`, [other])).rows[0].count, 1);

    const poor = `poor_${randomUUID()}`;
    await adminPool.query(`INSERT INTO ${quote("users")} (id, display_name, coins) VALUES ($1, 'Poor', 5)`, [poor]);
    const insufficient = await request(poor, purchasePath(3), "POST", { idempotencyKey: "insufficient" });
    assert.equal(insufficient.status, 400);
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [poor])).rows[0].coins, 5);
    for (const table of ["coin_transactions", "user_decorations", "decoration_purchase_keys"]) {
      assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote(table)} WHERE user_id=$1`, [poor])).rows[0].count, 0,
        `insufficient purchase leaves no ${table} row`);
    }

    const rollbackUser = `rollback_${randomUUID()}`;
    await adminPool.query(`INSERT INTO ${quote("users")} (id, display_name, coins) VALUES ($1, 'Rollback', 100)`, [rollbackUser]);
    await adminPool.query(`CREATE FUNCTION ${quote("reject_decoration_ownership")}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.item_id=4 THEN RAISE EXCEPTION 'forced ownership failure'; END IF; RETURN NEW; END $$`);
    await adminPool.query(`CREATE TRIGGER reject_decoration_ownership BEFORE INSERT ON ${quote("user_decorations")}
      FOR EACH ROW EXECUTE FUNCTION ${quote("reject_decoration_ownership")}()`);
    const failed = await request(rollbackUser, purchasePath(4), "POST", { idempotencyKey: "rollback" });
    assert.equal(failed.status, 500);
    await adminPool.query(`DROP TRIGGER reject_decoration_ownership ON ${quote("user_decorations")}`);
    await adminPool.query(`DROP FUNCTION ${quote("reject_decoration_ownership")}()`);
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [rollbackUser])).rows[0].coins, 100);
    for (const table of ["coin_transactions", "user_decorations", "decoration_purchase_keys"]) {
      assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote(table)} WHERE user_id=$1`, [rollbackUser])).rows[0].count, 0,
        `failed purchase rolls back ${table}`);
    }

    const invalidIsland = await request(owner, `/habits/${ownedHabit.id}/decorations/1`, "PUT", { islandId: "unknown", slot: 1 });
    const invalidSlot = await request(owner, `/habits/${ownedHabit.id}/decorations/1`, "PUT", { islandId: "beginnings", slot: 6 });
    assert.equal(invalidIsland.status, 400);
    assert.equal(invalidSlot.status, 400);
    assert.equal((await request(owner, `/habits/${otherHabit.id}/decorations`)).status, 404, "other user's habit is hidden");
    assert.equal((await request(owner, `/habits/${otherHabit.id}/decorations/1`, "PUT", { islandId: "study", slot: 1 })).status, 404);
    assert.equal((await request(owner, `/habits/${otherHabit.id}/decorations/1`, "DELETE")).status, 404);
    assert.equal((await request(other, `/habits/${otherHabit.id}/decorations/1`, "PUT", { islandId: "study", slot: 1 })).status, 404,
      "another user cannot place an item they do not own");

    await request(owner, purchasePath(2), "POST", { idempotencyKey: "buy-item-2" });
    await request(owner, purchasePath(3), "POST", { idempotencyKey: "buy-item-3" });
    const placementPath = (id) => `/habits/${ownedHabit.id}/decorations/${id}`;
    const firstPlace = await request(owner, placementPath(1), "PUT", { islandId: "beginnings", slot: 1 });
    assert.equal(firstPlace.status, 200);
    const collision = await request(owner, placementPath(2), "PUT", { islandId: "beginnings", slot: 1 });
    assert.equal(collision.status, 409, "a placement never replaces a different item");
    const move = await request(owner, placementPath(1), "PUT", { islandId: "forest", slot: 3 });
    assert.equal(move.status, 200, "same item moves to the requested island and slot");
    const concurrentPlacements = await Promise.all([
      request(owner, placementPath(2), "PUT", { islandId: "beginnings", slot: 0 }),
      request(owner, placementPath(3), "PUT", { islandId: "beginnings", slot: 0 }),
    ]);
    const concurrentStatuses = concurrentPlacements.map((response) => response.status);
    assert.deepEqual([...concurrentStatuses].sort(), [200, 409],
      "concurrent placements into one slot serialize and return one collision");
    const concurrentWinnerId = concurrentStatuses[0] === 200 ? 2 : 3;
    assert.equal((await request(owner, placementPath(concurrentWinnerId), "DELETE")).status, 204);
    const listed = await request(owner, `/habits/${ownedHabit.id}/decorations`);
    assert.deepEqual((await listed.json()).placements, [{
      decorationId: 1, islandId: "forest", slot: 3, name: "عصفور أصفر",
      assetFile: "component-a-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.webp",
    }]);
    const walletBeforeRemove = (await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [owner])).rows[0].coins;
    const transactionsBeforeRemove = (await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1`, [owner])).rows[0].count;
    assert.equal((await request(owner, placementPath(1), "DELETE")).status, 204);
    assert.equal((await request(owner, placementPath(1), "DELETE")).status, 204, "remove is idempotent");
    assert.deepEqual((await (await request(owner, `/habits/${ownedHabit.id}/decorations`)).json()).placements, []);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("user_decorations")} WHERE user_id=$1 AND item_id=1`, [owner])).rows[0].count, 1,
      "removing placement preserves global ownership");
    assert.equal((await adminPool.query(`SELECT coins FROM ${quote("users")} WHERE id=$1`, [owner])).rows[0].coins, walletBeforeRemove);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1`, [owner])).rows[0].count, transactionsBeforeRemove);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("rewards")} WHERE user_id=$1`, [owner])).rows[0].count, 1);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1 AND reason='reward_redemption'`, [owner])).rows[0].count, 0,
      "decoration purchasing and placement do not mutate rewards");
    const ownedIdsBeforeSeed = (await adminPool.query(
      `SELECT item_id FROM ${quote("user_decorations")} WHERE user_id=$1 ORDER BY item_id`, [owner],
    )).rows.map((row) => row.item_id);
    await adminPool.query(`UPDATE ${quote("decoration_items")} SET coin_cost=77 WHERE id=1`);
    await seedCatalogs();
    assert.equal((await adminPool.query(`SELECT coin_cost FROM ${quote("decoration_items")} WHERE id=1`)).rows[0].coin_cost, 77,
      "startup reseeding preserves an existing item price");
    assert.deepEqual((await adminPool.query(
      `SELECT item_id FROM ${quote("user_decorations")} WHERE user_id=$1 ORDER BY item_id`, [owner],
    )).rows.map((row) => row.item_id), ownedIdsBeforeSeed, "startup reseeding preserves owned item IDs");
  } finally {
    await cleanup();
  }
});