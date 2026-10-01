import test from 'node:test';
import assert from 'node:assert/strict';
import { actualUnits, dayKey, displayActualValue, displayStatus, findHabitReward, isOpen } from '../src/lib/daily.ts';

const state = (extra = {}) => ({
  executionType: 'duration',
  goalType: 'build',
  status: 'pending',
  eligible: true,
  minimumValue: 5,
  targetValue: 10,
  actualValue: null,
  actualSeconds: null,
  finishedAt: null,
  checkin: null,
  ...extra,
});

test('expired timer seconds do not invent confirmed activity or completion', () => {
  const missed = state({ status: 'missed', actualSeconds: 900, finishedAt: '2026-10-01T00:00:00Z' });
  assert.equal(actualUnits(missed), 0);
  assert.equal(displayStatus(missed), 'missed');
  assert.equal(isOpen(missed), false);
});

test('unconfirmed running time does not become a numeric actual', () => {
  const running = state({ status: 'in_progress', actualSeconds: 900 });
  assert.equal(actualUnits(running), 0);
  assert.equal(displayStatus(running), 'in_progress');
});

test('explicit actuals retain fractions even when elapsed timer seconds differ', () => {
  assert.equal(actualUnits(state({ actualValue: 5.5, actualSeconds: 900 })), 5.5);
});

test('confirmed below-minimum finish stays honestly incomplete', () => {
  const partial = state({ status: 'in_progress', actualValue: 2, actualSeconds: 120, finishedAt: '2026-10-01T10:00:00Z' });
  assert.equal(displayStatus(partial), 'incomplete');
  const past = { ...partial, status: 'missed' };
  assert.equal(displayStatus(past), 'missed');
  assert.equal(isOpen(past), false);
});

test('ISO response dates and date-only calendar keys compare without timezone conversion', () => {
  assert.equal(dayKey('2026-10-01T00:00:00.000Z'), dayKey('2026-10-01'));
  assert.equal(dayKey(null), '');
});

test('unknown past counter values are not shown as measured zeros', () => {
  const past = state({ executionType: 'count', status: 'missed' });
  assert.equal(displayActualValue(past), '—');
  assert.equal(displayActualValue({ ...past, actualValue: 0 }), '0');
  assert.equal(displayActualValue(state({ executionType: 'limit', goalType: 'quit' })), '0');
});

test('persisted reward choice wins over another reverse-linked reward', () => {
  const selected = { id: 7, habitId: null, isRedeemed: false };
  const linked = { id: 8, habitId: 12, isRedeemed: false };
  assert.equal(findHabitReward({ id: 12, rewardId: 7 }, [linked, selected]), selected);
  assert.equal(findHabitReward({ id: 12, rewardId: 7 }, [linked]), undefined);
  assert.equal(findHabitReward({ id: 12, rewardId: null }, [linked]), linked);
});

test('affirmed reduce usage over the limit is incomplete, not a running success', () => {
  const overLimit = state({ executionType: 'limit', goalType: 'quit', status: 'in_progress', actualValue: 5, successLimitValue: 3 });
  assert.equal(displayStatus(overLimit), 'in_progress');
  assert.equal(displayStatus({ ...overLimit, finishedAt: '2026-10-01T10:00:00Z' }), 'incomplete');
  assert.equal(displayStatus({ ...overLimit, status: 'pending_reflection', actualValue: 0 }), 'pending_reflection');
});