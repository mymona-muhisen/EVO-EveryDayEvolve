import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = resolve(apiDir, "../habit-journey");
const temp = await mkdtemp(join(apiDir, ".recovery-test-"));
const state = {
  rows: [],
  writes: 0,
  textCalls: 0,
  viewer: "alice",
  hookIndex: 0,
  hooks: [],
  offer: null,
  decision: null,
  view: null,
  invalidated: [],
  pending: [],
};
globalThis.__recoveryTest = state;

const table = `export const habitsTable = Object.fromEntries(
  ["id", "userId", "createdAt", "isActive"].map(key => [key, key]));
export const checkinsTable = {};
export const db = {
  select: () => ({ from: () => ({ where: async predicate =>
    globalThis.__recoveryTest.rows.filter(predicate) }) }),
  update: () => ({ set: changes => ({ where: predicate => ({ returning: async () => {
    const s = globalThis.__recoveryTest;
    const row = s.rows.find(predicate);
    if (!row) return [];
    s.writes++;
    Object.assign(row, changes);
    return [{ ...row }];
  } }) }) }),
};`;
const uiMocks = `
const s = globalThis.__recoveryTest;
export const useGetHabit = () => ({ data: s.view, isLoading: false, isError: false });
export const useListHabitCheckins = () => ({ data: [] });
export const useListTimeEntries = () => ({ data: [] });
export const useAiRelapseRecovery = () => ({ isPending: false, mutate: (_, callbacks) => {
  s.offer = callbacks;
  s.pending.push(fetch(s.base + "/ai/relapse-recovery", {
    method: "POST", headers: { "content-type": "application/json", "x-test-user": s.viewer },
    body: JSON.stringify({ habitId: s.view.id, missedDays: 1 }),
  }).then(async r => { if (r.ok) callbacks.onSuccess(await r.json()); else callbacks.onError(); }));
} });
export const useUpdateHabit = () => ({ isPending: false, mutate: (input, callbacks) => {
  s.pending.push(fetch(s.base + "/habits/" + input.habitId, {
    method: "PATCH", headers: { "content-type": "application/json", "x-test-user": s.viewer },
    body: JSON.stringify(input.data),
  }).then(async r => { if (r.ok) callbacks.onSuccess(await r.json()); else callbacks.onError(); }));
} });
const idle = () => ({ isPending: false, mutate() {} });
export const useCreateCheckin = idle, useRecoverStreak = idle, useAiCheckinFeedback = idle,
  useCreateTimeEntry = idle, useCreateHabit = idle, useDeleteHabit = idle,
  useAiBreakdownGoal = idle, useListHabits = idle;
export const getGetHabitQueryKey = id => ["habit", id];
export const getListHabitsQueryKey = () => ["habits"];
export const getGetDashboardTodayQueryKey = () => ["dashboard"];
export const getListHabitCheckinsQueryKey = () => ["checkins"];
export const getGetWalletQueryKey = () => ["wallet"];
export const getListTimeEntriesQueryKey = () => ["times"];`;

const stubs = {
  "@workspace/db": table,
  "drizzle-orm": `export const eq = (key, value) => row => row[key] === value;
export const and = (...predicates) => row => predicates.every(predicate => predicate(row));
export const gte = () => () => true;
export const desc = () => undefined;`,
  "../middlewares/requireAuth": `export const requireAuth = (req, res, next) => {
  if (!req.headers["x-test-user"]) return res.status(401).json({error:"Unauthorized"});
  req.userId = req.headers["x-test-user"]; next();
};`,
  "../lib/userService": `export const ensureUser = async id => ({ id });`,
  "../lib/aiMessages": `export const relapseRecoveryMessages = async () => {
  globalThis.__recoveryTest.textCalls++;
  return { message: "ابدأ من جديد", encouragement: "يمكنك المحاولة" };
};
export const breakdownGoalMessages = async () => ({stepTexts:[],coachMessage:""});
export const dailyInsightMessage = async () => "";
export const checkinFeedbackMessage = async () => "";`,
  react: `export const useState = initial => {
  const s = globalThis.__recoveryTest, i = s.hookIndex++;
  if (!(i in s.hooks)) s.hooks[i] = initial;
  return [s.hooks[i], value => { s.hooks[i] = typeof value === "function" ? value(s.hooks[i]) : value; }];
};`,
  "react/jsx-runtime": `export const jsx = (type, props) => ({ type, props: props || {} });
export const jsxs = jsx; export const Fragment = "fragment";`,
  wouter: `export const Link = "a"; export const useParams = () => ({ habitId: "1" });`,
  "@tanstack/react-query": `export const useQueryClient = () => ({
  setQueryData: (_, value) => { globalThis.__recoveryTest.view = value; },
  invalidateQueries: ({queryKey}) => { globalThis.__recoveryTest.invalidated.push(queryKey); },
});`,
  "@workspace/api-client-react": uiMocks,
  sonner: `export const toast = {success(){},error(){},info(){}};`,
  "lucide-react": `export const ArrowLeft = "icon", Flame = "icon", Sparkles = "icon",
Coins = "icon", Clock3 = "icon", Trash2 = "icon", Pencil = "icon",
Plus = "icon", Check = "icon", RotateCcw = "icon";`,
  "@/components/journey-ui": `export const PageHead = "mock", SectionTitle = "mock",
Field = "mock", Modal = "mock", Empty = "mock", Loading = "mock",
ErrorBlock = "mock", AddButton = "mock";
export const categories = {health:"الصحة"};
export const dateToday = () => "2026-09-30";
export const arDate = value => value;`,
};

