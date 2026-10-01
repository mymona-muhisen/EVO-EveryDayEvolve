import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';

// Component-level React SSR only: cached dashboard fixtures, no real API or browser execution.
const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '..');
const api = path.resolve(ui, '../api-server');
const apiRequire = createRequire(path.join(api, 'package.json'));
const esbuild = apiRequire('esbuild');
const work = await mkdtemp(path.join(tmpdir(), 'habit-dashboard-ssr-'));
await symlink(path.join(ui, 'node_modules'), path.join(work, 'node_modules'), 'dir');

const entry = `
  import React from 'react';
  import { renderToPipeableStream } from 'react-dom/server';
  import { Writable } from 'node:stream';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { Router } from 'wouter';
  import { HomePage } from ${JSON.stringify(path.join(ui, 'src/pages/home.tsx'))};
  import { getGetDashboardHomeQueryKey } from '@workspace/api-client-react';
  export async function render(data, error, user = data?.profile) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const key = getGetDashboardHomeQueryKey();
    if (error) {
      const query = client.getQueryCache().build(client, { queryKey: key, queryFn: async () => { throw error; } });
      query.setState({ data: undefined, dataUpdateCount: 0, dataUpdatedAt: 0, error, errorUpdateCount: 1, errorUpdatedAt: 1, fetchFailureCount: 1, fetchFailureReason: error, fetchMeta: null, isInvalidated: false, status: 'error', fetchStatus: 'idle' });
    } else if (data) client.setQueryData(key, data);
    else {
      const query = client.getQueryCache().build(client, { queryKey: key, queryFn: async () => undefined });
      query.setState({ data: undefined, dataUpdateCount: 0, dataUpdatedAt: 0, error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: 'pending', fetchStatus: 'fetching' });
    }
    const element = React.createElement(QueryClientProvider, { client },
      React.createElement(Router, { ssrPath: '/home' }, React.createElement(HomePage, { user }))
    );
    return new Promise((resolve, reject) => {
      let html = '';
      const sink = new Writable({ write(chunk, _encoding, done) { html += chunk; done(); } });
      sink.on('finish', () => { client.clear(); resolve(html); });
      const stream = renderToPipeableStream(element, {
        onAllReady() { stream.pipe(sink); },
        onShellError: reject,
        onError: reject,
      });
    });
  }
`;

await esbuild.build({
  stdin: { contents: entry, resolveDir: ui, sourcefile: 'dashboard-render-entry.tsx', loader: 'tsx' },
  outfile: path.join(work, 'render.mjs'),
  absWorkingDir: ui,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/server', '@tanstack/react-query', 'wouter', 'lucide-react', 'sonner'],
  alias: { '@': path.join(ui, 'src') },
  define: { 'import.meta.env.BASE_URL': '"/"' },
  logLevel: 'silent',
});
const { render } = await import(pathToFileURL(path.join(work, 'render.mjs')).href);
const today = new Date().toISOString().slice(0, 10);
const yesterdayDate = new Date(`${today}T12:00:00Z`);
yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
const yesterday = yesterdayDate.toISOString().slice(0, 10);

