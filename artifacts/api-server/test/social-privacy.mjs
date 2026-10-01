import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryDir = resolve(apiDir, "../..");
const dbDir = resolve(repositoryDir, "lib/db");
const databaseUrl = process.env.API_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  test("social privacy helpers (isolated PostgreSQL schema)", { skip: "No test database configured" }, () => {});
} else {
  const schema = `api_social_it_${randomUUID().replaceAll("-", "")}`;
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
  process.env.PRIVATE_OBJECT_DIR = "/social-test/private";

  const dbRequire = createRequire(join(dbDir, "package.json"));
  const { Pool } = dbRequire("pg");
  const adminPool = new Pool({ connectionString: databaseUrl });
  const servicePools = [];
  let tempDir;
  let social;
  let storageObjects;
  let server;
  let baseUrl;

  const ddl = [
    `CREATE SCHEMA "${schema}"`,
    `CREATE TYPE ${quote("social_resource_type")} AS ENUM ('journey', 'memory', 'reward', 'character', 'achievements')`,
    `CREATE TYPE ${quote("social_sharing_visibility")} AS ENUM ('private', 'friends', 'selected')`,
    `CREATE TYPE ${quote("social_activity_type")} AS ENUM ('successful_day', 'milestone', 'journey_completed')`,
    `CREATE TYPE ${quote("social_friend_request_status")} AS ENUM ('pending', 'accepted', 'declined', 'canceled')`,
    `CREATE TYPE ${quote("social_group_activity_type")} AS ENUM ('member_joined', 'successful_day', 'milestone', 'journey_completed')`,
    `CREATE TYPE ${quote("social_group_invitation_status")} AS ENUM ('pending', 'accepted', 'declined', 'canceled')`,
    `CREATE TYPE ${quote("social_challenge_status")} AS ENUM ('active', 'closed')`,
    `CREATE TYPE ${quote("social_challenge_member_status")} AS ENUM ('invited', 'accepted', 'declined', 'left')`,
    `CREATE TYPE ${quote("group_privacy")} AS ENUM ('invite_only')`,
    `CREATE TYPE ${quote("group_member_role")} AS ENUM ('owner', 'member')`,
    `CREATE TYPE ${quote("social_report_reason")} AS ENUM ('spam', 'inappropriate_content', 'harassment', 'other')`,
    `CREATE TYPE ${quote("social_report_status")} AS ENUM ('open', 'reviewed', 'closed')`,
    `CREATE TYPE ${quote("social_encouragement_type")} AS ENUM ('cheer', 'clap', 'fire', 'support')`,
    `CREATE TYPE ${quote("social_encouragement_template")} AS ENUM ('nice_work', 'keep_going', 'great_job', 'you_got_this', 'keep_moving')`,
    `CREATE TYPE ${quote("social_notification_type")} AS ENUM ('friend_request_received', 'friend_request_accepted', 'challenge_invitation', 'challenge_accepted', 'challenge_declined', 'group_invitation', 'group_member_joined', 'encouragement_received', 'shared_milestone', 'group_milestone')`,
    `CREATE TYPE ${quote("memory_visibility")} AS ENUM ('private', 'friends', 'selected', 'public')`,
    `CREATE TABLE ${quote("users")} (
      id text PRIMARY KEY, username text UNIQUE, display_name text NOT NULL,
      avatar_emoji text NOT NULL DEFAULT '🌱', level integer NOT NULL DEFAULT 1,
      xp integer NOT NULL DEFAULT 0, coins integer NOT NULL DEFAULT 0,
      motivation_style text NOT NULL DEFAULT 'encouraging', primary_goal_category text,
      onboarding_completed boolean NOT NULL DEFAULT false, timezone text NOT NULL DEFAULT 'UTC',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("habits")} (
      id integer PRIMARY KEY, user_id text NOT NULL, journey_length integer,
      journey_start_date date, journey_completed_at timestamptz
    )`,
    `CREATE TABLE ${quote("habit_days")} (
      id serial PRIMARY KEY, habit_id integer NOT NULL, day_number integer NOT NULL,
      date date NOT NULL, scheduled boolean NOT NULL DEFAULT true
    )`,
    `CREATE TABLE ${quote("checkins")} (
      id serial PRIMARY KEY, habit_id integer NOT NULL, user_id text NOT NULL,
      date date NOT NULL, completed boolean NOT NULL
    )`,
    `CREATE TABLE ${quote("memories")} (
      id serial PRIMARY KEY, user_id text NOT NULL, habit_id integer, habit_day_id integer,
      note text NOT NULL, caption text, visibility ${quote("memory_visibility")} NOT NULL DEFAULT 'private',
      photo_object_path text, date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("journey_rewards")} (id integer PRIMARY KEY, user_id text NOT NULL)`,
    `CREATE TABLE ${quote("rewards")} (id integer PRIMARY KEY, user_id text NOT NULL)`,
    `CREATE TABLE ${quote("social_blocks")} (
      id serial PRIMARY KEY, blocker_user_id text NOT NULL, blocked_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(blocker_user_id, blocked_user_id)
    )`,
    `CREATE TABLE ${quote("social_friendships")} (
      id serial PRIMARY KEY, user_low_id text NOT NULL, user_high_id text NOT NULL,
      created_from_request_id integer, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_low_id, user_high_id)
    )`,
    `CREATE TABLE ${quote("social_friend_requests")} (
      id serial PRIMARY KEY, sender_user_id text NOT NULL, recipient_user_id text NOT NULL,
      pair_user_low_id text NOT NULL, pair_user_high_id text NOT NULL,
      status ${quote("social_friend_request_status")} NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz
    )`,
    `CREATE TABLE ${quote("groups")} (
      id serial PRIMARY KEY, name text NOT NULL, invite_code text NOT NULL UNIQUE,
      goal_description text NOT NULL, description text,
      privacy ${quote("group_privacy")} NOT NULL DEFAULT 'invite_only',
      max_members integer NOT NULL DEFAULT 30, cover_object_path text, cover_updated_at timestamptz,
      start_date date NOT NULL, end_date date, created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("group_members")} (
      id serial PRIMARY KEY, group_id integer NOT NULL, user_id text NOT NULL,
      role ${quote("group_member_role")} NOT NULL DEFAULT 'member',
      joined_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id, user_id)
    )`,
    `CREATE TABLE ${quote("group_reactions")} (
      id serial PRIMARY KEY, group_id integer NOT NULL, from_user_id text NOT NULL, to_user_id text,
      emoji text NOT NULL, template_code text, message text, request_id text, cooldown_bucket timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("social_group_journey_shares")} (
      id serial PRIMARY KEY, group_id integer NOT NULL, user_id text NOT NULL, habit_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id, user_id, habit_id)
    )`,
    `CREATE TABLE ${quote("social_group_activity_events")} (
      id serial PRIMARY KEY, group_id integer NOT NULL, actor_user_id text NOT NULL,
      event_type ${quote("social_group_activity_type")} NOT NULL, journey_id integer,
      idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(group_id, idempotency_key)
    )`,
    `CREATE TABLE ${quote("social_group_invitations")} (
      id serial PRIMARY KEY, group_id integer NOT NULL, inviter_user_id text NOT NULL,
      invitee_user_id text NOT NULL, status ${quote("social_group_invitation_status")} NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz
    )`,
    `CREATE TABLE ${quote("social_challenges")} (
      id serial PRIMARY KEY, creator_user_id text NOT NULL,
      status ${quote("social_challenge_status")} NOT NULL DEFAULT 'active'
    )`,
    `CREATE TABLE ${quote("social_challenge_members")} (
      id serial PRIMARY KEY, challenge_id integer NOT NULL, user_id text NOT NULL,
      status ${quote("social_challenge_member_status")} NOT NULL DEFAULT 'invited'
    )`,
    `CREATE TABLE ${quote("social_shares")} (
      id serial PRIMARY KEY, owner_user_id text NOT NULL, resource_type ${quote("social_resource_type")} NOT NULL,
      resource_id text NOT NULL, visibility ${quote("social_sharing_visibility")} NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id, resource_type, resource_id)
    )`,
    `CREATE TABLE ${quote("social_share_recipients")} (
      id serial PRIMARY KEY, share_id integer NOT NULL, recipient_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(share_id, recipient_user_id)
    )`,
    `CREATE TABLE ${quote("social_activity_events")} (
      id serial PRIMARY KEY, actor_user_id text NOT NULL, event_type ${quote("social_activity_type")} NOT NULL,
      journey_id integer, idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(actor_user_id, idempotency_key)
    )`,
    `CREATE TABLE ${quote("social_notifications")} (
      id serial PRIMARY KEY, recipient_user_id text NOT NULL REFERENCES ${quote("users")}(id),
      actor_user_id text REFERENCES ${quote("users")}(id),
      type ${quote("social_notification_type")} NOT NULL, event_key text NOT NULL,
      friend_request_id integer, group_invitation_id integer, group_id integer, challenge_id integer,
      encouragement_id integer, safe_data jsonb, read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(recipient_user_id, event_key)
    )`,
    `CREATE TABLE ${quote("social_reports")} (
      id serial PRIMARY KEY, reporter_user_id text NOT NULL, reported_user_id text NOT NULL,
      reason ${quote("social_report_reason")} NOT NULL, details text,
      status ${quote("social_report_status")} NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE ${quote("social_encouragements")} (
      id serial PRIMARY KEY, sender_user_id text NOT NULL, receiver_user_id text NOT NULL,
      journey_id integer, type ${quote("social_encouragement_type")} NOT NULL,
      template ${quote("social_encouragement_template")} NOT NULL, message text,
      request_id text NOT NULL, cooldown_bucket timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(sender_user_id, request_id),
      UNIQUE(sender_user_id, receiver_user_id, cooldown_bucket)
    )`,
  ];

  async function seedRouteUsers() {
    await adminPool.query(
      `INSERT INTO ${quote("users")} (id, username, display_name, avatar_emoji)
       VALUES
         ('owner', 'owner_name', 'Owner', '🌱'),
         ('friend', 'friend_name', 'Friend', '🌿'),
         ('stranger', 'stranger_name', 'Stranger', '🌻')`,
    );
  }

  async function requestAs(userId, method, path, body) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(userId ? { "x-test-user": userId } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function resetRouteData() {
    await adminPool.query(`TRUNCATE
      ${quote("social_notifications")}, ${quote("social_friend_requests")},
      ${quote("social_friendships")}, ${quote("social_blocks")},
      ${quote("social_share_recipients")}, ${quote("social_shares")},
      ${quote("social_activity_events")}, ${quote("social_group_activity_events")},
      ${quote("social_group_journey_shares")}, ${quote("social_group_invitations")},
      ${quote("social_challenge_members")}, ${quote("social_challenges")},
      ${quote("group_reactions")}, ${quote("group_members")}, ${quote("groups")},
      ${quote("social_reports")}, ${quote("social_encouragements")},
      ${quote("memories")}, ${quote("checkins")}, ${quote("habit_days")},
      ${quote("journey_rewards")}, ${quote("rewards")}, ${quote("habits")},
      ${quote("users")} RESTART IDENTITY`);
    await seedRouteUsers();
    await adminPool.query(
      `INSERT INTO ${quote("habits")} (id, user_id, journey_length, journey_start_date)
       VALUES (41, 'owner', 22, '2025-01-01')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("journey_rewards")} (id, user_id) VALUES (51, 'owner')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("rewards")} (id, user_id) VALUES (999, 'owner')`,
    );
    storageObjects.clear();
  }

  async function waitForPairLockWaiters(expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await adminPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%for%update%'`,
      );
      if (result.rows[0].n >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Expected ${expected} social mutations to queue on the pair lock`);
  }

  before(async () => {
    for (const statement of ddl) await adminPool.query(statement);
    tempDir = await mkdtemp(join(apiDir, ".social-test-"));
    const bundle = join(tempDir, "social-routes.mjs");
    const entry = join(tempDir, "social-common-entry.ts");
    const socialCommonPath = join(apiDir, "src/services/social-common.ts");
    const socialRoutePath = join(apiDir, "src/routes/social-friends.ts");
    await writeFile(entry, `
      export * from ${JSON.stringify(socialCommonPath)};
      export { db, pool } from "@workspace/db";
      export { default as router } from ${JSON.stringify(socialRoutePath)};
      export { journeySummary } from ${JSON.stringify(socialRoutePath)};
      export { socialStorageObjects } from "@google-cloud/storage";
    `);
    const adapterPlugin = {
      name: "isolated-social-postgres",
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: "isolated-social-db",
          namespace: "isolated-social-db",
        }));
        esbuild.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
          path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
        }));
        esbuild.onResolve({ filter: /^pg$/ }, () => ({
          path: dbRequire.resolve("pg"),
          external: true,
        }));
        esbuild.onResolve({ filter: /^@clerk\/express$/ }, () => ({
          path: "isolated-social-clerk",
          namespace: "isolated-social-clerk",
        }));
        esbuild.onResolve({ filter: /^@google-cloud\/storage$/ }, () => ({
          path: "isolated-social-storage",
          namespace: "isolated-social-storage",
        }));
        esbuild.onLoad({ filter: /.*/, namespace: "isolated-social-clerk" }, () => ({
          loader: "js",
          contents: `
            export const getAuth = (req) => ({ userId: req.headers["x-test-user"] ?? null });
            export const clerkClient = {
              users: { getUser: async () => { throw new Error("No Clerk in isolated social test"); } },
            };
          `,
        }));
        esbuild.onLoad({ filter: /.*/, namespace: "isolated-social-storage" }, () => ({
          loader: "js",
          contents: `
            import { Readable } from "node:stream";
            export const socialStorageObjects = new Map();
            class MockFile {
              constructor(key) { this.key = key; this.name = key; }
              async exists() { return [socialStorageObjects.has(this.key)]; }
              async getMetadata() {
                const object = socialStorageObjects.get(this.key);
                if (!object) throw new Error("Mock private object not found");
                return [structuredClone(object.metadata)];
              }
              createReadStream() {
                const object = socialStorageObjects.get(this.key);
                object.readCount = (object.readCount ?? 0) + 1;
                return Readable.from([Buffer.from(object.data)]);
              }
            }
            export class Storage {
              bucket(name) {
                return { file: (objectName) => new MockFile(name + "/" + objectName) };
              }
            }
            export class File {}
          `,
        }));
        esbuild.onLoad({ filter: /.*/, namespace: "isolated-social-db" }, () => ({
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
    social = await import(pathToFileURL(bundle).href);
    servicePools.push(social.pool);
    storageObjects = social.socialStorageObjects;
    const app = express();
    app.use(express.json());
    app.use(social.router);
    server = app.listen(0);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await seedRouteUsers();
    await adminPool.query(
      `INSERT INTO ${quote("habits")} (id, user_id, journey_length, journey_start_date)
       VALUES (41, 'owner', 22, '2025-01-01')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("journey_rewards")} (id, user_id) VALUES (51, 'owner')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("rewards")} (id, user_id) VALUES (999, 'owner')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
       VALUES ('friend', 'owner') ON CONFLICT DO NOTHING`,
    );
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
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

  test("sharing is private by default and selected access requires a current friendship", async () => {
    const journey = {
      ownerUserId: "owner",
      resourceType: "journey",
      resourceId: "41",
    };
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "friend",
      ...journey,
    })), false);
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "owner",
      ...journey,
    })), true);

    await social.db.transaction((tx) => social.setOwnedSocialResourceSharing(tx, {
      ...journey,
      visibility: "selected",
      selectedUserIds: ["friend"],
    }));
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "friend",
      ...journey,
    })), true);
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "stranger",
      ...journey,
    })), false);

    await adminPool.query(`DELETE FROM ${quote("social_friendships")}`);
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "friend",
      ...journey,
    })), false);
  });

  test("either-direction blocks deny resource access and selected ACL writes reject nonfriends", async () => {
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
       VALUES ('friend', 'owner')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_blocks")} (blocker_user_id, blocked_user_id)
       VALUES ('friend', 'owner')`,
    );
    const journey = {
      ownerUserId: "owner",
      resourceType: "journey",
      resourceId: "41",
    };
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "friend",
      ...journey,
    })), false);
    await assert.rejects(
      social.db.transaction((tx) => social.assertNoSocialBlock(tx, "owner", "friend")),
      (error) => error instanceof social.SocialHttpError && error.status === 404,
    );
    await assert.rejects(
      social.db.transaction((tx) => social.setOwnedSocialResourceSharing(tx, {
        ...journey,
        visibility: "selected",
        selectedUserIds: ["friend"],
      })),
      (error) => error instanceof social.SocialHttpError,
    );
    await adminPool.query(`DELETE FROM ${quote("social_blocks")}`);
  });

  test("sharing resolves rewards only through journey_rewards and event writes are idempotent", async () => {
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "owner",
      ownerUserId: "owner",
      resourceType: "reward",
      resourceId: "51",
    })), true);
    assert.equal(await social.db.transaction((tx) => social.canViewSocialResource(tx, {
      viewerUserId: "owner",
      ownerUserId: "owner",
      resourceType: "reward",
      resourceId: "999",
    })), false);

    await social.db.transaction(async (tx) => {
      await social.appendSocialActivityOnce(tx, {
        actorUserId: "owner",
        eventType: "successful_day",
        journeyId: 41,
        idempotencyKey: "successful-day:41:2025-01-01",
      });
      await social.appendSocialActivityOnce(tx, {
        actorUserId: "owner",
        eventType: "successful_day",
        journeyId: 41,
        idempotencyKey: "successful-day:41:2025-01-01",
      });
      await social.insertSocialNotificationOnce(tx, {
        recipientUserId: "friend",
        actorUserId: "owner",
        type: "shared_milestone",
        eventKey: "social-activity:1",
      });
      await social.insertSocialNotificationOnce(tx, {
        recipientUserId: "friend",
        actorUserId: "owner",
        type: "shared_milestone",
        eventKey: "social-activity:1",
      });
    });
    const events = await adminPool.query(`SELECT count(*)::int AS n FROM ${quote("social_activity_events")}`);
    const notifications = await adminPool.query(`SELECT count(*)::int AS n FROM ${quote("social_notifications")}`);
    assert.equal(events.rows[0].n, 1);
    assert.equal(notifications.rows[0].n, 1);
  });

  test("read-only block assertions do not acquire user-row locks", async () => {
    await resetRouteData();
    const held = await adminPool.connect();
    try {
      await held.query("BEGIN");
      await held.query(
        `SELECT id FROM ${quote("users")} WHERE id IN ('owner', 'friend') ORDER BY id FOR UPDATE`,
      );
      let completed = false;
      const assertion = social.db.transaction((tx) =>
        social.assertNoSocialBlock(tx, "owner", "friend")).then(() => {
        completed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(completed, true, "read guards must not wait on pair locks");
      await assertion;
    } finally {
      await held.query("ROLLBACK").catch(() => {});
      held.release();
    }
  });

  test("isolated HTTP friend, notification, block, report, encouragement, group-ACL, and photo flows", async () => {
    await resetRouteData();
    assert.equal((await requestAs(null, "GET", "/social/me")).status, 401);

    const requestResponse = await requestAs("friend", "POST", "/social/friend-requests", {
      recipientUserId: "owner",
    });
    assert.equal(requestResponse.status, 201);
    const request = await requestResponse.json();
    const incoming = await (await requestAs("owner", "GET", "/social/friend-requests/incoming")).json();
    assert.equal(incoming.length, 1);
    const pendingNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.equal(pendingNotifications[0].type, "friend_request_received");
    assert.equal(pendingNotifications[0].actor.id, "friend");
    assert.equal("email" in pendingNotifications[0].actor, false);
    assert.deepEqual(await (await requestAs("stranger", "GET", "/social/notifications")).json(), []);

    const accepted = await requestAs("owner", "POST", `/social/friend-requests/${request.id}/respond`, {
      decision: "accept",
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, "accepted");
    assert.equal((await requestAs("owner", "DELETE", "/social/friends/friend")).status, 204);

    const reportResponse = await requestAs("stranger", "POST", "/social/reports", {
      reportedUserId: "friend",
      reason: "spam",
      details: "Repeated unsolicited messages",
    });
    assert.equal(reportResponse.status, 201);
    assert.equal((await reportResponse.json()).status, "open");
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS n FROM ${quote("social_reports")} WHERE reporter_user_id = 'stranger'`,
    )).rows[0].n, 1);

    const reRequestResponse = await requestAs("friend", "POST", "/social/friend-requests", {
      recipientUserId: "owner",
    });
    assert.equal(reRequestResponse.status, 201);
    const reRequest = await reRequestResponse.json();
    assert.equal((await requestAs("owner", "POST", `/social/friend-requests/${reRequest.id}/respond`, {
      decision: "accept",
    })).status, 200);

    assert.equal((await requestAs("owner", "PATCH", "/social/sharing/journey/41", {
      visibility: "friends",
    })).status, 200);
    const encouragement = {
      receiverUserId: "owner",
      journeyId: 41,
      type: "cheer",
      template: "nice_work",
      message: "Keep going!",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const encouragementResponse = await requestAs("friend", "POST", "/social/encouragements", encouragement);
    assert.equal(encouragementResponse.status, 201);
    const sentEncouragement = await encouragementResponse.json();
    assert.equal("email" in sentEncouragement.sender, false);
    assert.equal("coins" in sentEncouragement.sender, false);
    const replay = await requestAs("friend", "POST", "/social/encouragements", encouragement);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).id, sentEncouragement.id);
    const cooldown = await requestAs("friend", "POST", "/social/encouragements", {
      ...encouragement,
      requestId: "223e4567-e89b-42d3-a456-426614174000",
    });
    assert.equal(cooldown.status, 409);
    const encouragementNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.ok(encouragementNotifications.some((item) =>
      item.type === "encouragement_received"
      && item.actor.id === "friend"
      && item.encouragementId === sentEncouragement.id
      && item.encouragementTemplate === "nice_work"
      && item.encouragementMessage === "Keep going!"));
    assert.equal((await requestAs("owner", "DELETE", "/social/friends/friend")).status, 204);
    const revokedNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.equal(revokedNotifications.some((item) =>
      item.encouragementId === sentEncouragement.id
      || item.encouragementMessage === "Keep going!"), false);
    const renewedRequestResponse = await requestAs("friend", "POST", "/social/friend-requests", {
      recipientUserId: "owner",
    });
    assert.equal(renewedRequestResponse.status, 201);
    const renewedRequest = await renewedRequestResponse.json();
    assert.equal((await requestAs("owner", "POST", `/social/friend-requests/${renewedRequest.id}/respond`, {
      decision: "accept",
    })).status, 200);

    await adminPool.query(
      `INSERT INTO ${quote("groups")} (id, name, invite_code, goal_description, start_date, created_by)
       VALUES (7, 'Small group', 'INVITE7', 'A group goal', CURRENT_DATE, 'owner')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("group_members")} (group_id, user_id, role)
       VALUES (7, 'owner', 'owner'), (7, 'friend', 'member')`,
    );
    const [reaction] = (await adminPool.query(
      `INSERT INTO ${quote("group_reactions")} (group_id, from_user_id, emoji, request_id)
       VALUES (7, 'friend', '👏', 'group-cheer') RETURNING id`,
    )).rows;
    await adminPool.query(
      `INSERT INTO ${quote("social_notifications")}
       (recipient_user_id, actor_user_id, type, event_key, group_id, safe_data)
       VALUES ('owner', 'friend', 'encouragement_received', $1, 7, $2::jsonb)`,
      [`group-encouragement:${reaction.id}`, JSON.stringify({ groupReactionId: reaction.id })],
    );
    await adminPool.query(
      `INSERT INTO ${quote("habits")} (id, user_id, journey_length, journey_start_date)
       VALUES (42, 'friend', 22, '2025-01-01')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_group_journey_shares")} (group_id, user_id, habit_id)
       VALUES (7, 'friend', 42)`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_group_activity_events")}
       (group_id, actor_user_id, event_type, journey_id, idempotency_key)
       VALUES (7, 'friend', 'milestone', 42, 'milestone:42:5')`,
    );
    await adminPool.query(
      `INSERT INTO ${quote("social_notifications")}
       (recipient_user_id, actor_user_id, type, event_key, group_id)
       VALUES ('owner', 'friend', 'group_milestone', 'group-progress:7:milestone:42:5', 7)`,
    );
    const groupNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.ok(groupNotifications.some((item) => item.type === "encouragement_received" && item.groupId === 7));
    assert.ok(groupNotifications.some((item) => item.type === "group_milestone" && item.groupId === 7));
    await adminPool.query(
      `DELETE FROM ${quote("group_members")} WHERE group_id = 7 AND user_id = 'friend'`,
    );
    const staleMembershipNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.equal(staleMembershipNotifications.some((item) =>
      item.type === "encouragement_received" && item.groupId === 7), false);
    await adminPool.query(
      `INSERT INTO ${quote("group_members")} (group_id, user_id, role)
       VALUES (7, 'friend', 'member')`,
    );
    await adminPool.query(`DELETE FROM ${quote("social_group_journey_shares")} WHERE group_id = 7`);
    const staleGroupNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.equal(staleGroupNotifications.some((item) => item.type === "group_milestone"), false);
    await adminPool.query(
      `INSERT INTO ${quote("social_group_journey_shares")} (group_id, user_id, habit_id)
       VALUES (7, 'friend', 42)`,
    );

    const today = new Date().toISOString().slice(0, 10);
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")} (habit_id, day_number, date, scheduled)
       VALUES (41, 1, $1, true)`,
      [today],
    );
    await adminPool.query(
      `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed)
       VALUES (41, 'owner', $1, true)`,
      [today],
    );
    const beforeShareActivity = await requestAs("friend", "GET", "/social/activity");
    assert.equal(beforeShareActivity.status, 200);
    assert.deepEqual(await beforeShareActivity.json(), []);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS n FROM ${quote("social_activity_events")} WHERE actor_user_id = 'owner'`,
    )).rows[0].n, 0);
    assert.equal((await requestAs("owner", "PATCH", "/social/sharing/journey/41", {
      visibility: "friends",
    })).status, 200);
    assert.deepEqual(await (await requestAs("friend", "GET", "/social/activity")).json(), []);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS n FROM ${quote("social_activity_events")} WHERE actor_user_id = 'owner'`,
    )).rows[0].n, 0);

    const photoPath = "/objects/memory-images/private-photo.webp";
    await adminPool.query(
      `INSERT INTO ${quote("memories")} (id, user_id, note, caption, photo_object_path, date)
       VALUES (81, 'owner', 'private note', 'shared caption', $1, CURRENT_DATE)`,
      [photoPath],
    );
    const privateImage = Buffer.from("social-private-image");
    storageObjects.set("social-test/private/memory-images/private-photo.webp", {
      data: privateImage,
      metadata: {
        contentType: "image/webp",
        size: String(privateImage.length),
        metadata: { "custom:aclPolicy": JSON.stringify({ owner: "owner", visibility: "private" }) },
      },
    });
    assert.equal((await requestAs("owner", "PATCH", "/social/sharing/memory/81", {
      visibility: "selected",
      selectedUserIds: ["friend"],
    })).status, 200);
    const sharedPhoto = await requestAs("friend", "GET", "/social/memories/81/photo");
    assert.equal(sharedPhoto.status, 200);
    assert.equal(sharedPhoto.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await sharedPhoto.arrayBuffer()), privateImage);

    assert.equal((await requestAs("owner", "POST", "/social/blocks", {
      blockedUserId: "friend",
    })).status, 201);
    const blockedNotifications = await (await requestAs("owner", "GET", "/social/notifications")).json();
    assert.equal(blockedNotifications.some((item) =>
      item.encouragementId === sentEncouragement.id
      || item.encouragementMessage === "Keep going!"), false);
    assert.equal((await requestAs("friend", "GET", "/social/memories/81/photo")).status, 404);
    assert.equal((await adminPool.query(
      `SELECT count(*)::int AS n FROM ${quote("social_share_recipients")}`,
    )).rows[0].n, 0);
    assert.equal((await requestAs("friend", "POST", "/social/encouragements", {
      ...encouragement,
      requestId: "323e4567-e89b-42d3-a456-426614174000",
    })).status, 404);
    assert.equal((await requestAs("owner", "DELETE", "/social/blocks/friend")).status, 204);
    const requestAfterUnblock = await requestAs("friend", "POST", "/social/friend-requests", {
      recipientUserId: "owner",
    });
    assert.equal(requestAfterUnblock.status, 201);
    const requestAfterUnblockBody = await requestAfterUnblock.json();
    assert.equal((await requestAs("owner", "POST", `/social/friend-requests/${requestAfterUnblockBody.id}/respond`, {
      decision: "accept",
    })).status, 200);
    assert.equal((await requestAs("friend", "GET", "/social/memories/81/photo")).status, 404);
    assert.equal((await requestAs("owner", "PATCH", "/social/sharing/memory/81", {
      visibility: "selected",
      selectedUserIds: ["friend"],
    })).status, 200);
    assert.equal((await requestAs("friend", "GET", "/social/memories/81/photo")).status, 200);
  });

  test("journey consistency counts only elapsed scheduled successes and is null before the first scheduled day", async () => {
    await resetRouteData();
    const today = new Date().toISOString().slice(0, 10);
    const shiftDay = (date, amount) => {
      const shifted = new Date(`${date}T00:00:00.000Z`);
      shifted.setUTCDate(shifted.getUTCDate() + amount);
      return shifted.toISOString().slice(0, 10);
    };
    const yesterday = shiftDay(today, -1);
    const restDay = shiftDay(today, -2);
    const tomorrow = shiftDay(today, 1);
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")} (habit_id, day_number, date, scheduled)
       VALUES (41, 1, $1, true), (41, 2, $2, true), (41, 3, $3, true), (41, 4, $4, false)`,
      [yesterday, today, tomorrow, restDay],
    );
    await adminPool.query(
      `INSERT INTO ${quote("checkins")} (habit_id, user_id, date, completed)
       VALUES (41, 'owner', $1, true), (41, 'owner', $2, true), (41, 'owner', $3, true),
              (41, 'owner', $4, true)`,
      [yesterday, tomorrow, today, restDay],
    );
    await adminPool.query(
      `INSERT INTO ${quote("habits")} (id, user_id, journey_length, journey_start_date)
       VALUES (43, 'owner', 22, $1)`,
      [tomorrow],
    );
    await adminPool.query(
      `INSERT INTO ${quote("habit_days")} (habit_id, day_number, date, scheduled)
       VALUES (43, 1, $1, true)`,
      [tomorrow],
    );
    const summary = await social.db.transaction((tx) => social.journeySummary(tx, {
      id: 41,
      userId: "owner",
      title: "Walk",
      emoji: "🌱",
      category: "health",
      journeyStartDate: yesterday,
      journeyLength: 22,
      journeyCompletedAt: null,
    }));
    assert.equal(summary.successfulDayCount, 2);
    assert.equal(summary.consistencyPercentage, 100);
    const futureSummary = await social.db.transaction((tx) => social.journeySummary(tx, {
      id: 43,
      userId: "owner",
      title: "Future journey",
      emoji: "🌱",
      category: "health",
      journeyStartDate: tomorrow,
      journeyLength: 22,
      journeyCompletedAt: null,
    }));
    assert.equal(futureSummary.successfulDayCount, 0);
    assert.equal(futureSummary.consistencyPercentage, null);
  });

  test("friend acceptance and encouragement serialize with blocking on the canonical pair lock", async () => {
    await resetRouteData();
    const requestResponse = await requestAs("friend", "POST", "/social/friend-requests", {
      recipientUserId: "owner",
    });
    assert.equal(requestResponse.status, 201);
    const request = await requestResponse.json();
    const held = await adminPool.connect();
    try {
      await held.query("BEGIN");
      await held.query(`SELECT id FROM ${quote("users")} WHERE id = 'friend' FOR UPDATE`);
      const accepting = requestAs("owner", "POST", `/social/friend-requests/${request.id}/respond`, {
        decision: "accept",
      });
      const blocking = requestAs("owner", "POST", "/social/blocks", { blockedUserId: "friend" });
      await waitForPairLockWaiters(2);
      await held.query("COMMIT");
      const [acceptedResponse, blockedResponse] = await Promise.all([accepting, blocking]);
      assert.ok([200, 409].includes(acceptedResponse.status));
      assert.equal(blockedResponse.status, 201);
    } finally {
      await held.query("ROLLBACK").catch(() => {});
      held.release();
    }

    await resetRouteData();
    await adminPool.query(
      `INSERT INTO ${quote("social_friendships")} (user_low_id, user_high_id)
       VALUES ('friend', 'owner')`,
    );
    const cheerLock = await adminPool.connect();
    try {
      await cheerLock.query("BEGIN");
      await cheerLock.query(`SELECT id FROM ${quote("users")} WHERE id = 'friend' FOR UPDATE`);
      const cheering = requestAs("friend", "POST", "/social/encouragements", {
        receiverUserId: "owner",
        type: "cheer",
        template: "nice_work",
        requestId: "423e4567-e89b-42d3-a456-426614174000",
      });
      const blocking = requestAs("owner", "POST", "/social/blocks", { blockedUserId: "friend" });
      await waitForPairLockWaiters(2);
      await cheerLock.query("COMMIT");
      const [cheerResponse, blockResponse] = await Promise.all([cheering, blocking]);
      assert.ok([201, 404].includes(cheerResponse.status));
      assert.equal(blockResponse.status, 201);
    } finally {
      await cheerLock.query("ROLLBACK").catch(() => {});
      cheerLock.release();
    }
  });

  test("pair bulk locks are FK-compatible with notification inserts, including mutual check-ins", async () => {
    await resetRouteData();
    const actor = await adminPool.connect();
    let pairWork;
    try {
      await actor.query("BEGIN");
      await actor.query("SET LOCAL statement_timeout = '2000ms'");
      await actor.query(
        `SELECT id FROM ${quote("users")} WHERE id = 'owner' FOR NO KEY UPDATE`,
      );
      pairWork = social.db.transaction((tx) =>
        social.lockSocialPair(tx, "friend", "owner"));
      await waitForPairLockWaiters(1);
      await actor.query(
        `INSERT INTO ${quote("social_notifications")}
         (recipient_user_id, actor_user_id, type, event_key)
         VALUES ('friend', 'owner', 'friend_request_received', $1)`,
        [`fk-compatible:${randomUUID()}`],
      );
      await actor.query("COMMIT");
      await pairWork;
    } finally {
      await actor.query("ROLLBACK").catch(() => {});
      actor.release();
    }

    const [ownerTx, friendTx] = await Promise.all([
      adminPool.connect(),
      adminPool.connect(),
    ]);
    try {
      await ownerTx.query("BEGIN");
      await friendTx.query("BEGIN");
      await ownerTx.query("SET LOCAL statement_timeout = '2000ms'");
      await friendTx.query("SET LOCAL statement_timeout = '2000ms'");
      await ownerTx.query(`SELECT id FROM ${quote("users")} WHERE id = 'owner' FOR NO KEY UPDATE`);
      await friendTx.query(`SELECT id FROM ${quote("users")} WHERE id = 'friend' FOR NO KEY UPDATE`);
      const inserts = await Promise.allSettled([
        ownerTx.query(
          `INSERT INTO ${quote("social_notifications")}
           (recipient_user_id, actor_user_id, type, event_key)
           VALUES ('friend', 'owner', 'friend_request_received', $1)`,
          [`mutual-owner:${randomUUID()}`],
        ),
        friendTx.query(
          `INSERT INTO ${quote("social_notifications")}
           (recipient_user_id, actor_user_id, type, event_key)
           VALUES ('owner', 'friend', 'friend_request_received', $1)`,
          [`mutual-friend:${randomUUID()}`],
        ),
      ]);
      assert.deepEqual(inserts.map((result) => result.status), ["fulfilled", "fulfilled"]);
      await Promise.all([ownerTx.query("COMMIT"), friendTx.query("COMMIT")]);
    } finally {
      await Promise.all([
        ownerTx.query("ROLLBACK").catch(() => {}),
        friendTx.query("ROLLBACK").catch(() => {}),
      ]);
      ownerTx.release();
      friendTx.release();
    }
  });
}