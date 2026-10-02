import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDayCoach, type CoachDay, type CoachHabit } from "./dayCoach";
import { habitCoachingHistory } from "./coachHistory";
import { analyzeTrackedDay, categories } from "./trackedDay";

const day: CoachDay = {
  date: "2026-10-02", totalMinutes: 225,
  categories: [{ category: "social_media", minutes: 225, percentage: 100 }],
  entries: [0, 1, 2].map(i => ({ category: "social_media", source: "check_in",
    startTime: new Date(Date.parse("2026-10-02T15:00:00Z") + i * 75 * 60000), durationMinutes: 75 })),
};
const habit: CoachHabit = {
  id: 11, title: "قراءة", category: "learning", unit: "minutes", goalType: "build",
  targetValue: 20, minimumValue: 10, busyDayValue: 3, successLimitValue: null, baselineValue: null, minimumFloor: 1,
  history: [], numericHistory: [],
};
const facts = (d = day, habits: CoachHabit[] = []) => buildDayCoach(d, "Asia/Damascus", habits, categories);
const analyze = (provider: Parameters<typeof analyzeTrackedDay>[3], d = day) =>
  analyzeTrackedDay(d as unknown as Parameters<typeof analyzeTrackedDay>[0], "Asia/Damascus", undefined, provider);

