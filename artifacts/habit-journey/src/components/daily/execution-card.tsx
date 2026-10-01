import { Link } from 'wouter';
import { toast } from 'sonner';
import { Play, Pause, Square, Plus, Minus, Check, RefreshCw } from 'lucide-react';
import type { DailyHabitState, Habit } from '@workspace/api-client-react';
import { useState } from 'react';
import { dayKey, displayStatus, displayActualValue, statusMeta, toneClass, fmtClock, actualUnits, fmtUnits, arUnit, isOpen } from '@/lib/daily';
import { useDailyActions, useLiveElapsed } from '@/hooks/use-daily';
import { ReflectionBlock } from './reflection';
import { MemoryPrompt } from '@/components/memory/memory';
import { MissedReasonForm, AdaptationOffer } from './missed-flow';
import { ConsistencyLine } from './consistency';

const big = 'min-h-14 text-base font-bold w-full sm:w-auto';

export function DailyExecutionCard({ state, stamp, habit, title, emoji, linkTo, refetch, today, autoAdaptation = true }: { autoAdaptation?: boolean; today: string;  state: DailyHabitState; stamp: number; habit?: Habit; title?: string; emoji?: string; linkTo?: string; refetch?: () => void }) {
  const { run, pending, celebrate, error } = useDailyActions(state.habitId, state);
  const live = useLiveElapsed(state, stamp);
  const meta = statusMeta(displayStatus(state));
  const [claim, setClaim] = useState(5);
  const [review, setReview] = useState(false);
  const busy = state.busyDayValue;
  const cue = state.cueType === 'time' && state.cueTime ? `عند الساعة ${state.cueTime}` : state.cue;
  const t = state.executionType, unit = arUnit(state.unit), act = actualUnits(state);
  const isToday = dayKey(state.date) === dayKey(today);
  const open = isToday && isOpen(state) && state.scheduled && state.eligible;
  const quit = state.goalType === 'quit', limit = state.successLimitValue ?? state.targetValue;
  const belowMin = open && displayStatus(state) !== 'incomplete' && !quit && t !== 'boolean' && state.status !== 'completed' && state.status !== 'pending_reflection' && !['minimum_reached', 'target_reached'].includes(state.status) && act > 0 && act < state.minimumValue;
  const over = !quit && t !== 'boolean' && act > state.targetValue;
  const mins = (v: number) => (t === 'duration' ? `${v} دقيقة` : `${v} ${unit}`);
  const timerStarted = !!state.startedAt && !state.finishedAt;
  const running = timerStarted && !!state.lastResumedAt && !state.pausedAt;
  const paused = timerStarted && !!state.pausedAt;
  const stopped = !running && !paused;
  const manualSecs = Math.round(state.actualSeconds ?? (state.actualValue ?? 0) * 60);

  return <section className="paper rounded-[22px] p-5 md:p-6" data-testid={`card-daily-${state.habitId}`} aria-live="polite">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {(title || emoji) && (linkTo ? <Link href={linkTo} className="flex items-center gap-2 font-bold text-lg"><span className="text-2xl">{emoji}</span><span className="truncate">{title}</span></Link> : <div className="flex items-center gap-2 font-bold text-lg"><span className="text-2xl">{emoji}</span><span className="truncate">{title}</span></div>)}
        <p className="text-sm muted mt-1">{quit ? `النجاح عند ${limit} ${unit} أو أقل` : `ابدأ بـ ${mins(state.minimumValue)} · هدف اليوم ${mins(state.targetValue)}`}</p>
      </div>
      <span data-testid={`status-daily-${state.habitId}`} className={`shrink-0 text-xs font-bold px-3 py-1.5 rounded-full ${toneClass[meta.tone]}`}>{meta.label}</span>
    </div>
    {cue && state.status === 'pending' && <p className="text-sm mt-3 break-words" data-testid="text-daily-cue">إشارتك: {cue}</p>}
    {(state.startAction ?? null) && state.status === 'pending' && <p className="text-sm mt-3 rounded-xl bg-[#eef0e2] p-3">أول حركة: {state.startAction}</p>}

    {!state.eligible || !state.scheduled ? <p className="text-sm muted mt-4 rounded-xl bg-[#f3ead9] p-3">{state.scheduled ? 'هذا اليوم خارج رحلتك. لا شيء مطلوب.' : 'يوم راحة في خطتك. استرح، لا شيء مطلوب.'}</p> : <>
      {t === 'duration' && <div className="text-center my-5"><div dir="ltr" className="text-[44px] leading-none font-black tabular-nums" style={{ fontFamily: 'Cairo' }} data-testid="text-timer">{fmtClock(open || state.status === 'paused' ? live : (state.actualSeconds ?? state.elapsedSeconds))}</div><div className="text-xs muted mt-2">{state.status === 'in_progress' ? 'الوقت يجري على الخادم، حتى لو أغلقت الصفحة' : state.status === 'paused' ? 'متوقف مؤقتًا' : state.status === 'missed' && state.startedAt ? 'وقت المؤقّت ليس إثباتًا للتنفيذ. لم يُثبَّت إكمال هذا اليوم.' : ''}</div></div>}
      {(t === 'count' || t === 'limit') && <div className="flex items-center justify-center gap-5 my-5">
        <button aria-label="إنقاص" data-testid="button-count-minus" disabled={pending || !open || act <= 0 || (!!state.checkin?.completed && !quit && act - 1 < state.minimumValue)} onClick={() => run('update_progress', act - 1)} className="w-14 h-14 rounded-2xl border-2 border-[#b9c9b6] flex items-center justify-center disabled:opacity-40"><Minus size={22} /></button>
        <div className="text-center min-w-[84px]"><div className="text-[44px] leading-none font-black tabular-nums" data-testid="text-count">{displayActualValue(state)}</div><div className="text-xs muted mt-1">{state.actualValue == null && (state.status === 'missed' || !state.eligible) ? 'لا قيمة مسجّلة' : quit ? `استخدام اليوم · ${unit}` : unit}</div></div>
        <button aria-label="زيادة" data-testid="button-count-plus" disabled={pending || !open} onClick={() => run('update_progress', act + 1)} className="w-14 h-14 rounded-2xl bg-[#245448] text-white flex items-center justify-center disabled:opacity-40"><Plus size={22} /></button>
      </div>}
      {belowMin && <p className="text-sm rounded-xl bg-[#f3e4c4] p-3 mb-3" data-testid="text-incomplete">لم تبلغ الحد الأدنى بعد ({mins(state.minimumValue)}). ما فعلته محسوب كخطوة صغيرة، واليوم ما زال مفتوحًا.</p>}
      {open && t === 'duration' && <div className="flex flex-col sm:flex-row gap-2">
        {!timerStarted && <button data-testid="button-timer-start" disabled={pending} className={`btn ${big}`} onClick={() => run('start')}><Play size={18} /> {state.startedAt ? 'تابع' : `ابدأ (${state.minimumValue} دقيقة تكفي)`}</button>}
        {stopped && manualSecs > 0 && <button data-testid="button-manual-done" disabled={pending} className={`btn btn-light ${big}`} onClick={() => run('done', manualSecs)}><Check size={18} /> انتهيت، ثبّت {fmtUnits(Math.round(manualSecs / 6) / 10)} دقيقة</button>}
        {running && <button data-testid="button-timer-pause" disabled={pending} className={`btn btn-light ${big}`} onClick={() => run('pause')}><Pause size={18} /> إيقاف مؤقت</button>}
        {paused && <button data-testid="button-timer-resume" disabled={pending} className={`btn ${big}`} onClick={() => run('resume')}><Play size={18} /> استئناف</button>}
        {timerStarted && <button data-testid="button-timer-finish" disabled={pending} className={`btn btn-light ${big}`} onClick={() => run('finish')}><Square size={16} /> {['minimum_reached', 'target_reached'].includes(state.status) ? 'أنهِ لليوم' : 'أنهِ بما حققته'}</button>}
      </div>}
      {open && t === 'boolean' && <div className="flex flex-col sm:flex-row gap-2"><button data-testid="button-boolean-yes" disabled={pending} className={`btn ${big}`} onClick={() => run('done')}><Check size={18} /> نعم، فعلتها</button><button data-testid="button-boolean-not-yet" disabled={pending} className={`btn btn-light ${big}`} onClick={() => toast.message('لا بأس. اليوم ما زال مفتوحًا، ولم نسجّل شيئًا.')}>ليس بعد</button></div>}
      {open && (t === 'count' || t === 'limit') && (act > 0 || t === 'limit') && <button data-testid="button-count-done" disabled={pending} className={`btn btn-light ${big} mt-1`} onClick={() => run('done', act)}><Check size={18} /> {t === 'limit' ? 'ثبّت استخدام اليوم' : 'انتهيت لليوم'}</button>}
      {open && !quit && busy != null && stopped && !state.startedAt && state.status === 'pending' && act === 0 && t !== 'boolean' && <button type="button" data-testid="button-busy-day" disabled={pending} className="mt-2 min-h-11 text-sm underline text-[#245448]" onClick={() => run('update_progress', t === 'duration' ? busy * 60 : busy)}>{busy < state.minimumValue ? `يومي مزدحم: سجّل ${busy} ${unit}. تُحسب نسخة صغيرة وغير مكتملة، لا نجاحًا` : `يومي مزدحم: سجّل ${busy} ${unit}`}</button>}
      {open && t === 'duration' && stopped && <div className="mt-3 flex flex-wrap items-center gap-2 min-w-0" data-testid="block-manual-claim"><span className="text-sm muted">أنجزت وقتًا خارج المؤقّت؟</span><input aria-label="دقائق" type="number" min="1" className="field !mb-0 w-24" value={claim} onChange={e => setClaim(Math.max(1, Number(e.target.value) || 1))} /><button type="button" disabled={pending} data-testid="button-manual-claim" className="btn btn-light min-h-11" onClick={() => run('update_progress', Math.max(state.actualSeconds ?? (state.actualValue ?? 0) * 60, state.elapsedSeconds) + claim * 60)}>أضف {claim} دقيقة</button></div>}
      {displayStatus(state) === 'incomplete' && <p className="text-sm mt-3 rounded-xl bg-[#f3e4c4] p-3" data-testid="text-finished-incomplete">{quit ? 'الاستخدام المسجّل أعلى من حد النجاح لهذا اليوم. القيمة محفوظة بصدق، بلا غرامة ولا حكم عليك.' : 'ما سجّلته دون الحد الأدنى، وهو محفوظ بصدق. يمكنك المتابعة الآن، أو غدًا بداية جديدة.'}</p>}
      {(state.status === 'minimum_reached' || (open && state.checkin?.completed && !quit && t !== 'boolean' && act >= state.minimumValue && act < state.targetValue)) && <p className="text-sm mt-3 rounded-xl bg-[#e7efe3] p-3" data-testid="text-minimum-reached">{state.checkin?.completed ? 'نجح الحد الأدنى. تابع نحو الهدف، أو اكتفِ بما أنجزته.' : 'بلغت الحد الأدنى. ثبّت إنجازك بزر الإكمال ليُحتسب اليوم، أو تابع نحو الهدف.'}</p>}
      {over && <p className="text-sm mt-3" data-testid="text-overshoot">تجاوزت هدف اليوم. جميل، لكن هدف الغد يبقى كما هو إلا إذا قررت أنت.</p>}
      {state.status === 'target_reached' && !over && <p className="text-sm mt-3" data-testid="text-target-reached">بلغت هدف اليوم. هدف الغد يبقى كما هو إلا إذا قررت أنت.</p>}
    </>}

    {celebrate && <div role="status" data-testid="toast-celebrate" className="mt-4 rounded-2xl bg-[#214e43] text-[#fff9e9] p-4 pop"><b>اكتملت خطوة اليوم {state.dayNumber}.</b> <span className="text-[#eab879]">+{celebrate.xp} نقطة</span>{celebrate.coins > 0 && <span className="text-[#eab879]"> · +{celebrate.coins} عملة</span>}</div>}
    {error && <div role="alert" className="mt-3 text-sm rounded-xl bg-[#f2dccf] p-3 flex items-center justify-between gap-2"><span>{error}</span><button className="underline shrink-0 flex items-center gap-1" onClick={refetch}><RefreshCw size={13} /> حدّث</button></div>}
    {['pending_reflection', 'minimum_reached', 'target_reached', 'completed'].includes(state.status) && <ReflectionBlock state={state} />}
    {state.checkin?.completed && <MemoryPrompt habitId={state.habitId} date={dayKey(state.date)} dayNumber={state.dayNumber} memoryId={state.memoryId} canCreate={!!state.habitDayId && state.scheduled && state.eligible && state.dayNumber >= 1 && state.dayNumber <= 22} />}
    {state.status === 'missed' && !state.missedReason && <MissedReasonForm state={state} />}
    {habit && (state.missedReason || state.difficulty === 'hard' || state.difficulty === 'very_hard') && (autoAdaptation || review || state.adaptationDecision ? <AdaptationOffer state={state} habit={habit} /> : <button type="button" className="btn btn-light min-h-11 mt-4" data-testid="button-review-adaptation" onClick={() => setReview(true)}>راجع تكييف الخطّة</button>)}
    <div className="mt-4 pt-4 border-t border-[#e8dfce]"><ConsistencyLine compact successful={state.successfulDays} eligible={state.eligibleDays} /></div>
  </section>;
}