const user = {
  id: 'test-user', displayName: 'سارة اختبار', avatarEmoji: '🌱', level: 1, xp: 0, xpToNextLevel: 100,
  coins: 0, motivationStyle: 'encouraging', primaryGoalCategory: null, onboardingCompleted: true,
  timezone: 'UTC', createdAt: '2025-01-01T00:00:00.000Z',
};
const habit = (id = 1, title = 'قراءة') => ({
  id, title, emoji: '📚', category: 'learning', cadence: 'daily', customDays: null, unit: 'minutes',
  executionType: 'duration', targetValue: 20, minimumValue: 5, busyDayValue: null, baselineValue: null,
  successLimitValue: null, cueType: null, cueTime: null, cue: null, startAction: null, friction: null,
  minimumFloor: 0, journeyStartDate: today, journeyLength: 22, journeyCompletedAt: null,
  rewardId: null, difficulty: 'medium', goalType: 'build', isActive: true, currentStreak: 0,
  longestStreak: 0, lastCheckinDate: null, milestones: [], createdAt: '2025-01-01T00:00:00.000Z',
});
const execution = (overrides = {}) => ({
  habitId: 1, date: today, dayNumber: 1, habitDayId: 1, memoryId: null, scheduled: true,
  eligible: true, planRevision: 1, title: 'قراءة', executionType: 'duration', unit: 'minutes',
  targetValue: 20, minimumValue: 5, busyDayValue: null, successLimitValue: null, goalType: 'build',
  cueType: null, cueTime: null, cue: null, startAction: null, status: 'pending', actualValue: null,
  actualSeconds: null, elapsedSeconds: 0, startedAt: null, lastResumedAt: null, pausedAt: null,
  pausedSeconds: 0, finishedAt: null, missedReason: null, note: null, difficulty: null, revision: 0,
  adaptationDecision: null, checkin: null, successfulDays: 0, eligibleDays: 0, rewardMilestones: [],
  ...overrides,
});
const focus = (id = 1, title = 'قراءة', ex = {}) => ({ habit: habit(id, title), execution: execution({ habitId: id, title, ...ex }) });
const character = {
  level: 1, xp: 0, xpToNextLevel: 100, totalXp: 0, nextLevelXp: 100, progressPercent: 0, walletCoins: 0,
  equippedItems: [{ id: 7, name: 'قبعة', slot: 'hat', emoji: '🧢', coinCost: 0, owned: true, equipped: true }],
  recentProgress: [],
};
const home = (overrides = {}) => ({
  date: today, timezone: 'UTC', greeting: 'morning', profile: user, state: 'no_habit',
  focus: null, otherHabits: [], missedDay: null, journey: null, reward: null, character: null,
  time: null, coach: null, friends: [], memory: null,
  sectionStatus: { habits: 'empty', journey: 'empty', reward: 'empty', character: 'empty', time: 'empty', coach: 'empty', social: 'empty', memory: 'empty' },
  ...overrides,
});
const show = data => render(data);
const text = html => html.replace(/<[^>]*>/g, ' ').replaceAll('&nbsp;', ' ').replace(/\s+/g, ' ');
const occurrences = (html, re) => [...html.matchAll(re)].length;
const cleanup = () => rm(work, { recursive: true, force: true });

test.after(cleanup);

test('SSR component: new user gets guided start, not empty-time, coach, or memory cards', async () => {
  const html = await show(home({ state: 'new_user' }));
  assert.match(html, /data-testid="section-new-user"/);
  assert.match(html, /لنفهم أين يذهب يومك/);
  assert.doesNotMatch(html, /data-testid="section-time"|data-testid="section-coach"|data-testid="section-memory"/);
});

test('no habit with a cached opportunity presents the opportunity; without one offers tracking', async () => {
  const opportunity = await show(home({
    time: { session: null, trackedMinutes: 0, intervalMinutes: null, categoryTotals: [], opportunity: 'القراءة بعد الإفطار' },
    coach: { analysis: { status: 'ready', headline: 'ملاحظة', observation: '', pattern: '', opportunity: 'القراءة بعد الإفطار', suggestedChange: { title: 'قراءة', minutes: 5 }, replacements: [] }, analysisDate: '2025-02-01', updatedAt: '2025-02-01T00:00:00Z', isStale: false },
  }));
  assert.match(opportunity, /data-testid="section-opportunity"/);
  assert.match(opportunity, /القراءة بعد الإفطار/);
  const noOpportunity = await show(home());
  assert.match(noOpportunity, /data-testid="section-no-habit"/);
  assert.match(noOpportunity, /data-testid="link-start-tracking"/);
});

test('active and paused tracking keep one primary time control, never a duplicate secondary card', async () => {
  for (const status of ['active', 'paused']) {
    const html = await show(home({
      state: status === 'active' ? 'tracking_active' : 'tracking_paused',
      time: { session: { date: '2025-02-01', status, intervalMinutes: 30, startedAt: '2025-02-01T09:00:00Z', lastCheckinAt: null, nextCheckinAt: null, finishedAt: null }, trackedMinutes: 0, intervalMinutes: 30, categoryTotals: [], opportunity: null },
    }));
    assert.equal(occurrences(html, /data-testid="section-time"/g), 1);
    assert.equal(occurrences(html, /data-testid="button-tracking-toggle"/g), 1);
    assert.match(html, new RegExp(status === 'active' ? 'إيقاف مؤقت' : 'استئناف'));
  }
});

