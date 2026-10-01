import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SharingButton } from '@/components/social/sharing';
import { Link } from 'wouter';
import { useClerk } from '@clerk/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gift, Sparkles, ImagePlus, X } from 'lucide-react';
import {
  useCreateJourneyReward, useUpdateJourneyReward, useListHabits, useGetHabitJourney,
  getListJourneyRewardsQueryKey, getGetJourneyRewardQueryKey, getGetHabitJourneyQueryKey, getListHabitsQueryKey, getGetDashboardTodayQueryKey,
  type JourneyReward, type JourneyRewardInput, type DashboardJourneyRewardCard, type Habit,
} from '@workspace/api-client-react';
import { Field, Modal } from '@/components/journey-ui';
import { usePhotoUpload } from '@/hooks/use-photo-upload';
import { invalidateDailyAll } from '@/hooks/use-daily';

/** Private normalized /objects/... path -> authenticated storage route (served at GET /api/storage/objects/*). Anything else is rejected. */
export const rewardImg = (p?: string | null) => (p && /^\/objects\/[^\s]+$/.test(p) ? `/api/storage${p}` : null);

/** Reauthorize private image reads when the identity changes; never reuse a cached owner's bytes. */
export function useRewardImage(path?: string | null) {
  const { session, user } = useClerk();
  const src = rewardImg(path);
  const [state, setState] = useState<{ url: string | null; status: 'idle' | 'loading' | 'ok' | 'error' }>({ url: null, status: src ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!src) { setState({ url: null, status: 'idle' }); return; }
    let live = true, made: string | null = null;
    const controller = new AbortController();
    setState({ url: null, status: 'loading' });
    const load = async () => {
      const token = await session?.getToken();
      const response = await fetch(src, {
        credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      if (!live) return;
      made = URL.createObjectURL(blob);
      setState({ url: made, status: 'ok' });
    };
    void load().catch(() => { if (live) setState({ url: null, status: 'error' }); });
    return () => { live = false; controller.abort(); if (made) URL.revokeObjectURL(made); };
  }, [src, attempt, session, user?.id]);
  return { ...state, hasPath: !!src, retry: () => setAttempt(n => n + 1) };
}

export function refreshRewards(qc: QueryClient, habitId?: number | null, rewardId?: number) {
  qc.invalidateQueries({ queryKey: getListJourneyRewardsQueryKey() });
  if (rewardId) qc.invalidateQueries({ queryKey: getGetJourneyRewardQueryKey(rewardId) });
  qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
  qc.invalidateQueries({ queryKey: getGetDashboardTodayQueryKey() });
  if (habitId) { qc.invalidateQueries({ queryKey: getGetHabitJourneyQueryKey(habitId) }); invalidateDailyAll(qc, habitId); }
}

export type RewardDraft = { enabled: boolean; title: string; type: 'physical' | 'experience'; description: string; value: string; file: File | null; keepPath: string | null };
export const emptyDraft = (): RewardDraft => ({ enabled: false, title: '', type: 'physical', description: '', value: '', file: null, keepPath: null });
export const draftFrom = (r: JourneyReward): RewardDraft => ({ enabled: true, title: r.title, type: r.type, description: r.description ?? '', value: r.estimatedValue == null ? '' : String(r.estimatedValue), file: null, keepPath: r.imageUrl });
export const draftError = (d: RewardDraft) => !d.enabled ? '' : !d.title.trim() ? 'اكتب اسم ما تعمل من أجله' : d.value !== '' && (!Number.isFinite(Number(d.value)) || Number(d.value) < 0) ? 'اكتب قيمة تقديرية صحيحة وغير سالبة' : '';

export async function buildRewardInput(d: RewardDraft, upload: (f: File) => Promise<string>): Promise<JourneyRewardInput | undefined> {
  if (!d.enabled) return undefined;
  const imageObjectPath = d.file ? await upload(d.file) : undefined;
  return { title: d.title.trim(), type: d.type, ...(d.description.trim() ? { description: d.description.trim() } : {}), ...(imageObjectPath ? { imageObjectPath } : {}), ...(d.value !== '' ? { estimatedValue: Number(d.value) } : {}) };
}

export function RewardEditor({ draft, onChange, optional = true, disabled = false }: { draft: RewardDraft; onChange: (d: RewardDraft) => void; optional?: boolean; disabled?: boolean }) {
  const set = (p: Partial<RewardDraft>) => onChange({ ...draft, ...p });
  const local = useMemo(() => (draft.file ? URL.createObjectURL(draft.file) : null), [draft.file]);
  useEffect(() => () => { if (local) URL.revokeObjectURL(local); }, [local]);
  const remote = useRewardImage(draft.file ? null : draft.keepPath);
  const preview = local ?? remote.url;
  return <fieldset disabled={disabled} className="space-y-3 min-w-0" data-testid="reward-editor">
    {optional && <div className="grid grid-cols-2 gap-2">{([[false, 'بدون مكافأة'], [true, 'أعمل من أجل شيء']] as const).map(([v, t]) => <button type="button" key={String(v)} data-testid={v ? 'button-reward-on' : 'button-reward-off'} aria-pressed={draft.enabled === v} onClick={() => set({ enabled: v })} className={`rounded-xl p-3 border text-sm ${draft.enabled === v ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}>{t}</button>)}</div>}
    {draft.enabled && <div className="space-y-3">
      <p className="text-sm font-bold">ما الذي تعمل من أجله؟</p>
      <div className="grid grid-cols-2 gap-2">{([['physical', 'شيء أملكه'], ['experience', 'تجربة أعيشها']] as const).map(([v, t]) => <button type="button" key={v} data-testid={`button-reward-type-${v}`} onClick={() => set({ type: v })} className={`rounded-xl p-3 border text-sm ${draft.type === v ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}>{t}</button>)}</div>
      <Field label="الاسم (مطلوب)"><input data-testid="input-reward-title" className="field" value={draft.title} maxLength={120} onChange={e => set({ title: e.target.value })} placeholder={draft.type === 'physical' ? 'سماعات جديدة' : 'عشاء في مكان أحبه'} /></Field>
      <Field label="وصف (اختياري)"><textarea data-testid="input-reward-description" className="field min-h-20" maxLength={2000} value={draft.description} onChange={e => set({ description: e.target.value })} /></Field>
      <Field label="قيمة تقديرية (اختياري)"><input data-testid="input-reward-value" type="number" min="0" inputMode="decimal" className="field" value={draft.value} onChange={e => set({ value: e.target.value })} /></Field>
      <div className="flex items-center gap-3">
        {preview ? <img src={preview} alt="" className="w-16 h-16 rounded-xl object-cover bg-[#eae4d5]" /> : <div className="w-16 h-16 rounded-xl bg-[#eae4d5] flex items-center justify-center"><Gift size={22} className="text-[#b87755]" /></div>}
        <label className="btn btn-light cursor-pointer"><ImagePlus size={16} /> {preview ? 'غيّر الصورة' : 'أضف صورة'}<input data-testid="input-reward-image" type="file" accept="image/*" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) set({ file: f }); e.target.value = ''; }} /></label>
        {preview && <button type="button" className="btn btn-ghost !p-2" aria-label="إزالة الصورة" onClick={() => set({ file: null, keepPath: null })}><X size={16} /></button>}
      </div>
      <p className="text-xs muted">خاصة بك وحدك. لا شراء ولا دفع؛ هذا وعد تقدّمه لنفسك.</p>
    </div>}
  </fieldset>;
}

