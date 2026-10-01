import type { HabitDay, HabitJourney } from '@workspace/api-client-react';

/** Static layout only. Never contains completion state. */
export const MILESTONES = [1, 5, 10, 15, 22] as const;
export const STEP_PX = 104;
export const TOP_PAD = 230;
export const MAP_HEIGHT = TOP_PAD + 21 * STEP_PX + 150;
export const nodePos = (dayNumber: number) => ({
  x: 50 + 30 * Math.sin((dayNumber - 1) * 0.95),
  y: TOP_PAD + (22 - dayNumber) * STEP_PX,
});
export const base = (file: string) => `${import.meta.env.BASE_URL}journey-assets/${file}`;

export type IslandCfg = { file: string; day: number; w: number; ratio: number; side: number; props: { file: string; at: number; dx: number; dy: number; w: number }[] };
/** `at` = number of real successful days needed before a prop appears. */
export const ISLANDS: IslandCfg[] = [
  { file: 'island-beginnings.webp', day: 2, w: 62, ratio: 402 / 540, side: 0, props: [{ file: 'station-home.webp', at: 1, dx: 0, dy: -34, w: 38 }] },
  { file: 'island-study.webp', day: 6, w: 56, ratio: 474 / 516, side: 0, props: [{ file: 'component-book-stack.webp', at: 3, dx: -14, dy: -4, w: 16 }, { file: 'station-library.webp', at: 5, dx: 8, dy: -34, w: 38 }] },
  { file: 'island-forest.webp', day: 10, w: 62, ratio: 421 / 557, side: 0, props: [{ file: 'component-coffee.webp', at: 8, dx: -12, dy: 0, w: 12 }, { file: 'station-lighthouse.webp', at: 10, dx: 14, dy: -36, w: 22 }] },
  { file: 'island-dreams.webp', day: 14, w: 56, ratio: 486 / 499, side: 0, props: [{ file: 'component-easel.webp', at: 12, dx: 0, dy: -20, w: 18 }] },
  { file: 'island-heart.webp', day: 18, w: 62, ratio: 414 / 557, side: 0, props: [{ file: 'component-laptop.webp', at: 15, dx: -10, dy: -8, w: 20 }, { file: 'station-restaurant.webp', at: 17, dx: 14, dy: -30, w: 34 }] },
  { file: 'island-adventure.webp', day: 22, w: 66, ratio: 465 / 527, side: 0, props: [{ file: 'station-ferris-wheel.webp', at: 22, dx: 0, dy: -40, w: 40 }] },
];

export type NodeState = 'success' | 'recovered' | 'today' | 'missed' | 'rest' | 'future' | 'pending';
const OK = new Set(['completed', 'recovered', 'target_reached', 'minimum_reached']);

/** Server status authoritative; today (journey.today) is passed in, never read from the browser clock. */
export function classifyDay(d: HabitDay, today: string): NodeState {
  const date = d.date.slice(0, 10);
  if (!d.scheduled || d.status === 'rest') return 'rest';
  if (d.status === 'recovered') return 'recovered';
  if (d.checkin?.completed && (OK.has(d.status) || d.status === 'pending_reflection')) return 'success';
  if (d.status === 'completed') return 'success';
  if (date === today) return d.status === 'missed' ? 'missed' : 'today';
  if (date > today) return 'future';
  return d.status === 'missed' || d.status === 'pending' || d.status.startsWith('recovery') ? 'missed' : 'pending';
}
export const STATE_LABEL: Record<NodeState, string> = {
  success: 'يوم ناجح', recovered: 'يوم مُستعاد', today: 'اليوم', missed: 'يوم فات', rest: 'يوم راحة', future: 'مغلق، لم يحن بعد', pending: 'يوم لم يكتمل',
};
export const STATE_SYMBOL: Record<NodeState, string> = { success: '✓', recovered: '↺', today: '●', missed: 'فات', rest: 'راحة', future: 'قفل', pending: '–' };
export const nodeLabel = (d: HabitDay, s: NodeState) => `اليوم ${d.dayNumber}: ${STATE_LABEL[s]}${(MILESTONES as readonly number[]).includes(d.dayNumber) ? '، محطة' : ''}`;

export const showValue = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));
export const showText = (v: string | null | undefined) => (v ? v : '—');
export const DIFFICULTY_AR: Record<string, string> = { easy: 'سهلة', normal: 'عادية', hard: 'صعبة', very_hard: 'صعبة جدًا' };
export const REASON_AR: Record<string, string> = { too_difficult: 'كانت صعبة', no_time: 'لم أجد وقتًا', forgot: 'نسيت', lost_motivation: 'فقدت الحماس', unexpected: 'حدث أمر غير متوقع', other: 'سبب آخر' };

export function historyRows(d: HabitDay) {
  return {
    target: showValue(d.goalType === 'quit' ? d.successLimitValue : d.targetValue),
    minimum: showValue(d.minimumValue),
    actual: showValue(d.actualValue),
    difficulty: d.difficulty ? DIFFICULTY_AR[d.difficulty] ?? '—' : '—',
    reason: d.missedReason ? REASON_AR[d.missedReason] ?? '—' : '—',
  };
}
/** Recovery is only shown if the server recorded something; always disabled. */
export const hasRecoveryRecord = (d: HabitDay) => d.recoveryUsed > 0 || d.recoveryStatus !== null;

export type ReachedProps = { island: string; file: string }[];
export const propVisible = (successful: number, at: number) => successful >= at;
export const successCount = (j: Pick<HabitJourney, 'days'>, today: string) => j.days.filter(d => { const s = classifyDay(d, today); return s === 'success' || s === 'recovered'; }).length;
/** Unlock is only ever server-provided. */
export const canShowUnlocked = (j: Pick<HabitJourney, 'rewardUnlocked'>) => j.rewardUnlocked === true;
export const calendarDay = (j: Pick<HabitJourney, 'currentDay'>) => Math.min(22, Math.max(1, j.currentDay));

/** Today's daily UI eligibility depends on server date + schedule, never on visual success state. */
export const isTodayExecutable = (d: Pick<HabitDay, 'date' | 'scheduled' | 'status'>, today: string) =>
  d.scheduled && d.status !== 'rest' && d.date.slice(0, 10) === today.slice(0, 10);
/** Gregorian YYYY-MM-DD in the given IANA zone (journey.timezone), not the device zone. */
export function zonedDateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
export const needsRolloverRefetch = (now: Date, journey: { today: string; timezone: string }) => zonedDateKey(now, journey.timezone) !== journey.today.slice(0, 10);