test("recovery is small, dynamic and its alternatives share the real budget", () => {
  const result = facts();
  assert.equal(result.suggestedChange?.minutes, 20);
  assert.equal(result.replacements.length, 5);
  assert.ok(result.replacements.every(r => r.minutes === 20));
  const small = facts({ ...day, totalMinutes: 90, categories: [{ category: "social_media", minutes: 90, percentage: 100 }],
    entries: day.entries.map(e => ({ ...e, durationMinutes: 30 })) });
  assert.equal(small.suggestedChange?.minutes, 10);
});
test("manual records and unknown clock gaps cannot invent a time pattern", () => {
  const manual = facts({ ...day, entries: day.entries.map(e => ({ ...e, source: "manual", startTime: null })) });
  assert.equal(manual.status, "insufficient");
  assert.equal(manual.bestTimeSuggestion, null);
  assert.equal(manual.suggestedChange, null);
});
test("unknown activities do not support reduction", () => {
  const unknown = facts({ ...day, categories: [{ category: "unknown", minutes: 225, percentage: 100 }],
    entries: day.entries.map(e => ({ ...e, category: "unknown" })) });
  assert.equal(unknown.suggestedChange, null);
  assert.equal(unknown.bestTimeSuggestion, null);
});
test("block crossings are apportioned to the actual local intervals", () => {
  assert.equal(facts().timePatterns.reduce((sum, p) => sum + p.minutes, 0), 225);
  assert.equal(facts().bestTimeSuggestion?.start, "18:00");
});
test("rest days, future obligations and unknown legacy dates are not misses", () => {
  const result = habitCoachingHistory([], [
    { date: "2026-09-29", scheduled: false, planRevision: 1 },
    { date: "2026-09-30", scheduled: true, planRevision: 1 },
    { date: "2026-10-02", scheduled: true, planRevision: 1 },
    { date: "2026-10-03", scheduled: true, planRevision: 1 },
  ], [], "2026-10-02", 1);
  assert.deepEqual(result.history.map(h => h.date), ["2026-09-30"]);
});
test("accepted-plan numeric evidence does not reuse old easy days", () => {
  const record = { date: "2026-09-30", completed: true, difficulty: "easy", missedReason: null };
  const result = habitCoachingHistory([record], [{ date: record.date, scheduled: true, planRevision: 1 }], [], "2026-10-02", 2);
  assert.equal(result.history.length, 1);
  assert.equal(result.numericHistory.length, 0);
  assert.equal(facts(day, [{ ...habit, ...result }]).habitAdjustment, null);
});
test("unknown legacy plan provenance preserves real history without numeric prescriptions", () => {
  const record = { date: "2026-09-30", completed: true, difficulty: "easy", missedReason: null };
  const result = habitCoachingHistory([record], [], [], "2026-10-02", 0);
  assert.equal(result.history.length, 1);
  assert.equal(result.numericHistory.length, 0);
});
test("high normal completion supports a gradual increase without inventing ease", () => {
  const history = [0, 1, 2, 3, 4, 5].map(i => ({ date: `2026-09-${24 + i}`, completed: true, difficulty: "normal", missedReason: null }));
  const result = facts(day, [{ ...habit, history, numericHistory: history }]);
  assert.equal(result.habitAdjustment?.action, "increase");
  assert.equal(result.habitAdjustment?.suggestedTarget, 22);
});
test("repeated low completion supports a bounded reduction", () => {
  const history = [false, true, false].map((completed, i) => ({ date: `2026-09-${27 + i}`, completed, difficulty: null, missedReason: null }));
  assert.equal(facts(day, [{ ...habit, history, numericHistory: history }]).habitAdjustment?.suggestedTarget, 16);
});
test("one hard day does not scale down the goal", () => {
  const history = [{ date: "2026-10-01", completed: false, difficulty: "hard", missedReason: null }];
  assert.equal(facts(day, [{ ...habit, history, numericHistory: history }]).habitAdjustment, null);
});
test("a few easy successes do not outweigh repeated missed obligations", () => {
  const history = [true, true, true, false, false, false, false].map((completed, i) => ({
    date: `2026-09-${23 + i}`, completed, difficulty: completed ? "easy" : null, missedReason: null,
  }));
  assert.equal(facts(day, [{ ...habit, history, numericHistory: history }]).habitAdjustment, null);
});
test("a real forgotten reflection supports a timing review, not a false morning claim", () => {
  const history = [{ date: "2026-10-01", completed: false, difficulty: null, missedReason: "forgot" as const }];
  assert.equal(facts(day, [{ ...habit, history, numericHistory: history }]).habitAdjustment?.action, "reschedule");
});
test("provider failure returns the full deterministic Arabic experience", async () => {
  const result = await analyze({ generateText: async () => { throw new Error("Provider unavailable"); } });
  assert.equal(result.source, "fallback");
  assert.equal(result.insights.length, 3);
  assert.equal(result.suggestedChange?.minutes, 20);
});
test("invalid or unsupported provider JSON never changes the facts", async () => {
  for (const raw of ["not JSON", '{"headline":"تشخيص نفسي","actionIndex":0,"encouragement":"x"}',
    '{"headline":"يومك يمنحك صورة أوضح","actionIndex":99,"encouragement":"احتفظ بما يناسبك، فالقرار لك."}',
    '{"headline":"يومك يمنحك صورة أوضح","actionIndex":0,"encouragement":"احتفظ بما يناسبك، فالقرار لك.","minutes":900}']) {
    const result = await analyze({ generateText: async () => raw });
    assert.equal(result.source, "fallback");
    assert.equal(result.suggestedChange?.minutes, 20);
  }
});
test("valid Arabic structured choice is accepted and private raw fields are not sent", async () => {
  const privateDay = { ...day, userId: "do-not-send", entries: day.entries.map(e => ({ ...e, note: "private-note", id: 987 })) };
  const result = await analyze({
    generateText: async (_system, context) => {
      const serialized = JSON.stringify(context);
      assert.ok(!serialized.includes("private-note"));
      assert.ok(!serialized.includes("do-not-send"));
      assert.ok(!serialized.includes("987"));
      return '{"headline":"خطوة صغيرة تناسب يومك","actionIndex":0,"encouragement":"احتفظ بما يناسبك، فالقرار لك."}';
    },
  }, privateDay);
  assert.equal(result.source, "gemini");
  assert.equal(result.suggestedChange?.minutes, 20);
});