const plugin = {
  name: "isolated-recovery-dependencies",
  setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      if (args.path in stubs) return { path: args.path, namespace: "recovery-stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "recovery-stub" }, args => ({
      contents: stubs[args.path], loader: "js",
    }));
  },
};

function habit(id, userId, targetValue) {
  return {
    id, userId, targetValue, title: "المشي", emoji: "🌱", category: "health",
    cadence: "daily", customDays: null, unit: "minutes", difficulty: "easy",
    goalType: "build", isActive: true, currentStreak: 0, longestStreak: 3,
    lastCheckinDate: null, milestones: [], createdAt: new Date(),
  };
}

function render(Page) {
  state.hookIndex = 0;
  return Page();
}
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node !== "object") return String(node);
  return text(node.props?.children);
}
function button(tree, label) {
  const find = node => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!node || typeof node !== "object") return null;
    if (node.type === "button" && text(node).includes(label)) return node;
    return find(node.props?.children);
  };
  const found = find(tree);
  assert.ok(found, `Expected button: ${label}`);
  return found;
}
async function flush() {
  await Promise.all(state.pending.splice(0));
}

try {
  for (const [entry, file] of [
    [join(apiDir, "src/routes/ai.ts"), "ai.mjs"],
    [join(apiDir, "src/routes/habits.ts"), "habits.mjs"],
    [join(webDir, "src/pages/habits.tsx"), "page.mjs"],
  ]) {
    await build({
      entryPoints: [entry], outfile: join(temp, file), bundle: true,
      platform: "node", format: "esm", external: ["express"],
      jsx: "automatic", plugins: [plugin], logLevel: "silent",
    });
  }
  const [{ default: ai }, { default: habits }, { HabitDetailPage }] = await Promise.all(
    ["ai.mjs", "habits.mjs", "page.mjs"].map(file => import(pathToFileURL(join(temp, file)).href)),
  );
  const app = express();
  app.use(express.json());
  app.use(ai, habits);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, user, data) => fetch(state.base + path, {
    method, headers: { "content-type": "application/json", "x-test-user": user },
    ...(data && { body: JSON.stringify(data) }),
  });
  try {
    await test("another user's habit cannot be suggested or updated", async () => {
      state.rows = [habit(1, "alice", 10), habit(2, "bob", 14)];
      state.writes = state.textCalls = 0;
      const proposed = await request("/ai/relapse-recovery", "POST", "alice", { habitId: 2, missedDays: 1 });
      assert.equal(proposed.status, 404);
      const patched = await request("/habits/2", "PATCH", "alice", { targetValue: 7 });
      assert.equal(patched.status, 404);
      assert.equal(state.rows[1].targetValue, 14);
      assert.equal(state.writes, 0);
      assert.equal(state.textCalls, 0);
    });

    await test("keeping the current goal sends no update; accepting persists and refreshes the displayed goal", async () => {
      state.rows = [habit(1, "alice", 10)];
      state.view = { ...state.rows[0] };
      state.hooks = [];
      state.invalidated = [];
      state.writes = 0;
      button(render(HabitDetailPage), "اسأل المدرّب").props.onClick();
      await flush();
      assert.match(text(render(HabitDetailPage)), /هدف العودة المقترح:\s+5/);
      button(render(HabitDetailPage), "الإبقاء على هدفي الحالي").props.onClick();
      assert.equal(state.writes, 0);
      assert.equal(state.rows[0].targetValue, 10);
      assert.match(text(render(HabitDetailPage)), /بقي هدفك كما هو:\s+10/);

      button(render(HabitDetailPage), "اسأل المدرّب").props.onClick();
      await flush();
      button(render(HabitDetailPage), "تطبيق هدف العودة").props.onClick();
      await flush();
      const after = render(HabitDetailPage);
      assert.equal(state.writes, 1);
      assert.equal(state.rows[0].targetValue, 5);
      assert.match(text(after), /هدف العادة الحالي:\s+5/);
      assert.match(text(after), /تم تطبيق هدف العودة:\s+5/);
      assert.ok(state.invalidated.some(key => key[0] === "habits"));
      assert.ok(state.invalidated.some(key => key[0] === "dashboard"));
      assert.equal(state.view.targetValue, 5);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}