test('coach cached ready, stale, absent, and non-ready analyses have distinct renderings', async () => {
  const coach = (analysis, isStale = false) => home({ time: { session: null, trackedMinutes: 10, intervalMinutes: null, categoryTotals: [], opportunity: null }, coach: { analysis, analysisDate: '2025-01-31', updatedAt: '2025-01-31T00:00:00Z', isStale } });
  const ready = { status: 'ready', headline: 'ملاحظة محفوظة مفيدة', observation: '', pattern: '', opportunity: 'فرصة صغيرة', suggestedChange: { title: 'قراءة', minutes: 5 }, replacements: [] };
  const html = await show(coach(ready, true));
  assert.match(html, /ملاحظة محفوظة مفيدة/);
  assert.match(html, /data-testid="text-coach-stale"/);
  assert.match(html, /data-testid="button-coach-try"/);
  const empty = await show(coach(null));
  assert.match(empty, /لا توجد ملاحظة محفوظة بعد/);
  assert.match(empty, /data-testid="button-refresh-insight"/);
  const none = await show(coach({ status: 'none', headline: '', observation: '', pattern: '', opportunity: '', suggestedChange: { title: '', minutes: 0 }, replacements: [] }));
  assert.match(none, /لا توجد ملاحظة كبيرة اليوم/);
  assert.match(none, /data-testid="button-refresh-insight"/);
});

test('one focus remains primary and additional habits stay compact', async () => {
  const html = await show(home({ focus: focus(), otherHabits: [focus(2, 'مشي'), focus(3, 'كتابة')] }));
  assert.equal(occurrences(html, /data-testid="section-focus"/g), 1);
  assert.equal(occurrences(html, /data-testid="section-other-habits"/g), 1);
  assert.match(html, /مشي/);
  assert.match(html, /كتابة/);
  assert.doesNotMatch(html, /data-testid="card-daily-2"|data-testid="card-daily-3"/);
});

test('daily focus covers execution states, different target/minimum, unknown actual and timer proof', async () => {
  const cases = [
    [{ status: 'pending', actualValue: null }, /ابدأ خطوة اليوم/, /لم يُسجَّل بعد/],
    [{ status: 'in_progress', actualValue: 0 }, /تابع خطوة اليوم/, /المثبّت فعليًا/],
    [{ status: 'paused', actualValue: 0 }, /تابع خطوة اليوم/, /متوقف مؤقتًا/],
    [{ status: 'minimum_reached', actualValue: 5 }, /بلغت الحد الأدنى/, /الحد الأدنى: 5 دقيقة/],
  ];
  for (const [overrides, heading, content] of cases) {
    const html = await show(home({ state: 'habit_in_progress', focus: focus(1, 'قراءة', { ...overrides, targetValue: 20, minimumValue: 5 }) }));
    assert.match(html, heading);
    assert.ok(content.test(text(html)), `execution ${overrides.status} expected ${content}, got ${text(html).match(/<div class="mt-4" data-testid="focus-progress">.*?<\/div>/)?.[0] ?? text(html).slice(0, 700)}`);
    assert.match(text(html), /الهدف: 20 دقيقة/);
  }
  const unknown = await show(home({ focus: focus(1, 'قراءة', { executionType: 'count', unit: 'count', targetValue: 8, minimumValue: 2, actualValue: null }) }));
  assert.match(unknown, /لم يُسجَّل بعد/);
  assert.match(unknown, /aria-valuenow="0"/);
  const timer = await show(home({ focus: focus(1, 'قراءة', { status: 'in_progress', startedAt: '2025-02-01T00:00:00Z', lastResumedAt: '2025-02-01T00:00:00Z', elapsedSeconds: 0, actualSeconds: null }) }));
  assert.match(timer, /الوقت يجري على الخادم/);
  assert.match(timer, /data-testid="button-timer-pause"/);
  assert.doesNotMatch(timer, /data-testid="button-manual-done"/);
  const boolean = await show(home({ focus: focus(1, 'عادة يومية', { executionType: 'boolean', unit: 'count', status: 'pending' }) }));
  assert.match(boolean, /data-testid="button-boolean-yes"/);
  assert.match(boolean, /data-testid="button-boolean-not-yet"/);
  assert.doesNotMatch(boolean, /data-testid="focus-progress"/);
});

