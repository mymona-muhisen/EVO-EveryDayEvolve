import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'wouter';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Camera, ImagePlus, X, Trash2, RefreshCw, BookHeart } from 'lucide-react';
import {
  useCreateMemory, useUpdateMemory, useDeleteMemory, useListMemories, useGetMemory, listMemories, useListHabits, useGetHabitJourney,
  getListMemoriesQueryKey, getGetMemoryQueryKey, getGetHabitJourneyQueryKey,
  type Memory,
} from '@workspace/api-client-react';
import { Modal as BaseModal, arDate } from '@/components/journey-ui';
import { usePhotoUpload } from '@/hooks/use-photo-upload';
import { invalidateDailyAll } from '@/hooks/use-daily';
import { SharingButton } from '@/components/social/sharing';
import { useRewardImage } from '@/components/reward/real-reward';
import type { HabitDay } from '@workspace/api-client-react';

/** Only a saved, scheduled, elapsed day with a real completed check-in may receive a new memory. */
export const canCaptureDay = (d: HabitDay, today: string) => d.habitDayId != null && d.scheduled && d.date.slice(0, 10) <= today && d.checkin?.completed === true && !d.memoryId;

const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DIFF_AR: Record<string, string> = { easy: 'سهلة', normal: 'عادية', hard: 'صعبة', very_hard: 'صعبة جدًا' };

function Modal(props: Parameters<typeof BaseModal>[0]) {
  // Animated page containers establish fixed-position containing blocks.
  // Keep memory dialogs viewport-bound, but inside fullscreen's focus scope.
  const host = document.querySelector('[data-testid="journey-fullscreen"]') ?? document.body;
  return createPortal(<BaseModal {...props} />, host);
}

/** Normalize API photoUrl ('/api/storage/objects/..') or raw object path to '/objects/..' */
export const memoryPath = (u?: string | null) => (u ? u.replace(/^\/api\/storage(?=\/objects\/)/, '') : null);
export const memoryText = (m: Memory) => (m.caption ?? m.note ?? '').trim();

export function refreshMemories(qc: QueryClient, habitId?: number | null, memoryId?: number) {
  qc.invalidateQueries({ queryKey: getListMemoriesQueryKey() });
  if (memoryId) qc.invalidateQueries({ queryKey: getGetMemoryQueryKey(memoryId) });
  if (habitId) { qc.invalidateQueries({ queryKey: getGetHabitJourneyQueryKey(habitId) }); invalidateDailyAll(qc, habitId); }
}

export function MemoryImage({ photoUrl, className = '', alt = 'صورة من الذكرى' }: { photoUrl?: string | null; className?: string; alt?: string }) {
  const img = useRewardImage(memoryPath(photoUrl));
  if (!img.hasPath) return null;
  if (img.status === 'ok' && img.url) return <img src={img.url} alt={alt} className={`${className} object-cover bg-[#eae4d5]`} />;
  if (img.status === 'error') return <button type="button" onClick={img.retry} data-testid="button-retry-memory-image" className={`${className} bg-[#f6e0d8] text-[#8a4a3a] text-sm flex items-center justify-center gap-2`}><RefreshCw size={15} />تعذّر تحميل الصورة، أعد المحاولة</button>;
  return <div className={`${className} skeleton`} aria-label="تحميل الصورة" />;
}

type Props = { habitId: number; date: string; dayLabel?: string; onClose: () => void; onSaved?: (m: Memory) => void };

