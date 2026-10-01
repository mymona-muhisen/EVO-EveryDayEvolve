import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDay, historyRows, canShowUnlocked, hasRecoveryRecord, nodePos, MILESTONES, isTodayExecutable, zonedDateKey, needsRolloverRefetch } from './journey-map';
import type { HabitDay, HabitJourney } from '@workspace/api-client-react';

const day = (o: Partial<HabitDay>): HabitDay => ({ date: '2025-01-05', dayNumber: 5, scheduled: true, targetValue: 10, minimumValue: 5, busyDayValue: null, successLimitValue: null, goalType: 'build', status: 'pending', actualValue: null, actualSeconds: null, difficulty: null, missedReason: null, recoveryEnabled: false, recoveryUsed: 0, recoveryLimit: 0, recoveryStatus: null, checkin: null, ...o });
const T = '2025-01-10';
test('rest is never missed', () => assert.equal(classifyDay(day({ scheduled: false, status: 'rest' }), T), 'rest'));
test('past missed', () => assert.equal(classifyDay(day({ status: 'missed' }), T), 'missed'));
test('future locked', () => assert.equal(classifyDay(day({ date: '2025-01-12', status: 'future' }), T), 'future'));
test('today current', () => assert.equal(classifyDay(day({ date: T }), T), 'today'));
test('recovered', () => assert.equal(classifyDay(day({ status: 'recovered' }), T), 'recovered'));
test('unknown actuals show dash', () => { const r = historyRows(day({})); assert.equal(r.actual, '—'); assert.equal(r.difficulty, '—'); assert.equal(r.reason, '—'); });
test('zero actual is kept', () => assert.equal(historyRows(day({ actualValue: 0 })).actual, '0'));
test('milestones', () => assert.deepEqual([...MILESTONES], [1, 5, 10, 15, 22]));
test('no local unlock', () => assert.equal(canShowUnlocked({ rewardUnlocked: false } as HabitJourney), false));
test('recovery only if recorded', () => { assert.equal(hasRecoveryRecord(day({})), false); assert.equal(hasRecoveryRecord(day({ recoveryUsed: 1 })), true); });
test('positions inside viewport', () => { for (let i = 1; i <= 22; i++) { const p = nodePos(i); assert.ok(p.x >= 15 && p.x <= 85); } });

test('successful today keeps execution eligibility', () => { const d = day({ date: T, status: 'completed', checkin: { completed: true } as HabitDay['checkin'] }); assert.equal(classifyDay(d, T), 'success'); assert.equal(isTodayExecutable(d, T), true); });
test('rest today not executable', () => assert.equal(isTodayExecutable(day({ date: T, scheduled: false, status: 'rest' }), T), false));
test('explicit today missed', () => assert.equal(classifyDay(day({ date: T, status: 'missed' }), T), 'missed'));
test('running past day is missed', () => assert.equal(classifyDay(day({ status: 'pending' }), T), 'missed'));
test('saved timezone differs from device', () => {
  const now = new Date('2025-01-10T22:30:00Z');
  assert.equal(zonedDateKey(now, 'Asia/Riyadh'), '2025-01-11');
  assert.equal(zonedDateKey(now, 'America/Los_Angeles'), '2025-01-10');
  assert.equal(needsRolloverRefetch(now, { today: '2025-01-10', timezone: 'Asia/Riyadh' }), true);
  assert.equal(needsRolloverRefetch(now, { today: '2025-01-10', timezone: 'America/Los_Angeles' }), false);
});
