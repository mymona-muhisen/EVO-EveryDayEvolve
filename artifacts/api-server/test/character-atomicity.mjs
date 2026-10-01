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
    "PostgreSQL character integration tests require API_TEST_DATABASE_URL, TEST_DATABASE_URL, or DATABASE_URL.",
  );
}

const schema = `api_character_it_${randomUUID().replaceAll("-", "")}`;
const quote = (name) => `"${schema}"."${name}"`;
const scopedUrl = new URL(databaseUrl);
const currentOptions = scopedUrl.searchParams.get("options");
scopedUrl.searchParams.set(
  "options",
  [currentOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
);
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = scopedUrl.toString();

const dbRequire = createRequire(join(dbDir, "package.json"));
const { Pool } = dbRequire("pg");
const pgEntry = dbRequire.resolve("pg");
const adminPool = new Pool({ connectionString: databaseUrl });
let servicePool;
let tempDir;
let server;

const ddl = [
  `CREATE SCHEMA "${schema}"`,
  `CREATE TYPE ${quote("motivation_style")} AS ENUM ('encouraging', 'tough_love', 'data_driven')`,
  `CREATE TYPE ${quote("goal_category")} AS ENUM ('health', 'learning', 'productivity', 'mindfulness', 'social', 'creativity', 'finance', 'custom')`,
  `CREATE TYPE ${quote("coin_transaction_reason")} AS ENUM ('checkin', 'streak_bonus', 'streak_recovery', 'reward_redemption', 'item_purchase', 'challenge_bonus', 'manual')`,
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
  `CREATE TABLE ${quote("character_items")} (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    slot ${quote("character_item_slot")} NOT NULL,
    emoji text NOT NULL,
    coin_cost integer NOT NULL CHECK (coin_cost >= 0),
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
  `CREATE TABLE ${quote("coin_transactions")} (
    id serial PRIMARY KEY,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    amount integer NOT NULL,
    reason ${quote("coin_transaction_reason")} NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ${quote("checkins")} (
    id serial PRIMARY KEY,
    habit_id integer NOT NULL,
    user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
    date date NOT NULL,
    completed boolean NOT NULL,
    reward_granted boolean NOT NULL DEFAULT false,
    coins_earned integer NOT NULL DEFAULT 0,
    xp_earned integer
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
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (servicePool) await servicePool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
}

async function prepare() {
  for (const statement of ddl) await adminPool.query(statement);

  tempDir = await mkdtemp(join(apiDir, ".character-test-"));
  const testEntry = join(tempDir, "character-test-entry.ts");
  const serviceBundle = join(tempDir, "character-test-entry.mjs");
  await writeFile(
    testEntry,
    `
      export { default as characterRouter } from ${JSON.stringify(join(apiDir, "src/routes/character.ts"))};
      export { applyXp, getLevelFromXP, getXpForNextLevel, getLevelProgress, getTotalXp } from ${JSON.stringify(join(apiDir, "src/lib/rules.ts"))};
      export { pool } from "@workspace/db";
    `,
  );

  const adapterPlugin = {
    name: "isolated-character-schema",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
        path: "isolated-db",
        namespace: "isolated-db",
      }));
      esbuild.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
        path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
      }));
      esbuild.onResolve({ filter: /^@clerk\/express$/ }, () => ({
        path: "isolated-clerk",
        namespace: "isolated-clerk",
      }));
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
    plugins: [adapterPlugin],
    logLevel: "silent",
  });

  const module = await import(pathToFileURL(serviceBundle).href);
  servicePool = module.pool;
  for (const functionName of ["applyXp", "getLevelFromXP", "getXpForNextLevel", "getLevelProgress", "getTotalXp"]) {
    if (typeof module[functionName] !== "function") {
      throw new Error(`Production rules must export ${functionName}.`);
    }
  }

  const app = express();
  app.use(express.json());
  app.use(module.characterRouter);
  app.use((_error, _req, res, _next) => res.status(500).json({ error: "Internal test error" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (userId, path, method = "GET", body) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": userId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, rules: module };
}

let api;
try {
  api = await prepare();
} catch (error) {
  await cleanup();
  throw error;
}
test.after(cleanup);

async function seedUser({ id = `character-it-${randomUUID()}`, coins = 0, level = 1, xp = 0 } = {}) {
  await adminPool.query(
    `INSERT INTO ${quote("users")} (id, display_name, coins, level, xp)
     VALUES ($1, 'Character atomicity fixture', $2, $3, $4)`,
    [id, coins, level, xp],
  );
  return id;
}

async function seedItem({ name, slot = "hat", cost = 0, levelRequired = 0 }) {
  const result = await adminPool.query(
    `INSERT INTO ${quote("character_items")} (name, slot, emoji, coin_cost, level_required)
     VALUES ($1, $2, '🧢', $3, $4) RETURNING id`,
    [`character-it-${randomUUID()}-${name}`, slot, cost, levelRequired],
  );
  return result.rows[0].id;
}

async function wallet(userId) {
  const result = await adminPool.query(
    `SELECT coins FROM ${quote("users")} WHERE id = $1`,
    [userId],
  );
  return result.rows[0].coins;
}

async function fixtureCounts(userId) {
  const [ownership, ledger] = await Promise.all([
    adminPool.query(`SELECT count(*)::int AS count FROM ${quote("user_character_items")} WHERE user_id=$1`, [userId]),
    adminPool.query(`SELECT count(*)::int AS count FROM ${quote("coin_transactions")} WHERE user_id=$1`, [userId]),
  ]);
  return { ownership: ownership.rows[0].count, ledger: ledger.rows[0].count };
}

const purchasePath = (itemId) => `/character/items/${itemId}/purchase`;
const equipPath = (itemId) => `/character/items/${itemId}/equip`;
const unequipPath = (itemId) => `/character/items/${itemId}/unequip`;
const purchase = (userId, itemId, body) =>
  api.request(userId, purchasePath(itemId), "POST", body);

test("character purchases serialize, enforce server prices, and roll back every failed write", async () => {
  const sameBuyer = await seedUser({ coins: 50 });
  const item = await seedItem({ name: "same-purchase", cost: 12 });

  const sameItemResponses = await Promise.all([
    purchase(sameBuyer, item),
    purchase(sameBuyer, item),
  ]);
  assert.deepEqual(
    sameItemResponses.map((response) => response.status).sort(),
    [200, 409],
    "concurrent duplicate purchase gives one success and one conflict",
  );
  assert.equal(await wallet(sameBuyer), 38, "the item is charged once");
  assert.deepEqual(await fixtureCounts(sameBuyer), { ownership: 1, ledger: 1 });
  assert.equal((await purchase(sameBuyer, item)).status, 409,
    "a repeated purchase is explicitly rejected as a conflict");

  const constrainedBuyer = await seedUser({ coins: 15 });
  const first = await seedItem({ name: "concurrent-one", cost: 7, slot: "outfit" });
  const second = await seedItem({ name: "concurrent-two", cost: 11, slot: "accessory" });
  const differentItems = await Promise.all([
    purchase(constrainedBuyer, first),
    purchase(constrainedBuyer, second),
  ]);
  assert.deepEqual(
    differentItems.map((response) => response.status).sort((a, b) => a - b),
    [200, 400],
    "one of two concurrent purchases succeeds when the combined cost exceeds the wallet",
  );
  const concurrentCounts = await fixtureCounts(constrainedBuyer);
  assert.deepEqual(concurrentCounts, { ownership: 1, ledger: 1 });
  assert.equal(await wallet(constrainedBuyer), 15 - (differentItems[0].status === 200 ? 7 : 11));

  const poorBuyer = await seedUser({ coins: 3 });
  const pricey = await seedItem({ name: "unaffordable", cost: 9 });
  assert.equal((await purchase(poorBuyer, pricey)).status, 400);
  assert.equal(await wallet(poorBuyer), 3);
  assert.deepEqual(await fixtureCounts(poorBuyer), { ownership: 0, ledger: 0 },
    "insufficient balance creates neither ownership nor a coin transaction");

  const levelLockedBuyer = await seedUser({ coins: 30, level: 1 });
  const levelLocked = await seedItem({ name: "level-locked", cost: 4, levelRequired: 2 });
  assert.equal((await purchase(levelLockedBuyer, levelLocked)).status, 400,
    "a character item above the user's level is rejected");
  assert.equal(await wallet(levelLockedBuyer), 30);
  assert.deepEqual(await fixtureCounts(levelLockedBuyer), { ownership: 0, ledger: 0 },
    "a level lock leaves wallet, ownership, and coin ledger untouched");

  const priceTamperBuyer = await seedUser({ coins: 3 });
  const tamperItem = await seedItem({ name: "price-tamper", cost: 9 });
  const tampered = await purchase(priceTamperBuyer, tamperItem, {
    price: 0,
    coinCost: 0,
    coins: 0,
  });
  assert.equal(tampered.status, 400, "purchase accepts no client-supplied price or amount");
  assert.equal(await wallet(priceTamperBuyer), 3);
  assert.deepEqual(await fixtureCounts(priceTamperBuyer), { ownership: 0, ledger: 0 });

  const ownershipFailBuyer = await seedUser({ coins: 30 });
  const ownershipFailItem = await seedItem({ name: "ownership-trigger-failure", cost: 8 });
  await adminPool.query(`
    CREATE FUNCTION ${quote("reject_character_ownership")}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = '${ownershipFailBuyer}' THEN RAISE EXCEPTION 'forced ownership insert failure'; END IF;
      RETURN NEW;
    END $$`);
  await adminPool.query(`
    CREATE TRIGGER reject_character_ownership BEFORE INSERT ON ${quote("user_character_items")}
    FOR EACH ROW EXECUTE FUNCTION ${quote("reject_character_ownership")}()`);
  try {
    assert.equal((await purchase(ownershipFailBuyer, ownershipFailItem)).status, 500);
  } finally {
    await adminPool.query(`DROP TRIGGER reject_character_ownership ON ${quote("user_character_items")}`);
    await adminPool.query(`DROP FUNCTION ${quote("reject_character_ownership")}()`);
  }
  assert.equal(await wallet(ownershipFailBuyer), 30, "ownership insert failure restores the wallet");
  assert.deepEqual(await fixtureCounts(ownershipFailBuyer), { ownership: 0, ledger: 0 });

  const ledgerFailBuyer = await seedUser({ coins: 30 });
  const ledgerFailItem = await seedItem({ name: "ledger-trigger-failure", cost: 8 });
  await adminPool.query(`
    CREATE FUNCTION ${quote("reject_character_ledger")}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = '${ledgerFailBuyer}' AND NEW.reason = 'item_purchase' THEN
        RAISE EXCEPTION 'forced ledger insert failure';
      END IF;
      RETURN NEW;
    END $$`);
  await adminPool.query(`
    CREATE TRIGGER reject_character_ledger BEFORE INSERT ON ${quote("coin_transactions")}
    FOR EACH ROW EXECUTE FUNCTION ${quote("reject_character_ledger")}()`);
  try {
    assert.equal((await purchase(ledgerFailBuyer, ledgerFailItem)).status, 500);
  } finally {
    await adminPool.query(`DROP TRIGGER reject_character_ledger ON ${quote("coin_transactions")}`);
    await adminPool.query(`DROP FUNCTION ${quote("reject_character_ledger")}()`);
  }
  assert.equal(await wallet(ledgerFailBuyer), 30, "ledger insert failure restores the wallet");
  assert.deepEqual(await fixtureCounts(ledgerFailBuyer), { ownership: 0, ledger: 0 });
});

test("free purchases, owner-scoped inventory, exclusive slots, and unequip are isolated", async () => {
  const owner = await seedUser({ coins: 0 });
  const other = await seedUser({ coins: 20 });
  const freeHat = await seedItem({ name: "free-hat", slot: "hat", cost: 0 });
  const secondHat = await seedItem({ name: "second-hat", slot: "hat", cost: 0 });
  const outfit = await seedItem({ name: "outfit", slot: "outfit", cost: 0 });

  const freePurchase = await purchase(owner, freeHat);
  assert.equal(freePurchase.status, 200, "a free item can be purchased with a zero balance");
  assert.equal(await wallet(owner), 0);
  assert.equal((await purchase(owner, outfit)).status, 200);
  assert.equal((await purchase(owner, secondHat)).status, 200);

  const ownerCatalog = await (await api.request(owner, "/character/catalog")).json();
  const otherCatalog = await (await api.request(other, "/character/catalog")).json();
  assert.equal(ownerCatalog.find((entry) => entry.id === freeHat).owned, true);
  assert.equal(otherCatalog.find((entry) => entry.id === freeHat).owned, false,
    "catalog ownership is scoped to the authenticated user");
  assert.equal((await api.request(other, equipPath(freeHat), "POST")).status, 400,
    "another user cannot equip an item they do not own");
  assert.equal((await api.request(other, unequipPath(freeHat), "POST")).status, 400,
    "another user cannot unequip another user's item");
  assert.equal((await purchase(other, freeHat)).status, 200,
    "the same catalog item can be independently owned by another user");
  assert.equal(await wallet(owner), 0);
  assert.equal(await wallet(other), 20,
    "purchasing a free item under another account does not change either user's wallet");
  assert.equal((await api.request(other, equipPath(freeHat), "POST")).status, 200,
    "the second user can equip their own copy without changing the first user's inventory");

  const firstEquip = await api.request(owner, equipPath(freeHat), "POST");
  assert.equal(firstEquip.status, 200);
  const concurrentEquips = await Promise.all([
    api.request(owner, equipPath(freeHat), "POST"),
    api.request(owner, equipPath(secondHat), "POST"),
  ]);
  assert.deepEqual(concurrentEquips.map((response) => response.status), [200, 200]);
  const equipped = await adminPool.query(
    `SELECT item_id FROM ${quote("user_character_items")}
     WHERE user_id=$1 AND equipped=true ORDER BY item_id`,
    [owner],
  );
  assert.equal(equipped.rows.length, 1,
    "concurrent equips in one slot leave exactly one equipped item");
  assert.ok([freeHat, secondHat].includes(equipped.rows[0].item_id));

  assert.equal((await api.request(owner, equipPath(outfit), "POST")).status, 200);
  const afterDifferentSlot = await adminPool.query(
    `SELECT ci.slot, count(*)::int AS count
     FROM ${quote("user_character_items")} uci
     JOIN ${quote("character_items")} ci ON ci.id=uci.item_id
     WHERE uci.user_id=$1 AND uci.equipped=true GROUP BY ci.slot ORDER BY ci.slot`,
    [owner],
  );
  assert.deepEqual(
    Object.fromEntries(afterDifferentSlot.rows.map((row) => [row.slot, row.count])),
    { hat: 1, outfit: 1 },
    "equipping one slot preserves the equipped item in a different slot",
  );

  const myCharacter = await (await api.request(owner, "/character/me")).json();
  assert.deepEqual(
    myCharacter.equippedItems.map((entry) => entry.id).sort((a, b) => a - b),
    [equipped.rows[0].item_id, outfit].sort((a, b) => a - b),
    "character loadout reflects only this user's equipped items",
  );
  const unequipped = await api.request(owner, unequipPath(equipped.rows[0].item_id), "POST");
  assert.equal(unequipped.status, 200, "unequip uses the documented POST endpoint");
  assert.equal((await unequipped.json()).equipped, false);
  const afterUnequip = await adminPool.query(
    `SELECT ci.slot FROM ${quote("user_character_items")} uci
     JOIN ${quote("character_items")} ci ON ci.id=uci.item_id
     WHERE uci.user_id=$1 AND uci.equipped=true`,
    [owner],
  );
  assert.deepEqual(afterUnequip.rows.map((row) => row.slot), ["outfit"],
    "unequip removes only the selected item and preserves other slots");
  assert.equal(await wallet(owner), 0, "equip/unequip never changes the wallet");
});

test("level helpers use shared cumulative thresholds and preserve lifetime XP across rollovers", async () => {
  const { applyXp, getLevelFromXP, getXpForNextLevel, getLevelProgress, getTotalXp } = api.rules;
  let cumulative = 0;
  for (let level = 1; level <= 6; level += 1) {
    const threshold = getXpForNextLevel(level);
    assert.ok(Number.isInteger(threshold) && threshold > 0);
    if (level > 1) {
      assert.equal(getLevelFromXP(cumulative - 1), level - 1,
        `XP immediately below level ${level} stays at the prior level`);
      assert.equal(getLevelFromXP(cumulative), level,
        `the exact level ${level} threshold rolls over once`);
    } else {
      assert.equal(getLevelFromXP(0), 1);
    }
    cumulative += threshold;
  }

  const levelSixStartXp = cumulative - getXpForNextLevel(6);
  const progress = getLevelProgress(6, 7);
  assert.equal(progress.nextLevelXp, getXpForNextLevel(6));
  assert.ok(progress.progressPercent > 0 && progress.progressPercent < 100);
  const beforeRolloverTotal = getTotalXp(5, getXpForNextLevel(5) - 3);
  const rolled = applyXp(5, getXpForNextLevel(5) - 3, 10);
  assert.deepEqual(rolled, { level: 6, xp: 7, leveledUp: true });
  const afterRolloverTotal = getTotalXp(rolled.level, rolled.xp);
  assert.equal(afterRolloverTotal, beforeRolloverTotal + 10,
    "rolling over a level preserves an equivalent, monotonically increasing lifetime XP total");
  assert.equal(getLevelFromXP(afterRolloverTotal), rolled.level,
    "the cumulative-XP helper agrees with stored level plus rollover XP");
  assert.equal(getTotalXp(6, 7), levelSixStartXp + 7);

  const user = await seedUser({ coins: 0, level: 6, xp: 7 });
  const before = await (await api.request(user, "/character/me")).json();
  assert.equal(before.level, 6);
  assert.equal(before.xp, 7);
  assert.equal(before.totalXp, getTotalXp(6, 7),
    "character response reports the cumulative XP equivalent without seeding historical check-ins");
  assert.equal(before.xpToNextLevel, getXpForNextLevel(6));
  assert.equal(before.nextLevelXp, getXpForNextLevel(6));
  assert.equal(before.progressPercent, progress.progressPercent);
  assert.equal(before.walletCoins, 0);
  assert.deepEqual(before.recentProgress, []);
});