export function MemoryCaptureDialog({ habitId, date, dayLabel, onClose, onSaved }: Props) {
  const [file, setFile] = useState<File | null>(null), [caption, setCaption] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [posting, setPosting] = useState(false), [existing, setExisting] = useState<number | null>(null);
  const cancelled = useRef(false), postingRef = useRef(false);
  const safeClose = () => { if (postingRef.current) return; cancelled.current = true; onClose(); };
  const camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null);
  const create = useCreateMemory(), { uploadPhoto } = usePhotoUpload(), qc = useQueryClient();
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => { cancelled.current = true; }, []);
  const pick = (f?: File) => {
    if (!f) return;
    if (!OK_TYPES.includes(f.type)) { setErr('اختر صورة JPEG أو PNG أو WebP.'); return; }
    if (f.size > MAX_BYTES) { setErr('الصورة أكبر من 10 ميغابايت. اختر صورة أصغر.'); return; }
    setErr(''); setFile(f);
  };
  const save = async () => {
    if (!file || busy) return;
    setBusy(true); setErr('');
    try {
      const photoObjectPath = await uploadPhoto(file);
      if (cancelled.current) return;
      postingRef.current = true; setPosting(true);
      const m = await create.mutateAsync({ data: { habitId, date, photoObjectPath, visibility: 'private', ...(caption.trim() ? { caption: caption.trim() } : {}) } });
      refreshMemories(qc, habitId, m.id);
      toast.success('حُفظت الذكرى');
      postingRef.current = false; onSaved?.(m); onClose();
    } catch (e) {
      const st = e && typeof e === 'object' && 'status' in e ? (e as { status: number }).status : 0;
      postingRef.current = false; setPosting(false);
      if (st === 409) { refreshMemories(qc, habitId); try { const l = await listMemories({ habitId }); const f = l.find(x => x.habitDayId != null && x.date.slice(0, 10) === date); if (f && !cancelled.current) setExisting(f.id); } catch { /* keep message */ } }
      if (!cancelled.current) setErr(st === 409 ? 'لهذا اليوم ذكرى محفوظة بالفعل.' : st === 413 || st === 415 ? 'تعذّر قبول هذه الصورة. جرّب صورة JPEG أو PNG أو WebP أقل من 10 ميغابايت.' : 'تعذّر حفظ الذكرى. يومك محفوظ كما هو؛ حاول مجددًا.');
    } finally { postingRef.current = false; if (!cancelled.current) { setBusy(false); setPosting(false); } }
  };
  if (existing) return <MemoryDetailById memoryId={existing} onClose={onClose} />;
  return <Modal title="التقط هذه اللحظة" onClose={safeClose}><div className="space-y-4" dir="rtl" data-testid="memory-capture">
    <p className="text-sm muted">{dayLabel ? `${dayLabel}. ` : ''}صورة خاصة بك وحدك، اختيارية تمامًا ولا تؤثر على نجاح يومك.</p>
    {preview ? <img src={preview} alt="معاينة الصورة" className="w-full max-h-[320px] object-cover rounded-2xl" data-testid="img-memory-preview" />
      : <div className="rounded-2xl border border-dashed border-[#bcc8b8] bg-[#f4f5ea] p-8 text-center"><Camera className="mx-auto mb-2 text-[#41725e]" /><span className="text-sm">لم تختر صورة بعد</span></div>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn min-h-11" disabled={busy} data-testid="button-memory-camera" onClick={() => camera.current?.click()}><Camera size={16} />{file ? 'التقط من جديد' : 'التقط صورة'}</button>
      <button type="button" className="btn btn-light min-h-11" disabled={busy} data-testid="button-memory-gallery" onClick={() => gallery.current?.click()}><ImagePlus size={16} />{file ? 'غيّر من المعرض' : 'من المعرض'}</button>
      {file && <button type="button" className="btn btn-ghost min-h-11" disabled={busy} aria-label="إزالة الصورة" data-testid="button-memory-remove" onClick={() => setFile(null)}><X size={16} />إزالة</button>}
      <input ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" tabIndex={-1} onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
    <textarea className="field min-h-20" maxLength={300} value={caption} onChange={e => setCaption(e.target.value)} placeholder="كلمة قصيرة تتذكّر بها اللحظة (اختياري)" data-testid="input-memory-caption" />
    {err && <p role="alert" data-testid="text-memory-error" className="text-sm text-[#b96355]">{err}</p>}
    {posting && <p role="status" className="text-sm font-bold">نحفظ ذكرى يومك الآن. لحظة من فضلك…</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn min-h-11" disabled={!file || busy || posting} data-testid="button-memory-save" onClick={save}>{busy ? 'نحفظ لحظتك…' : err && file ? 'حاول مجددًا' : 'أضف الذكرى'}</button>
      {existing === null && err.includes('بالفعل') && <button type="button" className="btn btn-light min-h-11" onClick={async () => { try { const l = await listMemories({ habitId }); const f = l.find(x => x.habitDayId != null && x.date.slice(0, 10) === date); if (f && !cancelled.current) setExisting(f.id); } catch { setErr('تعذّر تحميل الذكرى الموجودة.'); } }}>عرض الذكرى الموجودة</button>}
      <button type="button" className="btn btn-light min-h-11" data-testid="button-memory-cancel" disabled={posting} onClick={safeClose}>{busy ? 'إلغاء' : 'ربما لاحقًا'}</button>
    </div>
  </div></Modal>;
}

export function MemoryDetailDialog({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const orig = memoryText(memory), long = orig.length > 300;
  const [text, setText] = useState(long ? '' : orig), [confirm, setConfirm] = useState(false);
  const upd = useUpdateMemory(), del = useDeleteMemory(), qc = useQueryClient();
  const dirty = long ? text.trim().length > 0 : text.trim() !== orig;
  const clearAll = () => upd.mutate({ memoryId: memory.id, data: { caption: null } }, { onSuccess: () => { refreshMemories(qc, memory.journeyId, memory.id); toast.success('مُسحت الكلمة'); }, onError: () => toast.error('تعذّر مسح الكلمة') });
  const linked = memory.habitDayId != null;
  const saveCaption = () => upd.mutate({ memoryId: memory.id, data: { caption: text.trim() || null } }, {
    onSuccess: () => { refreshMemories(qc, memory.journeyId, memory.id); toast.success('حُفظت الكلمة'); },
    onError: () => toast.error('تعذّر حفظ الكلمة'),
  });
  const remove = () => del.mutate({ memoryId: memory.id }, {
    onSuccess: () => { refreshMemories(qc, memory.journeyId, memory.id); toast.success('حُذفت الذكرى. يومك باقٍ كما هو.'); onClose(); },
    onError: () => toast.error('تعذّر حذف الذكرى'),
  });
  return <Modal title={linked ? `اليوم ${memory.dayNumber} من ${memory.journeyLength ?? 22}` : 'ذكرى قديمة'} onClose={onClose}><div className="space-y-4" dir="rtl" data-testid="memory-detail">
    <MemoryImage photoUrl={memory.photoUrl} className="w-full max-h-[360px] min-h-[120px] rounded-2xl" />
    <div className="text-sm space-y-1"><div className="eyebrow">{arDate(memory.date.slice(0, 10))}</div>
      {linked ? <div className="muted">{memory.habitTitle}{memory.actualValue != null && ` · أنجزت ${memory.actualValue}${memory.targetValue != null ? ` من ${memory.targetValue}` : ''}`}{memory.difficulty && ` · ${DIFF_AR[memory.difficulty] ?? ''}`}</div>
        : <div className="muted">ذكرى سابقة غير مرتبطة بيوم محدد من رحلة.</div>}</div>
    {long && <div className="panel rounded-xl p-3 text-sm" data-testid="text-memory-legacy-full"><p className="whitespace-pre-wrap break-words">{orig}</p><p className="text-xs muted mt-2">نص قديم أطول من 300 حرف. يبقى كما هو إلى أن تستبدله بنص أقصر أو تمسحه.</p></div>}
    <textarea className="field min-h-24" maxLength={300} value={text} onChange={e => setText(e.target.value)} placeholder={long ? 'اكتب نصًا بديلًا قصيرًا (حتى 300 حرف)' : 'أضف كلمة لهذه الذكرى'} data-testid="input-memory-detail-caption" />
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn min-h-11" disabled={!dirty || upd.isPending} data-testid="button-memory-save-caption" onClick={saveCaption}>{upd.isPending ? 'نحفظ…' : long ? 'استبدل بنص قصير' : text.trim() ? 'احفظ الكلمة' : 'امسح الكلمة'}</button>
      {long && <button type="button" className="btn btn-light min-h-11" disabled={upd.isPending} onClick={clearAll}>امسح النص القديم</button>}
      {!confirm ? <button type="button" className="btn btn-light min-h-11" data-testid="button-memory-delete" onClick={() => setConfirm(true)}><Trash2 size={15} />حذف الذكرى</button>
        : <div className="flex flex-wrap gap-2 items-center rounded-xl bg-[#f6e0d8] p-2" role="alertdialog"><span className="text-sm">حذف الذكرى؟ يومك ونجاحك لا يتأثران.</span>
          <button type="button" className="btn min-h-11" disabled={del.isPending} data-testid="button-memory-confirm-delete" onClick={remove}>{del.isPending ? 'نحذف…' : 'نعم، احذف'}</button>
          <button type="button" className="btn btn-light min-h-11" onClick={() => setConfirm(false)}>تراجع</button></div>}
    </div>
    <SharingButton resourceType="memory" resourceId={String(memory.id)} title="مشاركة هذه الذكرى" /><p className="text-xs muted m-0">تبقى خاصة بك حتى تختار المشاركة بنفسك، ولا تُنشر تلقائيًا.</p>
  </div></Modal>;
}

export function MemoryDetailById({ memoryId, onClose }: { memoryId: number; onClose: () => void }) {
  const q = useGetMemory(memoryId, { query: { queryKey: getGetMemoryQueryKey(memoryId) } });
  if (q.data) return <MemoryDetailDialog key={q.data.id} memory={q.data} onClose={onClose} />;
  return <Modal title="الذكرى" onClose={onClose}><div dir="rtl" data-testid="memory-detail-state">{q.isError ? <div className="space-y-3"><p role="alert" className="text-sm">تعذّر تحميل الذكرى.</p><button type="button" className="btn min-h-11" onClick={() => q.refetch()}>أعد المحاولة</button></div> : <div className="skeleton h-40" />}</div></Modal>;
}

/** Optional prompt after authoritative success. Never blocks Done. */
export function MemoryPrompt({ habitId, date, dayNumber, memoryId, canCreate = true }: { habitId: number; date: string; dayNumber?: number; memoryId?: number | null; canCreate?: boolean }) {
  const [open, setOpen] = useState(false), [detail, setDetail] = useState(false);
  const one = useGetMemory(memoryId ?? 0, { query: { queryKey: getGetMemoryQueryKey(memoryId ?? 0), enabled: !!memoryId } });
  const mem = memoryId ? one.data : undefined;
  if (!memoryId && !canCreate) return null;
  return <div className="rounded-2xl bg-[#e9efe3] p-4 mt-4 flex items-center gap-3 min-w-0" data-testid="block-memory-prompt">
    {mem ? <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden"><MemoryImage photoUrl={mem.photoUrl} className="w-14 h-14" /></div> : <Camera size={22} className="text-[#41725e] shrink-0" />}
    <div className="min-w-0 flex-1"><b className="block">{memoryId ? 'لهذا اليوم ذكرى' : 'التقط هذه اللحظة'}</b><span className="text-xs muted">{memoryId ? 'يمكنك تحديد من يرى هذه الذكرى.' : 'اختياري. يمكنك العودة إليها لاحقًا.'}</span></div>
    {memoryId ? <button type="button" className="btn btn-light min-h-11" data-testid="button-memory-view" onClick={() => setDetail(true)}>عرض</button>
      : <button type="button" className="btn btn-light min-h-11" data-testid="button-memory-add" onClick={() => setOpen(true)}>أضف ذكرى</button>}
    {open && <MemoryCaptureDialog habitId={habitId} date={date.slice(0, 10)} dayLabel={dayNumber ? `اليوم ${dayNumber}` : undefined} onClose={() => setOpen(false)} />}
    {detail && memoryId && <MemoryDetailById memoryId={memoryId} onClose={() => setDetail(false)} />}
  </div>;
}

/** Memory section inside the journey node details. */
export function DayMemory({ habitId, date, dayNumber, memoryId, canCreate }: { habitId: number; date: string; dayNumber: number; memoryId?: number | null; canCreate: boolean }) {
  return <MemoryPrompt habitId={habitId} date={date} dayNumber={dayNumber} memoryId={memoryId} canCreate={canCreate} />;
}

/** Recap grid of journey memories. */
export function JourneyMemories({ habitId }: { habitId: number }) {
  const q = useListMemories({ habitId }, { query: { queryKey: getListMemoriesQueryKey({ habitId }) } });
  const [sel, setSel] = useState<number | null>(null);
  const linked = (q.data ?? []).filter(m => m.habitDayId != null);
  if (q.isLoading || q.isError || !linked.length) return null;
  return <div className="paper rounded-2xl p-5 mb-4" data-testid="recap-memories"><div className="eyebrow flex items-center gap-2 mb-3"><BookHeart size={15} />ذكريات الرحلة · {linked.length}</div>
    <div className="grid grid-cols-3 gap-2">{linked.map(m => <button key={m.id} type="button" onClick={() => setSel(m.id)} aria-label={`ذكرى اليوم ${m.dayNumber}`} className="rounded-xl overflow-hidden aspect-square"><MemoryImage photoUrl={m.photoUrl} className="w-full h-full" /></button>)}</div>
    <Link href="/memories" className="text-sm underline mt-3 inline-block">كل ذكرياتي</Link>
    {sel && <MemoryDetailById memoryId={sel} onClose={() => setSel(null)} />}
  </div>;
}

/** Chooser: pick habit then an eligible completed day without a memory. */
export function MemoryDayChooser({ onClose }: { onClose: () => void }) {
  const habits = useListHabits(), [hid, setHid] = useState<number | null>(null), [day, setDay] = useState<{ date: string; n: number } | null>(null);
  const j = useGetHabitJourney(hid ?? 0, { query: { queryKey: getGetHabitJourneyQueryKey(hid ?? 0), enabled: !!hid } });
  const eligible = useMemo(() => { const t = j.data?.today.slice(0, 10) ?? ''; return (j.data?.days ?? []).filter(d => canCaptureDay(d, t)); }, [j.data]);
  if (hid && day) return <MemoryCaptureDialog habitId={hid} date={day.date} dayLabel={`اليوم ${day.n}`} onClose={onClose} />;
  return <Modal title="لأي يوم؟" onClose={onClose}><div className="space-y-4" dir="rtl" data-testid="memory-chooser">
    <p className="text-sm muted">الذكرى تُربط بيوم أنجزته فعلًا من رحلتك.</p>
    {habits.isLoading ? <div className="skeleton h-16" /> : !habits.data?.length ? <p className="text-sm">لا عادات بعد.</p>
      : <select className="field" value={hid ?? ''} onChange={e => setHid(e.target.value ? Number(e.target.value) : null)} data-testid="select-memory-habit"><option value="">اختر العادة</option>{habits.data.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select>}
    {hid && (j.isLoading ? <div className="skeleton h-16" /> : j.isError ? <button type="button" className="underline text-sm" onClick={() => j.refetch()}>تعذّر التحميل. أعد المحاولة</button>
      : !eligible.length ? <p className="text-sm panel rounded-xl p-3">لا أيام مكتملة بلا ذكرى في هذه الرحلة.</p>
      : <div className="flex flex-wrap gap-2">{eligible.map(d => <button key={d.dayNumber} type="button" className="btn btn-light min-h-11" data-testid={`button-choose-day-${d.dayNumber}`} onClick={() => setDay({ date: d.date.slice(0, 10), n: d.dayNumber })}>اليوم {d.dayNumber}</button>)}</div>)}
  </div></Modal>;
}
