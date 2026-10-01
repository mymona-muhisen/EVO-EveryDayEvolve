import assert from "node:assert/strict";
import { test } from "node:test";
import { accrueTimer, projectTimer } from "./trackingTimer";

const at = (minute: number) => new Date(minute * 60_000);

test("projects active total and a 15-minute cyclic interval across reloads", () => {
  const started = { activeElapsedMs: 0, intervalElapsedMs: 0, intervalMinutes: 15, timerAnchorAt: at(0) };
  const afterEight = projectTimer(started, at(8));
  assert.equal(afterEight.activeElapsedMs, 8 * 60_000);
  assert.equal(afterEight.intervalElapsedMs, 8 * 60_000);
  // A reload uses the same persisted anchor and therefore produces the same progression.
  assert.deepEqual(projectTimer(started, at(8)), afterEight);
  const nextCycle = projectTimer(started, at(17));
  assert.equal(nextCycle.activeElapsedMs, 17 * 60_000);
  assert.equal(nextCycle.intervalElapsedMs, 2 * 60_000);
});

test("interval progress cycles at each 15/30-minute boundary from tracking start", () => {
  const startedAt = new Date("2026-01-01T09:00:00.000Z");
  const snapshot = { activeElapsedMs: 0, intervalElapsedMs: 0, intervalMinutes: 15, timerAnchorAt: startedAt };
  for (const minute of [15, 30, 45]) {
    const boundary = projectTimer(snapshot, new Date(startedAt.getTime() + minute * 60_000));
    assert.equal(boundary.activeElapsedMs, minute * 60_000);
    assert.equal(boundary.intervalElapsedMs, 0, `15-minute interval resets at minute ${minute}`);
  }
  const thirtyMinuteSnapshot = { ...snapshot, intervalMinutes: 30 };
  for (const minute of [30, 60]) {
    const boundary = projectTimer(thirtyMinuteSnapshot, new Date(startedAt.getTime() + minute * 60_000));
    assert.equal(boundary.intervalElapsedMs, 0, `30-minute interval resets at minute ${minute}`);
  }
});

test("15/30-minute granularity and pause/resume exclude paused time", () => {
  const fifteen = accrueTimer({
    activeElapsedMs: 0, intervalElapsedMs: 4 * 60_000, intervalMinutes: 15, timerAnchorAt: at(0),
  }, at(6));
  assert.equal(fifteen.activeElapsedMs, 6 * 60_000);
  assert.equal(fifteen.intervalElapsedMs, 10 * 60_000);
  const resumed = projectTimer({
    ...fifteen, intervalMinutes: 30, timerAnchorAt: at(100),
  }, at(105));
  assert.equal(resumed.activeElapsedMs, 11 * 60_000);
  assert.equal(resumed.intervalElapsedMs, 15 * 60_000);
  const thirtyCycle = projectTimer(resumed, at(115));
  assert.equal(thirtyCycle.intervalElapsedMs, 0);
});

test("finishing freezes the recorded timer state without creating any activity", () => {
  const finished = accrueTimer({
    activeElapsedMs: 12 * 60_000, intervalElapsedMs: 3 * 60_000,
    intervalMinutes: 15, timerAnchorAt: at(10),
  }, at(14));
  assert.equal(finished.activeElapsedMs, 16 * 60_000);
  assert.equal(finished.intervalElapsedMs, 7 * 60_000);
  assert.equal(finished.timerAnchorAt, null);
});