test('below-minimum and finished-incomplete executions say the saved work is incomplete', async () => {
  const below = await show(home({ focus: focus(1, 'قراءة', { status: 'in_progress', executionType: 'count', unit: 'count', targetValue: 8, minimumValue: 3, actualValue: 1 }) }));
  assert.match(below, /data-testid="text-incomplete"/);
  const done = await show(home({ focus: focus(1, 'قراءة', { status: 'in_progress', executionType: 'count', unit: 'count', targetValue: 8, minimumValue: 3, actualValue: 1, finishedAt: `${today}T10:00:00Z` }) }));
  assert.match(done, /data-testid="text-finished-incomplete"/);
  assert.match(done, /محفوظ بصدق/);
});

test('quit habits use the success limit and do not show build-goal target/minimum claims', async () => {
  const html = await show(home({ focus: focus(1, 'تقليل الاستخدام', { executionType: 'limit', unit: 'minutes', goalType: 'quit', targetValue: 60, successLimitValue: 30, minimumValue: 0, actualValue: null }) }));
  assert.match(text(html), /النجاح عند 30 دقيقة أو أقل/);
  assert.match(text(html), /الحد 30 دقيقة/);
  assert.doesNotMatch(html, /الهدف:|الحد الأدنى:/);
});

test('SSR missed-day component shows yesterday, six reasons, and explicit adaptation gate', async () => {
  const base = execution({ date: yesterday, status: 'missed', actualValue: null });
  const missed = { habit: habit(), execution: base };
  const html = await show(home({ missedDay: missed }));
  assert.match(html, /أمس لم يسر كما خُطّط له/);
  assert.equal(occurrences(html, /data-testid="button-reason-/g), 6);
  const gated = await show(home({ missedDay: { habit: missed.habit, execution: execution({ date: yesterday, status: 'missed', actualValue: null, missedReason: 'no_time' }) } }));
  assert.match(gated, /data-testid="button-review-adaptation"/);
  assert.doesNotMatch(gated, /data-testid="block-adaptation"/);
});

test('completion hero appears on completed journey despite focus; expired journey gets no hero', async () => {
  const journey = { habitId: 1, title: 'تحدي القراءة', emoji: '📚', currentDay: 22, journeyLength: 22, status: 'completed', successfulDays: 18, eligibleDays: 19, consistencyPercentage: 95, daysRemaining: 0, progressPercent: 100, coinsEarned: 25, xpEarned: 70, earningsPartial: true };
  const completed = await show(home({ state: 'journey_complete', focus: focus(1, 'قراءة', { status: 'completed', actualValue: 20, dayNumber: 22 }), journey }));
  assert.match(completed, /data-testid="section-complete"/);
  assert.match(completed, /السجل جزئي/);
  assert.match(text(completed), /\+\s*70\s*نقطة خبرة/);
  assert.match(text(completed), /\+\s*25\s*عملة/);
  const expired = await show(home({ state: 'journey_complete', journey: { ...journey, status: 'expired' } }));
  assert.doesNotMatch(expired, /data-testid="section-complete"/);
});

test('reward preview reports calendar progress without claim or purchase controls', async () => {
  const reward = { id: 4, habitId: 1, title: 'نزهة خاصة', type: 'physical', description: null, imageUrl: null, estimatedValue: null, status: 'pending', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', unlockedAt: null, claimedAt: null, currentDay: 8, daysRemaining: 14 };
  const html = await show(home({ journey: { habitId: 1, title: 'رحلة', emoji: '📚', currentDay: 8, journeyLength: 22, status: 'active', successfulDays: 3, eligibleDays: 5, consistencyPercentage: 60, daysRemaining: 14, progressPercent: 36, coinsEarned: 0, xpEarned: 0, earningsPartial: false }, reward }));
  assert.match(html, /data-testid="section-reward"/);
  assert.match(text(html), /الحالة: قيد الانتظار/);
  assert.match(html, /aria-valuemax="22" aria-valuenow="8"/);
  assert.doesNotMatch(html, /data-testid="button-claim|data-testid="button-purchase"/);
});

test('global equipped character shares its slot/item projection with widget, journey, and completion hero', async () => {
  const journey = { habitId: 1, title: 'تحدي القراءة', emoji: '📚', currentDay: 22, journeyLength: 22, status: 'completed', successfulDays: 18, eligibleDays: 19, consistencyPercentage: 95, daysRemaining: 0, progressPercent: 100, coinsEarned: 25, xpEarned: 70, earningsPartial: false };
  const html = await show(home({ character, state: 'journey_complete', focus: focus(1, 'قراءة', { status: 'completed', actualValue: 20, dayNumber: 22 }), journey }));
  assert.match(html, /data-testid="section-character"/);
  assert.equal(occurrences(html, /data-equipped-ids="7"/g), 3);
  assert.match(html, /data-testid="dashboard-character"/);
  assert.match(html, /قبعات<!-- -->: <!-- -->قبعة/);
});

test('friend authorized character differs from initial fallback and cheer has a 44px target', async () => {
  const baseFriend = { user: { id: 'friend-1', username: null, displayName: 'ليلى', avatarEmoji: '🌿' }, journey: { journeyId: 9, title: 'رحلة', emoji: '🌱', category: 'health', progressDay: 3, journeyLength: 22, successfulDayCount: 2, consistencyPercentage: 100, completed: false } };
  const authorized = await show(home({ friends: [{ ...baseFriend, character: [{ slot: 'hat', name: 'قبعة', emoji: '🧢' }] }] }));
  assert.match(authorized, /شخصية ليلى/);
  assert.match(authorized, /تجهيزات شخصية ليلى: قبعة/);
  assert.match(authorized, /aria-label="شجّع ليلى"[^>]*class="[^"]*min-h-11/);
  const fallback = await show(home({ friends: [{ ...baseFriend, character: [] }] }));
  assert.match(fallback, /aria-hidden="true"[^>]*>ل</);
  assert.doesNotMatch(fallback, /شخصية ليلى/);
  assert.match(text(fallback), /اليوم\s*3\s*\/\s*22/);
});

test('saved memory renders while absent memory does not fabricate an empty card', async () => {
  const memory = { id: 2, habitId: null, note: null, photoUrl: null, date: '2025-02-01', createdAt: '2025-02-01T00:00:00Z', caption: 'لحظة هادئة', visibility: 'private', updatedAt: '2025-02-01T00:00:00Z', journeyId: null };
  const saved = await show(home({ memory }));
  assert.match(saved, /data-testid="section-memory"/);
  assert.match(saved, /لحظة هادئة/);
  const absent = await show(home());
  assert.doesNotMatch(absent, /data-testid="section-memory"/);
});

test('unavailable section retries remain local and do not replace the usable focus', async () => {
  for (const key of ['habits', 'journey', 'reward', 'character', 'time', 'coach', 'social', 'memory']) {
    const sections = { ...home().sectionStatus, [key]: 'unavailable' };
    const extras = key === 'time' || key === 'coach'
      ? { time: { session: null, trackedMinutes: 1, intervalMinutes: null, categoryTotals: [], opportunity: null } }
      : {};
    const html = await show(home({ ...extras, focus: focus(), sectionStatus: sections }));
    assert.match(html, /data-testid="section-focus"/, `${key} outage removed focus`);
    if (key === 'memory') assert.doesNotMatch(html, /تعذّر تحميل الذكرى/);
    else assert.match(html, /تعذّر تحميل/ , `${key} missing section retry`);
  }
});

test('home query pending and error states render the component boundary without requesting the API', async () => {
  const pending = await render(null, null, user);
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /تحميل الصفحة الرئيسية/);
  const failed = await render(null, new Error('offline'), user);
  assert.match(failed, /تعذّر تحميل هذه الصفحة/);
});