const statusAr = { pending: 'في الطريق', unlocked: 'مفتوحة', claimed: 'استلمتها' } as const;
export function RewardThumb({ path, size = 48 }: { path?: string | null; size?: number }) {
  const img = useRewardImage(path);
  if (img.status === 'ok' && img.url) return <img src={img.url} alt="" style={{ width: size, height: size }} className="rounded-xl object-cover bg-[#eae4d5] shrink-0" />;
  if (img.hasPath && img.status === 'error') return <button type="button" onClick={img.retry} data-testid="button-retry-reward-image" style={{ width: size, height: size }} className="rounded-xl bg-[#f6e0d8] text-[#8a4a3a] text-[10px] leading-tight p-1 shrink-0" aria-label="تعذّر تحميل الصورة، اضغط للمحاولة مجددًا">تعذّرت الصورة، أعد</button>;
  if (img.hasPath && img.status === 'loading') return <div style={{ width: size, height: size }} className="skeleton rounded-xl shrink-0" />;
  return <div style={{ width: size, height: size }} className="rounded-xl bg-[#f1e2cf] flex items-center justify-center shrink-0"><Gift size={size * .45} className="text-[#b87755]" /></div>;
}

/** Compact card for the journey sidebar (measured by JourneyMap via data-journey-reward on the wrapper). */
export function RewardCard({ reward, journeyDay, onEdit }: { reward: JourneyReward; journeyDay?: number; onEdit?: () => void }) {
  const day = reward.currentDay ?? journeyDay ?? 0, left = reward.daysRemaining ?? Math.max(0, 22 - day);
  const final = reward.status === 'pending' && day >= 22;
  return <div className={`rounded-2xl p-3 border ${final ? 'bg-[#f6e3c8] border-[#d9a96c]' : 'paper'}`} data-testid="card-journey-reward">
    <div className="flex gap-3 items-center min-w-0"><RewardThumb path={reward.imageUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs muted">{final ? <b className="text-[#a8571e]">اليوم الأخير</b> : <span>{reward.type === 'physical' ? 'مكافأتك' : 'تجربتك'}</span>}<span className="badge !py-0">{statusAr[reward.status]}</span></div>
        <div className="font-bold truncate" data-testid="text-reward-title">{reward.title}</div>
        <div className="text-xs muted">اليوم {day} من 22 · {left === 0 ? (reward.status === 'pending' ? 'اليوم الأخير' : 'وصلت') : `تبقّى ${left} يومًا`}</div>
      </div></div>
    <div className="h-1.5 rounded-full bg-[#e3d9c9] overflow-hidden mt-2"><div className="h-full bg-[#245448]" style={{ width: `${Math.min(100, day / 22 * 100)}%` }} /></div>
    {reward.status === 'pending' && onEdit && <button type="button" data-testid="button-edit-reward" className="text-xs underline mt-2" onClick={onEdit}>تعديل المكافأة</button>}
    {onEdit && <div className="mt-2"><SharingButton resourceType="reward" resourceId={String(reward.id)} title="مشاركة هذه المكافأة" /></div>}
  </div>;
}

export function RewardEditDialog({ reward, onClose }: { reward: JourneyReward; onClose: () => void }) {
  const [d, setD] = useState(() => draftFrom(reward)), [ok, setOk] = useState(false), [busy, setBusy] = useState(false), [fail, setFail] = useState('');
  const upd = useUpdateJourneyReward(), qc = useQueryClient(), { uploadPhoto } = usePhotoUpload();
  const err = draftError(d);
  const save = async () => {
    if (busy || err || !ok) return;
    setBusy(true); setFail('');
    try {
      const img = d.file ? await uploadPhoto(d.file) : d.keepPath ? undefined : null;
      const r = await upd.mutateAsync({ journeyRewardId: reward.id, data: { confirm: true, title: d.title.trim(), type: d.type, description: d.description.trim() || null, estimatedValue: d.value === '' ? null : Number(d.value), ...(img !== undefined ? { imageObjectPath: img } : {}) } });
      refreshRewards(qc, r.habitId ?? reward.habitId, reward.id);
      toast.success('حُفظت مكافأتك'); onClose();
    } catch { setFail('تعذّر حفظ التعديل. مكافأتك كما كانت؛ يمكنك المحاولة مجددًا.'); } finally { setBusy(false); }
  };
  return <Modal title="تعديل المكافأة" onClose={() => { if (!busy) onClose(); }}><div className="space-y-4" dir="rtl">
    <RewardEditor draft={d} onChange={setD} optional={false} disabled={busy} />
    {(err || fail) && <p role="alert" data-testid="text-edit-reward-error" className="text-sm text-[#b96355]">{err || fail}</p>}
    <label className="flex gap-2 items-start text-sm"><input data-testid="checkbox-confirm-reward-edit" type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} className="mt-1" /><span>أؤكد أنني أريد تغيير مكافأة هذه الرحلة. رحلتي وتقدّمي لن يتأثرا.</span></label>
    <button type="button" data-testid="button-save-reward-edit" className="btn" disabled={busy || !ok || !!err} onClick={save}>{busy ? 'نحفظ…' : fail ? 'أعد المحاولة' : 'احفظ التعديل'}</button>
  </div></Modal>;
}

/** Attach a reward to an existing journey that has none. */
export function AddRewardPanel({ habitId }: { habitId: number }) {
  const [open, setOpen] = useState(false), [d, setD] = useState<RewardDraft>({ ...emptyDraft(), enabled: true }), [busy, setBusy] = useState(false), [fail, setFail] = useState('');
  const create = useCreateJourneyReward(), qc = useQueryClient(), { uploadPhoto } = usePhotoUpload();
  const err = draftError(d);
  const save = async () => {
    if (busy) return;
    if (err) { setFail(err); return; }
    setBusy(true); setFail('');
    try {
      const inp = await buildRewardInput(d, uploadPhoto);
      if (!inp) return;
      const r = await create.mutateAsync({ data: { ...inp, habitId } });
      refreshRewards(qc, habitId, r.id); toast.success('ربطنا مكافأتك بالرحلة'); setOpen(false);
    } catch { setFail('تعذّر حفظ المكافأة. حاول مجددًا.'); } finally { setBusy(false); }
  };
  return <><div className="panel rounded-2xl p-3 flex items-center gap-3" data-testid="card-no-reward"><Gift size={20} className="text-[#b87755] shrink-0" /><span className="text-sm flex-1">لا مكافأة لهذه الرحلة بعد.</span><button type="button" data-testid="button-add-reward" className="btn btn-light !py-1.5" onClick={() => setOpen(true)}>أضف مكافأة</button></div>
    {open && <Modal title="ما الذي تعمل من أجله؟" onClose={() => { if (!busy) setOpen(false); }}><div className="space-y-4" dir="rtl"><RewardEditor draft={d} onChange={setD} optional={false} disabled={busy} />{fail && <p role="alert" data-testid="text-add-reward-error" className="text-sm text-[#b96355]">{fail}</p>}<button type="button" data-testid="button-save-reward" className="btn" disabled={busy} onClick={save}>{busy ? 'نحفظ…' : 'احفظ المكافأة'}</button></div></Modal>}</>;
}

export function DashboardRewards({ cards }: { cards?: DashboardJourneyRewardCard[] }) {
  if (!cards?.length) return null;
  return <div className="paper rounded-[22px] p-6 space-y-3" data-testid="dashboard-rewards">
    <div className="eyebrow flex items-center gap-2"><Sparkles size={15} /> ما تعمل من أجله</div>
    {cards.map(c => <Link key={c.habitId} href={`/habits/${c.habitId}/journey`} className="block rounded-xl panel p-3" data-testid={`card-dashboard-reward-${c.habitId}`}>
      <div className="flex gap-3 items-center min-w-0"><RewardThumb path={c.imageUrl} /><div className="min-w-0 flex-1"><div className="font-bold truncate">{c.title}</div><div className="text-xs muted truncate">{c.habitTitle}</div></div></div>
      <div className="flex justify-between text-sm mt-2"><b>اليوم {c.currentDay} من 22</b><span className="muted">{c.daysRemaining === 0 ? (c.status === 'pending' ? 'اليوم الأخير' : 'وصلت') : `تبقّى ${c.daysRemaining} يومًا`}</span></div>
      <div className="h-2 rounded-full bg-[#e3d9c9] overflow-hidden mt-1.5"><div className="h-full bg-[#245448]" style={{ width: `${Math.min(100, c.progressPercent)}%` }} /></div>
      {c.status !== 'pending' && <div className="text-xs mt-1.5 font-bold text-[#245448]">{statusAr[c.status]}</div>}
    </Link>)}
  </div>;
}

type Seen = Record<number, 'done' | 'no' | 'error' | 'loading'>;
function HistoryRow({ habit, report }: { habit: Habit; report: (id: number, s: Seen[number]) => void }) {
  const j = useGetHabitJourney(habit.id, { query: { queryKey: getGetHabitJourneyQueryKey(habit.id) } });
  const st: Seen[number] = j.isLoading ? 'loading' : j.isError ? 'error' : j.data?.status === 'completed' ? 'done' : 'no';
  useEffect(() => { report(habit.id, st); }, [habit.id, st, report]);
  if (j.isLoading) return <div className="skeleton h-16" />;
  if (j.isError) return <div className="panel rounded-xl p-3 text-sm flex justify-between"><span>تعذّر تحميل {habit.title}</span><button type="button" className="underline" onClick={() => j.refetch()}>أعد المحاولة</button></div>;
  const d = j.data;
  if (!d || d.status !== 'completed') return null;
  const r = d.realReward;
  return <div className="panel rounded-xl p-3" data-testid={`history-journey-${habit.id}`}>
    <div className="flex gap-3 items-center min-w-0"><RewardThumb path={r?.imageUrl} /><div className="min-w-0 flex-1"><div className="font-bold truncate">{habit.title}</div><div className="text-xs muted truncate">{r ? `${r.title} · ${statusAr[r.status]}` : 'رحلة بلا مكافأة مرتبطة'}</div></div></div>
    <div className="text-xs muted mt-2">{d.successful} ناجحة · {d.missedDays} فائتة · {d.restDays} راحة</div>
    <div className="flex flex-wrap gap-3 mt-2 text-sm font-bold"><Link href={`/habits/${habit.id}/journey`} className="underline">عرض الخريطة</Link><Link href={`/habits/${habit.id}/journey/complete`} className="underline">الملخص</Link></div>
  </div>;
}

export function JourneyHistory({ footer }: { footer?: ReactNode }) {
  const h = useListHabits();
  const [seen, setSeen] = useState<Seen>({});
  const report = useCallback((id: number, s: Seen[number]) => setSeen(x => x[id] === s ? x : { ...x, [id]: s }), []);
  const ids = (h.data ?? []).map(x => x.id);
  const resolved = ids.length > 0 && ids.every(i => seen[i] && seen[i] !== 'loading');
  const noneDone = resolved && ids.every(i => seen[i] === 'no');
  return <section className="paper rounded-[24px] p-6 max-w-[760px]" data-testid="journey-history">
    <div className="eyebrow mb-1">أرشيفك</div><h2 className="text-xl font-bold mb-3">رحلاتي المكتملة</h2>
    {h.isLoading ? <div className="skeleton h-20" /> : h.isError ? <div className="text-sm">تعذّر تحميل السجل. <button type="button" className="underline" onClick={() => h.refetch()}>أعد المحاولة</button></div>
      : !h.data?.length ? <p className="muted text-sm">حين تكتمل رحلتك الأولى ستبقى هنا، بمكافأتها وخريطتها.</p>
      : <div className="space-y-3">{h.data.map(x => <HistoryRow key={x.id} habit={x} report={report} />)}{noneDone && <div className="panel rounded-xl p-4 text-sm" data-testid="history-empty"><b>لا رحلة مكتملة بعد.</b><p className="muted mt-1">تدخل الرحلة هنا حين تُنهي بنجاح آخر يوم مجدول وتبلغ اليوم الثاني والعشرين. رحلاتك الجارية محفوظة في عاداتي.</p></div>}<p className="text-xs muted">تظهر هنا الرحلات المكتملة بنجاح فقط.</p></div>}
    {footer}
  </section>;
}
