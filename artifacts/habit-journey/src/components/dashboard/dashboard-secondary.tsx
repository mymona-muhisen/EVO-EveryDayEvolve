import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Coins, Pause, Play, RefreshCw, Sparkles, Heart, Clock3, Check } from 'lucide-react';
import {
  useChangeTrackingSession, useCreateSocialEncouragement, getTrackedDayAnalysis, getGetDashboardHomeQueryKey,
  type DashboardHome, type DashboardFriend,
} from '@workspace/api-client-react';
import { CharacterAvatar, CHARACTER_STILL } from '@/components/character/character-avatar';
import { MemoryImage } from '@/components/memory/memory';
import { newRequestId } from '@/components/social/social-common';
import { dayKey } from '@/lib/daily';
import { memoryDayHref } from '@/lib/memory-navigation';
import { DayInsights } from '@/components/day-insights';
import { Retry, bad } from './dashboard-sections';

/* ---------- time ---------- */
export function TimeCard({ d, onRetry, primary = false }: { d: DashboardHome; onRetry: () => void; primary?: boolean }) {
  const change = useChangeTrackingSession();
  const t = d.time, st = d.sectionStatus.time;
  const [err, setErr] = useState(false);
  if (bad(st)) return <Retry what="ملخص الوقت" onRetry={onRetry} />;
  const s = t?.session, active = s && (s.status as string) !== 'finished' && (s.status as string) !== 'paused', paused = (s?.status as string) === 'paused';
  const toggle = (action: 'pause' | 'resume') => { setErr(false); change.mutate({ data: { date: dayKey(d.date), action } }, { onError: () => setErr(true) }); };
  return <section aria-label="وقتك اليوم" data-testid="section-time" className={primary ? "rounded-[26px] bg-[#dce8d7] border-2 border-[#245448] p-6 min-w-0 text-base" : "paper rounded-[20px] p-5 min-w-0"}>
    <div className="flex items-center gap-2 eyebrow"><Clock3 size={15} aria-hidden="true" /> مرآة يومك</div>
    {t && (active || paused) && s && <div className="mt-2 text-sm"><span className="badge">{paused ? 'التتبع متوقف مؤقتًا' : 'التتبع يعمل'}</span>
      <p className="mt-2">المؤكَّد: <b>{t.trackedMinutes}</b> دقيقة · فترة التتبّع: {s.intervalMinutes} دقيقة</p>
      <button type="button" disabled={change.isPending} className="btn btn-light min-h-11 mt-3" data-testid="button-tracking-toggle" onClick={() => toggle(paused ? 'resume' : 'pause')}>{paused ? <><Play size={15} aria-hidden="true" /> استئناف</> : <><Pause size={15} aria-hidden="true" /> إيقاف مؤقت</>}</button>
      {err && <p role="alert" className="text-xs text-[#8a4a36] mt-2">تعذّر التحديث. حاول مجددًا.</p>}</div>}
    {t && !active && !paused && (t.trackedMinutes > 0 ? <p className="mt-2 text-sm">المؤكَّد اليوم: <b>{t.trackedMinutes}</b> دقيقة</p> : <p className="mt-2 text-sm muted">لا وقت مؤكَّد بعد اليوم.</p>)}
    {!t && <p className="mt-2 text-sm muted">لا تتبّع اليوم. ابدأ حين تشاء.</p>}
    {t && t.categoryTotals.length > 0 && <ul className="mt-3 space-y-1 text-sm">{t.categoryTotals.slice(0, 3).map(c => <li key={c.category} className="flex justify-between gap-2"><span className="truncate">{c.label}</span><b dir="ltr">{Math.floor(c.minutes / 60) > 0 ? `${Math.floor(c.minutes / 60)}h ` : ''}{c.minutes % 60}m</b></li>)}</ul>}
    <Link href="/time" className="inline-flex items-center gap-1 text-sm font-bold mt-3 min-h-11 text-[#23604e]" data-testid="link-view-full-day">عرض اليوم كاملًا <ArrowLeft size={15} aria-hidden="true" /></Link>
  </section>;
}

