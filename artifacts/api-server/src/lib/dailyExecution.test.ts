import assert from "node:assert/strict";
import test from "node:test";
import {
  elapsedSecondsAt,
  transitionDailyExecution,
  type DailyExecutionState,
  type DailyPlan,
} from "./dailyExecution";

const durationPlan: DailyPlan = {
  executionType: "duration",
  goalType: "build",
  targetValue: 10,
  minimumValue: 5,
  successLimitValue: null,
};

function state(overrides: Partial<DailyExecutionState> = {}): DailyExecutionState {
  return {
    executionType: "duration",
    status: "pending",
    startedAt: null,
    lastResumedAt: null,
    pausedAt: null,
    pausedSeconds: 0,
    elapsedBaseSeconds: 0,
    segmentPausedSeconds: 0,
    finishedAt: null,
    actualValue: null,
    actualSeconds: null,
    ...overrides,
  };
}

test("duration timer measures server elapsed time across pause/resume without counting paused seconds", () => {
  const startedAt = new Date("2025-01-01T10:00:00.000Z");
  const pausedAt = new Date("2025-01-01T10:02:00.000Z");
  const resumedAt = new Date("2025-01-01T10:07:00.000Z");
  const now = new Date("2025-01-01T10:10:00.000Z");
  const running = state({ status: "in_progress", startedAt, lastResumedAt: startedAt });
  const pause = transitionDailyExecution(durationPlan, running, { action: "pause" }, pausedAt);
  const paused = { ...running, ...pause.updates } as DailyExecutionState;
  assert.equal(paused.actualSeconds, 120);
  const resume = transitionDailyExecution(durationPlan, paused, { action: "resume" }, resumedAt);
  const resumed = { ...paused, ...resume.updates } as DailyExecutionState;
  assert.equal(resumed.pausedSeconds, 300);
  assert.equal(elapsedSecondsAt(resumed, now), 300);
});

test("successful duration finish is decided immediately from exact timer seconds", () => {
  const start = new Date("2025-01-01T10:00:00.000Z");
  const now = new Date("2025-01-01T10:05:00.000Z");
  const result = transitionDailyExecution(durationPlan, state({
    status: "in_progress",
    startedAt: start,
    lastResumedAt: start,
  }), { action: "finish" }, now);
  assert.equal(result.shouldRecordSuccess, true);
  assert.equal(result.updates.actualSeconds, 300);
  assert.equal(result.updates.actualValue, 5);
  assert.equal(result.updates.status, "minimum_reached");
});

test("zero limit progress does not succeed until an explicit done claim", () => {
  const limitPlan: DailyPlan = {
    executionType: "limit",
    goalType: "quit",
    targetValue: 0,
    minimumValue: 0,
    successLimitValue: 3,
  };
  const update = transitionDailyExecution(
    limitPlan,
    state(),
    { action: "update_progress", value: 0 },
    new Date("2025-01-01T10:00:00.000Z"),
  );
  assert.equal(update.shouldRecordSuccess, false);
  const done = transitionDailyExecution(
    limitPlan,
    { ...state(), ...update.updates } as DailyExecutionState,
    { action: "done" },
    new Date("2025-01-01T10:01:00.000Z"),
  );
  assert.equal(done.shouldRecordSuccess, true);
  assert.equal(done.updates.actualValue, 0);
});

test("manual duration progress carries into timer segments and finish keeps success open for Done", () => {
  const startAt = new Date("2025-01-01T10:00:00.000Z");
  const pauseAt = new Date("2025-01-01T10:00:30.000Z");
  const manual = transitionDailyExecution(
    durationPlan,
    state(),
    { action: "update_progress", value: 360 },
    new Date("2025-01-01T09:59:00.000Z"),
  );
  const started = transitionDailyExecution(
    durationPlan,
    { ...state(), ...manual.updates } as DailyExecutionState,
    { action: "start" },
    startAt,
  );
  assert.equal(started.updates.status, "in_progress");
  assert.equal(started.updates.lastResumedAt, startAt);
  const active = { ...state(), ...manual.updates, ...started.updates } as DailyExecutionState;
  const paused = transitionDailyExecution(durationPlan, active, { action: "pause" }, pauseAt);
  assert.equal(paused.updates.actualSeconds, 390);
  assert.equal(paused.updates.status, "paused");

  const finished = transitionDailyExecution(
    durationPlan,
    { ...active, ...paused.updates } as DailyExecutionState,
    { action: "finish" },
    pauseAt,
  );
  assert.equal(finished.shouldRecordSuccess, true);
  assert.equal(finished.updates.actualSeconds, 390);
  assert.equal(finished.updates.actualValue, 6.5);
  assert.equal(finished.updates.status, "minimum_reached");
});

