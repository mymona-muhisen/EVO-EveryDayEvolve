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
  test("time tracking API (isolated PostgreSQL schema)", { skip: "No test database configured" }, () => {});
} else {
  const schema = `api_time_it_${randomUUID().replaceAll("-", "")}`;
  const quote = name => `"${schema}"."${name}"`;
  const scopedUrl = new URL(databaseUrl);
  const currentOptions = scopedUrl.searchParams.get("options");
  scopedUrl.searchParams.set("options", [currentOptions, `-c search_path=${schema}`].filter(Boolean).join(" "));
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = scopedUrl.toString();
  const dbRequire = createRequire(join(dbDir, "package.json"));
  const { Pool } = dbRequire("pg");
  const adminPool = new Pool({ connectionString: databaseUrl });
  let tempDir;
  let server;
  let baseUrl;
  let applicationDb;
  let actor;
  const date = new Date().toISOString().slice(0, 10);
  const categories = {
    study: "الدراسة", work: "العمل", social_media: "وسائل التواصل", gaming: "الألعاب",
    entertainment: "الترفيه", exercise: "الرياضة", eating: "الطعام", rest: "الراحة",
    travel: "التنقل", socializing: "التواصل مع الآخرين", personal: "وقت شخصي",
    other: "نشاط آخر", unknown: "لا أتذكر",
  };

  before(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    await adminPool.query(`CREATE TABLE ${quote("users")} (id text PRIMARY KEY)`);
    await adminPool.query(`CREATE TABLE ${quote("tracking_sessions")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      date date NOT NULL, status text NOT NULL DEFAULT 'active', interval_minutes integer NOT NULL DEFAULT 15,
      started_at timestamptz NOT NULL DEFAULT now(), last_checkin_at timestamptz,
      next_checkin_at timestamptz, finished_at timestamptz,
      active_elapsed_ms integer NOT NULL DEFAULT 0, interval_elapsed_ms integer NOT NULL DEFAULT 0,
      timer_anchor_at timestamptz, UNIQUE(user_id, date)
    )`);
    await adminPool.query(`CREATE TABLE ${quote("time_entries")} (
      id serial PRIMARY KEY, user_id text NOT NULL REFERENCES ${quote("users")}(id) ON DELETE CASCADE,
      habit_id integer, label text NOT NULL, duration_minutes integer NOT NULL, date date NOT NULL,
      note text, category text NOT NULL DEFAULT 'other', source text NOT NULL DEFAULT 'manual',
      start_time timestamptz, end_time timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    tempDir = await mkdtemp(join(apiDir, ".time-api-test-"));
    const bundle = join(tempDir, "timeTracking.mjs");
    const entrypoint = join(tempDir, "timeTracking.test.ts");
    await writeFile(entrypoint, `
      import trackingRouter from ${JSON.stringify(join(apiDir, "src/routes/timeTracking.ts"))};
      import timeEntriesRouter from ${JSON.stringify(join(apiDir, "src/routes/timeEntries.ts"))};
      import { pool } from ${JSON.stringify(join(dbDir, "src/index.ts"))};
      export { trackingRouter, timeEntriesRouter, pool };
    `);
    const testPlugins = [{
      name: "time-tracking-test-auth",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: join(dbDir, "src/index.ts"),
        }));
        buildApi.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({
          path: join(repositoryDir, "lib/api-zod/src/generated/api.ts"),
        }));
        buildApi.onResolve({ filter: /^pg$/ }, () => ({
          path: dbRequire.resolve("pg"),
          external: true,
        }));
        buildApi.onResolve({ filter: /^\.\.\/middlewares\/requireAuth$/ }, () => ({ path: "requireAuth", namespace: "test" }));
        buildApi.onLoad({ filter: /.*/, namespace: "test" }, args => {
          if (args.path === "requireAuth") return { contents: `export function requireAuth(req,res,next){req.userId=req.headers["x-test-actor"];if(!req.userId)return res.status(401).json({error:"Unauthorized"});next()}` };
          return null;
        });
        buildApi.onResolve({ filter: /^\.\.\/lib\/userService$/ }, () => ({ path: "userService", namespace: "test" }));
        buildApi.onLoad({ filter: /^userService$/, namespace: "test" }, () => ({ contents: `export async function ensureUser(id){return {id,timezone:"UTC",primaryGoalCategory:null}}` }));
        buildApi.onResolve({ filter: /^\.\.\/lib\/trackedDay$/ }, () => ({ path: "trackedDay", namespace: "test" }));
        buildApi.onLoad({ filter: /^trackedDay$/, namespace: "test" }, () => ({ resolveDir: apiDir, contents: `
          import {and,eq} from "drizzle-orm";
          import {db,timeEntriesTable} from "@workspace/db";
          export const categories=${JSON.stringify(categories)};
          export async function getTrackedDay(userId,date){
            const entries=await db.select().from(timeEntriesTable).where(and(eq(timeEntriesTable.userId,userId),eq(timeEntriesTable.date,date)));
            const totals=new Map();for(const entry of entries)totals.set(entry.category,(totals.get(entry.category)||0)+entry.durationMinutes);
            const totalMinutes=entries.reduce((sum,entry)=>sum+entry.durationMinutes,0);
            const grouped=[...totals].map(([category,minutes])=>({category,minutes,percentage:totalMinutes?Math.round(minutes*100/totalMinutes):0})).sort((a,b)=>b.minutes-a.minutes);
            return {date,totalMinutes,categories:grouped,topCategories:grouped.slice(0,3),entries};
          }
        ` }));
        buildApi.onResolve({ filter: /^\.\.\/lib\/trackedAnalysisCache$/ }, () => ({ path: "trackedAnalysisCache", namespace: "test" }));
        buildApi.onLoad({ filter: /^trackedAnalysisCache$/, namespace: "test" }, () => ({ contents: `export async function getCachedTrackedAnalysis(){return {status:"insufficient",headline:"",observation:"",pattern:null,opportunity:"",suggestedChange:null,replacements:[]}}` }));
      },
    }];
    await build({
      entryPoints: [entrypoint],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      plugins: testPlugins,
    });
    const { trackingRouter, timeEntriesRouter, pool } = await import(pathToFileURL(bundle).href);
    const app = express();
    app.use(express.json());
    app.use("/api", trackingRouter);
    app.use("/api", timeEntriesRouter);
    server = app.listen(0);
    await new Promise(resolveListen => server.once("listening", resolveListen));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    actor = `synthetic_timer_${randomUUID()}`;
    await adminPool.query(`INSERT INTO ${quote("users")} (id) VALUES ($1)`, [actor]);
    applicationDb = pool;
  });

  after(async () => {
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    if (applicationDb) await applicationDb.end();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test("15/30 intervals, pause/resume/reload, explicit unknown/manual records and finish summary", async () => {
    const request = (path, method = "GET", body) => fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-actor": actor },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const expectStatus = async (response, status) => {
      if (response.status !== status) assert.fail(`Expected HTTP ${status}; got ${response.status}: ${await response.text()}`);
    };
    const change = async (action, intervalMinutes) => {
      const response = await request("/time-tracking/session", "POST", { date, action, intervalMinutes });
      await expectStatus(response, 200);
      return response.json();
    };
    const start = await change("start", 15);
    assert.equal(start.session.intervalMinutes, 15);
    assert.equal(start.session.activeElapsedMs, 0);
    const reload = await request(`/time-tracking/session?date=${date}`);
    assert.equal(reload.status, 200);
    assert.equal((await reload.json()).session.timerAnchorAt, start.session.timerAnchorAt);

    await adminPool.query(`UPDATE ${quote("tracking_sessions")} SET timer_anchor_at=now()-interval '10 minutes' WHERE user_id=$1`, [actor]);
    const beforeCheckin = (await (await request(`/time-tracking/session?date=${date}`)).json()).session;
    let dayResponse = await request(`/time-tracking/day?date=${date}`);
    assert.equal((await dayResponse.json()).entries.length, 0, "elapsed time alone must never create activity evidence");

    const checkinResponse = await request("/time-tracking/check-in", "POST", { date, category: "unknown" });
    await expectStatus(checkinResponse, 201);
    const checkin = await checkinResponse.json();
    assert.equal(checkin.category, "unknown");
    assert.equal(checkin.durationMinutes, 15, "check-in duration uses selected interval, not elapsed gap");
    const afterCheckin = (await (await request(`/time-tracking/session?date=${date}`)).json()).session;
    assert.equal(afterCheckin.timerAnchorAt, beforeCheckin.timerAnchorAt, "check-in must not reset interval boundaries");
    assert.equal(afterCheckin.activeElapsedMs, beforeCheckin.activeElapsedMs);
    assert.equal(afterCheckin.intervalElapsedMs, beforeCheckin.intervalElapsedMs);

    const manualResponse = await request("/time-entries", "POST", {
      date, category: "unknown", label: "لا أتذكر", durationMinutes: 15,
    });
    await expectStatus(manualResponse, 201);
    assert.equal((await manualResponse.json()).category, "unknown");

    await change("interval", 30);
    let sessionResponse = await request(`/time-tracking/session?date=${date}`);
    assert.equal((await sessionResponse.json()).session.intervalMinutes, 30);
    await adminPool.query(`UPDATE ${quote("tracking_sessions")} SET timer_anchor_at=now()-interval '6 minutes' WHERE user_id=$1`, [actor]);
    await change("pause");
    const paused = await (await request(`/time-tracking/session?date=${date}`)).json();
    assert.equal(paused.session.status, "paused");
    const elapsedAtPause = paused.session.activeElapsedMs;
    assert.ok(elapsedAtPause >= 6 * 60_000, "pause persists elapsed active time");
    assert.ok(Math.abs(paused.session.intervalElapsedMs - 16 * 60_000) < 10_000,
      "the partially completed interval persists through pause");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    const stillPaused = await (await request(`/time-tracking/session?date=${date}`)).json();
    assert.equal(stillPaused.session.activeElapsedMs, elapsedAtPause, "paused time is excluded");
    await change("resume");
    await adminPool.query(`UPDATE ${quote("tracking_sessions")} SET timer_anchor_at=now()-interval '2 minutes' WHERE user_id=$1`, [actor]);
    await change("finish");

    dayResponse = await request(`/time-tracking/day?date=${date}`);
    const summary = await dayResponse.json();
    assert.equal(summary.entries.length, 2, "finishing creates no inferred entries");
    assert.equal(summary.totalMinutes, 30);
    assert.deepEqual(summary.entries.map(entry => entry.source).sort(), ["check_in", "manual"]);
    const finished = await (await request(`/time-tracking/session?date=${date}`)).json();
    assert.equal(finished.session.status, "finished");
    assert.equal(finished.session.timerAnchorAt, null);
    assert.ok(finished.session.activeElapsedMs >= elapsedAtPause + 2 * 60_000);
  });
}