/* ---------- coach ---------- */
export function CoachCard({ d, onTry, onRetry }: { d: DashboardHome; seedOpp?: (text: string, minutes: number) => void; onTry?: () => void; onRetry: () => void }) {
  const qc = useQueryClient();
  const c = d.coach, a = c?.analysis;
  const key = `${a?.headline ?? ''}|${c?.analysisDate ?? ''}|${c?.updatedAt ?? ''}|${d.profile.id}`;
  const [decision, setDecision] = useState<{ key: string; v: 'try' | 'later' } | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(false);
  const cur = decision && decision.key === key ? decision.v : null;
  const refresh = async () => {
    setBusy(true); setErr(false);
    try { await getTrackedDayAnalysis({ date: dayKey(d.date) }); await qc.invalidateQueries({ queryKey: getGetDashboardHomeQueryKey() }); } catch { setErr(true); }
    setBusy(false);
  };
  if (bad(d.sectionStatus.coach)) return <Retry what="ملاحظة المدرّب" onRetry={onRetry} />;
  const when = c?.analysisDate ? new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'long' }).format(new Date(`${dayKey(c.analysisDate)}T12:00:00`)) : null;
  return <section aria-label="مدرّبك" data-testid="section-coach" className="paper rounded-[20px] p-5 min-w-0">
    <div className="flex items-center gap-2 eyebrow"><Sparkles size={15} aria-hidden="true" /> مدرّبك</div>
    {a && a.status === 'ready' ? <>
      <p className="font-semibold leading-8 mt-3">{a.headline}</p>
      {a.opportunity && <p className="text-sm muted leading-7 mt-1">{a.opportunity}</p>}
      {c?.isStale && <p className="text-xs mt-2 rounded-lg bg-[#f3e4c4] p-2" data-testid="text-coach-stale">هذه ملاحظة محفوظة{when ? ` من ${when}` : ''}.</p>}
      {!cur && a.opportunity && <div className="flex gap-2 mt-3"><button type="button" className="min-h-11 px-3 text-sm underline" data-testid="button-coach-later" onClick={() => setDecision({ key, v: 'later' })}>ليس الآن</button></div>}
      {cur === 'later' && <p role="status" className="text-sm muted mt-3">لا بأس. الملاحظة وحدها خطوة.</p>}
            <Link href="/time" className="inline-flex items-center gap-1 text-sm font-bold min-h-11 text-[#23604e]" data-testid="link-coach-choices">اختر بديلًا من وقتك المستعاد <ArrowLeft size={14} aria-hidden="true" /></Link>
      <div className="mt-3"><DayInsights analysis={a} trackedMinutes={d.time?.trackedMinutes} compact /></div>
    </> : <p className="text-sm muted mt-3 leading-7">{a ? 'لا توجد ملاحظة كبيرة اليوم.' : 'لا توجد ملاحظة محفوظة بعد. يمكنك طلب أول ملاحظة حين تشاء.'}</p>}
    {(c?.isStale || (a && a.status !== 'ready') || (!a && (d.time?.trackedMinutes ?? 0) > 0)) && <button type="button" disabled={busy} className="btn btn-light min-h-11 mt-3" data-testid="button-refresh-insight" onClick={refresh}><RefreshCw size={15} aria-hidden="true" /> {busy ? 'لحظة…' : a ? 'حدّث ملاحظة اليوم' : 'احصل على أول ملاحظة'}</button>}
    {err && <p role="alert" className="text-xs text-[#8a4a36] mt-2">المدرّب يستريح قليلًا. حاول لاحقًا.</p>}
  </section>;
}

/* ---------- character ---------- */
export function CharacterWidget({ d, onRetry }: { d: DashboardHome; onRetry: () => void }) {
  const ch = d.character;
  if (bad(d.sectionStatus.character) || !ch) return bad(d.sectionStatus.character) ? <Retry what="الشخصية" onRetry={onRetry} /> : null;
  return <section aria-label="شخصيتك" data-testid="section-character" className="paper rounded-[20px] p-5 min-w-0">
    <div className="flex gap-4 items-center"><CharacterAvatar items={ch.equippedItems} height={88} testId="dashboard-character" />
      <div className="min-w-0 flex-1"><div className="eyebrow">شخصيتك</div><h2 className="font-black text-lg">المستوى {ch.level}</h2><p className="text-sm inline-flex items-center gap-1"><Coins size={14} aria-hidden="true" />{ch.walletCoins} عملة</p></div></div>
    <div className="flex justify-between text-xs mt-3"><span>نحو المستوى التالي</span><span dir="ltr">{ch.xp} / {ch.nextLevelXp} XP</span></div>
    <div role="progressbar" aria-label="خبرة المستوى" aria-valuemin={0} aria-valuemax={ch.nextLevelXp} aria-valuenow={ch.xp} className="h-2 rounded-full bg-[#e3e0cc] mt-2 overflow-hidden"><div className="h-full bg-[#245448]" style={{ width: `${ch.progressPercent}%` }} /></div>
    <Link href="/character" className="btn btn-light min-h-11 mt-3" data-testid="link-customize">تخصيص</Link>
  </section>;
}

