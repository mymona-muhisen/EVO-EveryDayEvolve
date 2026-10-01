import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Coins, Pause, Play, RefreshCw, Sparkles, Heart, Clock3, Check, Flag } from 'lucide-react';
import {
  useChangeTrackingSession, useCreateSocialEncouragement, getTrackedDayAnalysis, getGetDashboardHomeQueryKey,
  type DashboardHome, type DashboardFocus, type DashboardFriend, type DashboardSectionStatus,
} from '@workspace/api-client-react';
import { CharacterAvatar, CHARACTER_STILL } from '@/components/character/character-avatar';
import { MemoryImage } from '@/components/memory/memory';
import { newRequestId } from '@/components/social/social-common';
import { MissedReasonForm, AdaptationOffer } from '@/components/daily/missed-flow';
import { arDate } from '@/components/journey-ui';
import { DailyExecutionCard } from '@/components/daily/execution-card';
import { displayStatus, displayActualValue, actualUnits, statusMeta, toneClass, fmtUnits, arUnit, dayKey } from '@/lib/daily';

export const Retry = ({ what, onRetry }: { what: string; onRetry: () => void }) =>
  <div role="alert" className="rounded-2xl bg-[#f6e6d8] p-4 text-sm flex flex-wrap items-center justify-between gap-2">
    <span>تعذّر تحميل {what}. بقية الصفحة تعمل.</span>
    <button type="button" className="btn btn-light min-h-11" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" /> إعادة المحاولة</button>
  </div>;

export const greetingText = (g: DashboardHome['greeting']) => g === 'morning' ? 'صباح الخير' : g === 'evening' ? 'مساء الخير' : 'ليلة هادئة';
export const bad = (s: DashboardSectionStatus) => s === 'unavailable';

/* ---------- Tier 1: today's focus ---------- */
function actionHeading(f: DashboardFocus) {
  const s = f.execution.status, ds = displayStatus(f.execution);
  if (ds === 'incomplete') return 'ما سجّلته محفوظ. تابع أو ابدأ غدًا من جديد';
  if (!f.execution.scheduled || !f.execution.eligible) return 'يوم راحة في خطتك';
  if (f.execution.checkin?.completed && f.execution.goalType !== 'quit' && f.execution.executionType !== 'boolean' && f.execution.actualValue != null) {
    if (f.execution.actualValue >= f.execution.targetValue) return 'اكتمل هدف اليوم';
    if (f.execution.actualValue >= f.execution.minimumValue) return 'نجح الحد الأدنى: تابع نحو الهدف أو اكتفِ لليوم';
  }
  if (s === 'in_progress' || s === 'paused') return 'تابع خطوة اليوم';
  if (s === 'minimum_reached') return 'بلغت الحد الأدنى: تابع أو أنهِ لليوم';
  if (s === 'target_reached' || s === 'completed' || s === 'pending_reflection') return 'اكتملت خطوة اليوم';
  return 'ابدأ خطوة اليوم';
}