test("manual duration progress after a finished timer is carried into the next timer", () => {
  const firstStart = new Date("2025-01-01T10:00:00.000Z");
  const firstFinish = new Date("2025-01-01T10:05:00.000Z");
  const timer = transitionDailyExecution(
    durationPlan,
    state({ status: "in_progress", startedAt: firstStart, lastResumedAt: firstStart }),
    { action: "finish" },
    firstFinish,
  );
  const manual = transitionDailyExecution(
    durationPlan,
    { ...state(), ...timer.updates } as DailyExecutionState,
    { action: "update_progress", value: 360 },
    new Date("2025-01-01T10:06:00.000Z"),
  );
  const nextStart = new Date("2025-01-01T10:07:00.000Z");
  const started = transitionDailyExecution(
    durationPlan,
    { ...state(), ...timer.updates, ...manual.updates } as DailyExecutionState,
    { action: "start" },
    nextStart,
  );
  const running = { ...state(), ...timer.updates, ...manual.updates, ...started.updates } as DailyExecutionState;
  assert.equal(elapsedSecondsAt(running, new Date("2025-01-01T10:07:30.000Z")), 390);
  assert.equal(running.status, "in_progress");
});

test("legacy duration value with no timer timestamp carries into the next timer segment", () => {
  const startAt = new Date("2025-01-01T10:00:00.000Z");
  const stateWithLegacyActual = state({ actualValue: 13, actualSeconds: null });
  assert.equal(elapsedSecondsAt(stateWithLegacyActual, startAt), 780);
  const start = transitionDailyExecution(
    durationPlan,
    stateWithLegacyActual,
    { action: "start" },
    startAt,
  );
  const running = { ...stateWithLegacyActual, ...start.updates } as DailyExecutionState;
  assert.equal(elapsedSecondsAt(running, new Date(startAt.getTime() + 30_000)), 810);
  const pause = transitionDailyExecution(
    durationPlan,
    running,
    { action: "pause" },
    new Date(startAt.getTime() + 30_000),
  );
  assert.equal(pause.updates.actualSeconds, 810);
});

test("explicit Done closes a successful execution for optional reflection after immediate finish reward", () => {
  const startAt = new Date("2025-01-01T10:00:00.000Z");
  const finishAt = new Date("2025-01-01T10:05:00.000Z");
  const finish = transitionDailyExecution(
    durationPlan,
    state({ status: "in_progress", startedAt: startAt, lastResumedAt: startAt }),
    { action: "finish" },
    finishAt,
  );
  const openAfterFinish = { ...state(), ...finish.updates } as DailyExecutionState;
  assert.equal(finish.shouldRecordSuccess, true);
  assert.equal(openAfterFinish.status, "minimum_reached");
  const done = transitionDailyExecution(
    durationPlan,
    openAfterFinish,
    { action: "done" },
    new Date("2025-01-01T10:06:00.000Z"),
  );
  assert.equal(done.shouldRecordSuccess, true);
  assert.equal(done.updates.status, "pending_reflection");
});

test("a paid unfinished count minimum can continue through progress updates without another reward", () => {
  const plan: DailyPlan = { ...durationPlan, executionType: "count" };
  const paidMinimum = state({
    executionType: "count",
    status: "pending_reflection",
    actualValue: 5,
    hasPaidCheckin: true,
  });
  const continued = transitionDailyExecution(
    plan, paidMinimum, { action: "update_progress", value: 6 }, new Date("2025-01-01T10:06:00Z"),
  );
  assert.equal(continued.shouldRecordSuccess, false);
  assert.equal(continued.updates.status, "pending_reflection");
  assert.equal(continued.updates.actualValue, 6);
  assert.throws(() => transitionDailyExecution(
    plan, paidMinimum, { action: "update_progress", value: 4 }, new Date("2025-01-01T10:07:00Z"),
  ), /cannot be reduced below its minimum/);
  assert.throws(() => transitionDailyExecution(
    plan, { ...paidMinimum, hasPaidCheckin: false },
    { action: "update_progress", value: 6 }, new Date("2025-01-01T10:08:00Z"),
  ), /already closed/);
  assert.throws(() => transitionDailyExecution(
    { ...plan, executionType: "boolean" },
    { ...paidMinimum, executionType: "boolean" },
    { action: "update_progress", value: 1 },
    new Date("2025-01-01T10:09:00Z"),
  ), /already closed/);
});

test("a paid unfinished duration minimum may resume/start and finish without downgrading its claim", () => {
  const pausedAt = new Date("2025-01-01T10:05:00Z");
  const pausedPaid = state({
    status: "pending_reflection",
    startedAt: new Date("2025-01-01T10:00:00Z"),
    pausedAt,
    actualValue: 5,
    actualSeconds: 300,
    hasPaidCheckin: true,
  });
  const resumed = transitionDailyExecution(
    durationPlan, pausedPaid, { action: "resume" }, new Date("2025-01-01T10:06:00Z"),
  );
  assert.equal(resumed.updates.status, "in_progress");
  const finished = transitionDailyExecution(
    durationPlan,
    { ...pausedPaid, ...resumed.updates } as DailyExecutionState,
    { action: "finish" },
    new Date("2025-01-01T10:06:30Z"),
  );
  assert.equal(finished.shouldRecordSuccess, true);
  assert.equal(finished.updates.actualValue, 5.5);
  assert.equal(finished.updates.status, "minimum_reached");
  assert.throws(() => transitionDailyExecution(
    { ...durationPlan, goalType: "quit" },
    pausedPaid,
    { action: "start" },
    new Date("2025-01-01T10:07:00Z"),
  ), /already closed/);
});