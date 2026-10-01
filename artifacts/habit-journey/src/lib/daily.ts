import type { DailyHabitState, Habit, Reward } from '@workspace/api-client-react';

export type Tone = 'calm' | 'active' | 'good' | 'soft' | 'warn';
export type StatusMeta = { label: string; hint: string; tone: Tone };

/** Single central mapping from persisted backend status to presentation. */
const META: Record<string, StatusMeta> = {
  pending: { label: 'لم تبدأ بعد', hint: 'ابدأ بالحد الأدنى، وكل ما بعده زيادة.', tone: 'calm' },
  in_progress: { label: 'جارية الآن', hint: 'أنت في منتصف الخطوة.', tone: 'active' },
  paused: { label: 'متوقفة مؤقتًا', hint: 'الوقت محفوظ. عد حين تكون جاهزًا.', tone: 'soft' },
  minimum_reached: { label: 'بلغت الحد الأدنى', hint: 'هذا الحد يكفي؛ إكمال الهدف اختياري.', tone: 'good' },
  target_reached: { label: 'بلغت هدف اليوم', hint: 'هدف الغد يبقى كما هو إلا إذا قررت أنت.', tone: 'good' },
  pending_reflection: { label: 'بقيت لحظة تأمّل', hint: 'كيف كانت هذه الخطوة؟', tone: 'soft' },
  completed: { label: 'اكتمل اليوم', hint: 'حُفظ يومك كما هو.', tone: 'good' },
  missed: { label: 'يوم فات', hint: 'لا حكم عليه. أخبرنا ما حدث فقط.', tone: 'warn' },
};
META.incomplete = { label: 'غير مكتملة اليوم', hint: 'القيمة المسجّلة لم تحقق شرط النجاح. هذا وصف لليوم، وليس حكمًا عليك.', tone: 'soft' };
/** Presentation status: backend status, except a finished day below the minimum is honestly incomplete. */
export const displayStatus = (s: DailyHabitState): string => {
  if (s.executionType === 'boolean') return s.status;
  const open = ['pending', 'in_progress', 'paused'].includes(s.status);
  const unsuccessful = s.goalType === 'quit'
    ? s.actualValue != null && s.actualValue > (s.successLimitValue ?? s.targetValue)
    : actualUnits(s) < s.minimumValue;
  return open && unsuccessful && (!!s.finishedAt || (!!s.checkin && !s.checkin.completed)) ? 'incomplete' : s.status;
};
export const statusMeta = (s: string): StatusMeta => META[s] ?? META.pending;

export const toneClass: Record<Tone, string> = {
  calm: 'bg-[#eee9dc] text-[#4b5d54]',
  active: 'bg-[#dbe9d6] text-[#1f5a47]',
  good: 'bg-[#cfe5d4] text-[#1d4f3d]',
  soft: 'bg-[#f3e4c4] text-[#7a5a28]',
  warn: 'bg-[#f2dccf] text-[#8a4a36]',
};

export const executionLabels: Record<string, string> = { duration: 'مؤقّت زمني', count: 'عدّاد', boolean: 'نعم / ليس بعد', limit: 'حد أقصى للتقليل' };
export const inferExecutionType = (h: { executionType?: string | null; unit: string; goalType: string }) =>
  (h.executionType as string | null | undefined) ?? (h.goalType === 'quit' ? 'limit' : h.unit === 'minutes' ? 'duration' : 'count');

export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
};

export const isTimerType = (s: DailyHabitState) => s.executionType === 'duration';
/** Confirmed actuals use habit units. Timer seconds alone are not evidence of activity. */
export const actualUnits = (s: DailyHabitState) => s.actualValue ?? 0;
/** Exact recorded value for display; keeps fractions (5.5), never floors. */
export const fmtUnits = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
/** Zero is an editable initial value today, not a substitute for unknown historical actuals. */
export const displayActualValue = (s: DailyHabitState) => s.actualValue == null && (s.status === 'missed' || !s.eligible) ? '—' : fmtUnits(actualUnits(s));
export const isOpen = (s: DailyHabitState) => ['pending', 'in_progress', 'paused', 'minimum_reached', 'target_reached'].includes(s.status)
  || (['completed', 'pending_reflection'].includes(s.status)
    && s.checkin?.completed === true && s.goalType !== 'quit'
    && (s.executionType === 'count' || s.executionType === 'duration')
    && s.actualValue != null && s.actualValue >= s.minimumValue && s.actualValue < s.targetValue);

export const reasonLabels: [string, string][] = [['too_difficult', 'كانت صعبة'], ['no_time', 'لم أجد وقتًا'], ['forgot', 'نسيت'], ['lost_motivation', 'فقدت الحماس'], ['unexpected', 'حدث أمر غير متوقع'], ['other', 'سبب آخر']];
export const difficultyLabels: [string, string][] = [['easy', 'سهلة'], ['normal', 'عادية'], ['hard', 'صعبة'], ['very_hard', 'صعبة جدًا']];

export const MILESTONE_DAYS = [1, 5, 10, 15, 22];
export const arUnit = (u: string) => (u === 'minutes' ? 'دقيقة' : u === 'pages' ? 'صفحة' : u === 'count' ? 'مرّة' : 'وحدة');
export const dayKey = (d?: string | null) => (d ?? '').slice(0, 10);

/** A persisted wizard choice takes precedence over the legacy reverse association. */
export function findHabitReward(habit: Pick<Habit, 'id' | 'rewardId'> | undefined, rewards: Reward[] | undefined) {
  if (!habit || !rewards) return undefined;
  if (habit.rewardId != null) return rewards.find(r => r.id === habit.rewardId);
  return rewards.find(r => r.habitId === habit.id && !r.isRedeemed) ?? rewards.find(r => r.habitId === habit.id);
}