export function FocusBar({ ex }: { ex: DashboardFocus['execution'] }) {
  const dur = ex.executionType === 'duration', quit = ex.goalType === 'quit';
  if (ex.executionType === 'boolean') return null;
  const recorded = ex.actualValue != null;
  const actual = actualUnits(ex);
  const goal = quit ? (ex.successLimitValue ?? ex.targetValue) : ex.targetValue;
  const pct = recorded && goal > 0 ? Math.min(100, Math.round(actual / goal * 100)) : 0;
  const minPct = !quit && goal > 0 ? Math.min(100, Math.round(ex.minimumValue / goal * 100)) : 0;
  const u = dur ? 'دقيقة' : arUnit(ex.unit);
  return <div className="mt-4" data-testid="focus-progress">
    <div className="flex justify-between text-xs mb-2"><span>{quit ? 'الاستخدام المسجّل' : 'المثبّت فعليًا'}: {recorded ? <><b dir="ltr">{displayActualValue(ex)}</b> {u}</> : <b>لم يُسجَّل بعد</b>}</span><span>{quit ? 'الحد' : 'الهدف'} {fmtUnits(goal)} {u}</span></div>
    <div role="progressbar" aria-label={quit ? 'الاستخدام المسجّل مقارنة بحد النجاح' : 'تقدّم اليوم'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="relative h-3 rounded-full bg-[#e3e0cc] overflow-hidden">
      <div className="h-full rounded-full bg-[#245448] transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      {minPct > 0 && minPct < 100 && <span className="absolute top-0 h-full w-0.5 bg-[#ce7555]" style={{ insetInlineStart: `${minPct}%` }} aria-hidden="true" />}
    </div>
  </div>;
}

export function FocusSection({ d, focus, stamp, onRefetch }: { d: DashboardHome; focus: DashboardFocus; stamp: number; onRefetch: () => void }) {
  const ex = focus.execution, j = d.journey?.habitId === focus.habit.id ? d.journey : null;
  const dur = ex.executionType === 'duration', quit = ex.goalType === 'quit';
  const u = dur ? 'دقيقة' : arUnit(ex.unit);
  return <section aria-label="تركيز اليوم" data-testid="section-focus" className="rounded-[26px] bg-[#fffaf0] border-2 border-[#245448] p-4 md:p-6 shadow-[0_14px_40px_rgba(36,84,72,.1)]">
    <div className="eyebrow">تركيز اليوم</div>
    <h2 className="text-2xl md:text-3xl font-black mt-1" data-testid="text-action-heading">{actionHeading(focus)}</h2>
    <div className="flex flex-wrap gap-2 mt-3 text-xs font-bold">
      {!quit && ex.executionType !== 'boolean' && <>
        <span className="badge">الهدف: {fmtUnits(ex.targetValue)} {u}</span>
        <span className="badge !bg-[#f3e4c4] !text-[#7a5a28]">الحد الأدنى: {fmtUnits(ex.minimumValue)} {u}</span></>}
      {ex.dayNumber >= 1 && <span className="badge">يوم الرحلة {ex.dayNumber} من 22</span>}
      {j?.consistencyPercentage != null && <span className="badge !bg-[#dfe9f0] !text-[#2d4f66]">الاتساق {Math.round(j.consistencyPercentage)}%</span>}
    </div>
    {!quit && ex.executionType !== 'boolean' && <p className="text-sm text-[#4b6c5d] mt-3 leading-7">حتى في اليوم الصعب، الحد الأدنى يُبقي رحلتك تتحرك.</p>}
    <FocusBar ex={ex} />
    <div className="mt-4 -mx-1"><DailyExecutionCard autoAdaptation={false} today={dayKey(d.date)} state={ex} stamp={stamp} habit={focus.habit} title={focus.habit.title} emoji={focus.habit.emoji} linkTo={`/habits/${focus.habit.id}`} refetch={onRefetch} /></div>
  </section>;
}

export function OtherHabits({ items }: { items: DashboardFocus[] }) {
  if (!items.length) return null;
  return <section aria-label="عادات أخرى اليوم" data-testid="section-other-habits" className="paper rounded-[20px] p-4">
    <div className="eyebrow mb-2">عادات أخرى اليوم</div>
    <ul className="divide-y divide-[#eee6d4]">{items.map(h => { const m = statusMeta(displayStatus(h.execution)); return <li key={h.habit.id}>
      <Link href={`/habits/${h.habit.id}`} className="flex items-center gap-3 min-h-11 py-2 min-w-0"><span className="text-xl" aria-hidden="true">{h.habit.emoji}</span><span className="font-bold truncate flex-1">{h.habit.title}</span><span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${toneClass[m.tone]}`}>{m.label}</span></Link></li>; })}</ul>
  </section>;
}

/* ---------- Tier 2 ---------- */
export function JourneyPreview({ d }: { d: DashboardHome }) {
  const j = d.journey; if (!j) return null;
  const day = Math.min(22, Math.max(0, j.currentDay));
  const pos = day <= 1 ? 0 : (day - 1) / 21 * 100;
  return <section aria-label="معاينة الرحلة" data-testid="section-journey" className="paper rounded-[22px] p-5 min-w-0">
    <div className="flex items-center justify-between gap-2"><div className="min-w-0"><div className="eyebrow">رحلتك</div><h2 className="font-black text-lg truncate">{j.title}</h2></div><span className="badge shrink-0">اليوم {day} / 22</span></div>
    <div className="relative mt-8 mb-2 h-10" role="img" aria-label={`اليوم ${day} من 22`}>
      <div className="absolute inset-x-3 bottom-1 flex justify-between items-center">{Array.from({ length: 22 }, (_, i) => <span key={i} className={`rounded-full ${i + 1 === day ? 'w-3 h-3 bg-[#ce7555]' : i + 1 < day ? 'w-2 h-2 bg-[#245448]' : 'w-1.5 h-1.5 bg-[#cdc8b2]'}`} />)}</div>
      <div className="absolute inset-x-3 bottom-0 h-0"><span className="absolute -translate-y-[calc(100%-4px)]" style={{ insetInlineStart: `calc(${pos}% - 17px)` }}><CharacterAvatar items={d.character?.equippedItems ?? []} src={CHARACTER_STILL} height={40} /></span></div>
    </div>
    <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
      <div className="panel rounded-xl p-3"><div className="muted">اتساقك</div><b className="text-base">{j.consistencyPercentage != null ? `${Math.round(j.consistencyPercentage)}%` : '—'}</b><div className="muted">{j.successfulDays} من {j.eligibleDays} يوم</div></div>
      <div className="panel rounded-xl p-3"><div className="muted">المتبقي</div><b className="text-base">{j.daysRemaining} يوم</b><div className="muted">من أيام التقويم</div></div>
    </div>
    <Link href={`/habits/${j.habitId}/journey`} className="btn btn-light mt-4 min-h-11" data-testid="link-open-journey">افتح الرحلة <ArrowLeft size={16} aria-hidden="true" /></Link>
  </section>;
}

export function RewardPreview({ d }: { d: DashboardHome }) {
  const r = d.reward; if (!r) return null;
  const day = r.currentDay ?? d.journey?.currentDay ?? 0, pct = Math.round(day / 22 * 100);
  const st = r.status === 'pending' ? 'قيد الانتظار' : r.status === 'unlocked' ? 'مفتوحة' : 'مُستلمة';
  return <section aria-label="مكافأتك" data-testid="section-reward" className="rounded-[22px] bg-[#f3e4c4] border border-[#e4cf9d] p-5 min-w-0">
    <div className="flex gap-3 items-center min-w-0">
      {r.imageUrl && <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0"><MemoryImage photoUrl={r.imageUrl} className="w-16 h-16" alt={`صورة مكافأة ${r.title}`} /></div>}
      <div className="min-w-0 flex-1"><div className="eyebrow">مكافأتك الشخصية</div><h2 className="font-black text-lg break-words">{r.title}</h2><span className="text-xs font-bold">الحالة: {st}</span></div>
    </div>
    <div className="flex justify-between text-xs mt-4"><span>اليوم {day} من 22</span><span>متبقٍ {r.daysRemaining ?? Math.max(0, 22 - day)} يوم</span></div>
    <div role="progressbar" aria-label="تقدّم أيام المكافأة" aria-valuemin={0} aria-valuemax={22} aria-valuenow={day} className="h-2 rounded-full bg-[#e8d4a6] mt-2 overflow-hidden"><div className="h-full bg-[#b26648] rounded-full" style={{ width: `${pct}%` }} /></div>
    <Link href="/rewards" className="inline-flex items-center gap-1 text-sm font-bold mt-3 min-h-11 text-[#7a4a2d]">المكافآت <ArrowLeft size={15} aria-hidden="true" /></Link>
  </section>;
}

/* ---------- completion ---------- */
export function CompletionHero({ d, onAnother, compact = false }: { d: DashboardHome; onAnother: () => void; compact?: boolean }) {
  const j = d.journey!, ch = d.character, unlocked = d.reward && d.reward.status !== 'pending';
  return <section aria-label="اكتملت رحلتك" data-testid="section-complete" className="rounded-[28px] bg-[#214e43] text-[#fff9e9] p-6 md:p-8 grid md:grid-cols-[1fr_auto] gap-5 items-center">
    <div><div className="text-[#e8b87e] text-sm font-bold">{j.title}</div><h2 className={`${compact ? 'text-2xl' : 'text-3xl'} font-black mt-1`}>اكتملت رحلتك</h2>
      <ul className="grid grid-cols-2 gap-2 mt-4 text-sm">
        <li className="rounded-xl bg-[#ffffff14] p-3">22 يومًا تقويميًا</li>
        <li className="rounded-xl bg-[#ffffff14] p-3">{j.successfulDays} يومًا ناجحًا</li>
        <li className="rounded-xl bg-[#ffffff14] p-3">+{j.xpEarned} نقطة خبرة</li>
        <li className="rounded-xl bg-[#ffffff14] p-3 inline-flex items-center gap-1"><Coins size={14} aria-hidden="true" />+{j.coinsEarned} عملة</li>
      </ul>
      {j.earningsPartial && <p className="text-xs text-[#c9ddd0] mt-2">السجل جزئي: بعض الأيام القديمة بلا مكافآت مسجّلة.</p>}
      {unlocked && d.reward && <p className="mt-3 text-[#e8b87e] font-bold">فُتحت مكافأتك: {d.reward.title}</p>}
      <div className="flex flex-wrap gap-2 mt-5"><Link href={`/habits/${j.habitId}/journey`} className="btn min-h-11 !bg-[#eab879] !border-[#eab879] !text-[#173b34]">عرض الرحلة</Link><button type="button" className="btn btn-light min-h-11" onClick={onAnother} data-testid="button-start-another">ابدأ رحلة أخرى</button></div></div>
    {ch && <div className="justify-self-center"><CharacterAvatar items={ch.equippedItems} height={compact ? 80 : 120} /></div>}
  </section>;
}

/* ---------- empty / guided ---------- */
export function GuidedStart() {
  const steps = ['افهم يومك', 'تتبّع جزءًا صغيرًا منه', 'احصل على أول ملاحظة', 'أنشئ أول عادة'];
  return <section data-testid="section-new-user" className="paper rounded-[26px] p-6 md:p-8">
    <div className="eyebrow">البداية</div><h2 className="text-2xl md:text-3xl font-black mt-1">لنفهم أين يذهب يومك</h2>
    <ol className="mt-5 space-y-2">{steps.map((s, i) => <li key={s} className="flex items-center gap-3 text-sm"><span className="w-8 h-8 rounded-full bg-[#e9eee2] text-[#245448] font-black flex items-center justify-center shrink-0">{i + 1}</span>{s}</li>)}</ol>
    <Link href="/time" className="btn mt-6 min-h-12" data-testid="link-start-tracking"><Flag size={16} aria-hidden="true" /> ابدأ التتبع</Link>
  </section>;
}
export function Opportunity({ d, onExplore }: { d: DashboardHome; onExplore: () => void }) {
  return <section data-testid="section-opportunity" className="rounded-[26px] bg-[#dce8d7] border border-[#c2d4be] p-6">
    <div className="eyebrow">وجدت فرصة</div><h2 className="text-2xl font-black mt-1">حوّلها إلى عادة صغيرة</h2>
    {d.coach?.analysis?.opportunity && <p className="text-sm leading-7 mt-2">{d.coach.analysis.opportunity}</p>}
    <button type="button" className="btn mt-4 min-h-12" data-testid="button-explore-suggestion" onClick={onExplore}>استكشف الاقتراح</button>
  </section>;
}

const prevDay = (k: string) => { const t = new Date(`${k}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
export function MissedDayReflection({ d, item }: { d: DashboardHome; item: DashboardFocus }) {
  const ex = item.execution, [review, setReview] = useState(false);
  const yest = dayKey(ex.date) === prevDay(dayKey(d.date));
  const when = arDate(ex.date);
  return <section aria-label="يوم يحتاج وقفة" data-testid="section-missed" className="rounded-[22px] bg-[#f3e4c4] border border-[#e4cf9d] p-5">
    <div className="eyebrow">{item.habit.title}</div>
    <h2 className="text-xl font-black mt-1">{yest ? 'أمس لم يسر كما خُطّط له.' : `يوم ${when} لم يسر كما خُطّط له.`}</h2>
    <p className="text-sm mt-1 leading-7">لا عقاب هنا. ما الذي وقف في الطريق؟</p>
    {!ex.missedReason ? <MissedReasonForm state={ex} /> : <>
      <p className="text-sm mt-3 font-bold">سجّلت السبب. شكرًا لصدقك.</p>
      {ex.adaptationDecision || review ? <AdaptationOffer state={ex} habit={item.habit} /> : <button type="button" className="btn btn-light min-h-11 mt-3" data-testid="button-review-adaptation" onClick={() => setReview(true)}>راجع تكييف الخطّة</button>}</>}
  </section>;
}