/* ---------- people ---------- */
function Person({ f }: { f: DashboardFriend }) {
  const m = useCreateSocialEncouragement();
  const [sent, setSent] = useState(false);
  const j = f.journey;
  return <li className="flex items-center gap-3 min-w-0 py-2" data-testid={`row-friend-${f.user.id}`}>
    {f.character.length > 0
      ? <CharacterAvatar items={f.character} height={48} src={CHARACTER_STILL} ownerLabel={`شخصية ${f.user.displayName}`} />
      : <span className="w-10 h-10 rounded-full bg-[#e9eee2] flex items-center justify-center font-black shrink-0" aria-hidden="true">{f.user.displayName.slice(0, 1)}</span>}
    <div className="min-w-0 flex-1"><div className="font-bold truncate text-sm">{f.user.displayName}</div>{j && <div className="text-xs muted truncate">{j.title} · اليوم {j.progressDay} / 22</div>}</div>
    {sent ? <span role="status" className="text-xs font-bold inline-flex items-center gap-1"><Check size={14} aria-hidden="true" /> أُرسل</span>
      : <button type="button" disabled={m.isPending} aria-label={`شجّع ${f.user.displayName}`} className="btn btn-light min-h-11 shrink-0" data-testid={`button-cheer-${f.user.id}`}
        onClick={() => m.mutate({ data: { requestId: newRequestId(), receiverUserId: f.user.id, ...(j ? { journeyId: j.journeyId } : {}), type: 'cheer', template: 'nice_work' } }, { onSuccess: () => setSent(true) })}><Heart size={15} aria-hidden="true" />{m.isPending ? '…' : 'شجّع'}</button>}
    {m.isError && <span role="alert" className="text-xs text-[#8a4a36]">تعذّر</span>}
  </li>;
}
export function PeopleCard({ d, onRetry }: { d: DashboardHome; onRetry: () => void }) {
  if (bad(d.sectionStatus.social)) return <Retry what="أصدقائك" onRetry={onRetry} />;
  return <section aria-label="أصدقاؤك" data-testid="section-people" className="paper rounded-[20px] p-5 min-w-0">
    <div className="eyebrow">أصدقاؤك</div>
    {d.friends.length ? <ul className="mt-1 divide-y divide-[#eee6d4]">{d.friends.slice(0, 4).map(f => <Person key={`${f.user.id}:${f.journey?.journeyId ?? 'profile'}`} f={f} />)}</ul>
      : <><p className="font-bold mt-2">لا يجب أن تفعل هذا وحدك.</p><Link href="/friends" className="btn btn-light min-h-11 mt-3" data-testid="link-find-friends">ابحث عن أصدقاء</Link></>}
  </section>;
}

export function MemoryCard({ d }: { d: DashboardHome }) {
  const m = d.memory; if (!m) return null;
  const href = memoryDayHref(m); if (!href) return null;
  const text = (m.caption ?? m.note ?? '').trim();
  return <Link href={href} data-testid="section-memory" className="paper rounded-[20px] p-4 flex gap-3 items-center min-h-11 min-w-0">
    {m.photoUrl && <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0"><MemoryImage photoUrl={m.photoUrl} retryable={false} className="w-14 h-14" /></div>}
    <div className="min-w-0 flex-1"><div className="eyebrow">ذكرى اليوم {m.dayNumber} من رحلتك</div><p className="text-sm truncate">{text || 'ذكرى محفوظة لهذا اليوم'}</p><span className="text-xs underline">افتح يومها على الخريطة</span></div></Link>;
}


export default function SecondaryCards({ d, onRetry, hideTime }: { hideTime?: boolean; d: DashboardHome; onSeed?: (t: string, m: number) => void; onRetry: () => void }) {
  const fresh = d.state === 'new_user';
  const coach = d.sectionStatus.coach === 'unavailable' || !!d.coach?.analysis || (d.time?.trackedMinutes ?? 0) > 0;
  return <>
    {coach && (!fresh || d.sectionStatus.coach === 'unavailable') && <CoachCard d={d} onRetry={onRetry} />}
    {!fresh && !hideTime && <TimeCard d={d} onRetry={onRetry} />}
    <CharacterWidget d={d} onRetry={onRetry} />
    <PeopleCard d={d} onRetry={onRetry} />
    <MemoryCard d={d} />
  </>;
}
