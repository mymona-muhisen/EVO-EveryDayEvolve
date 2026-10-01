import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { useGetHabitDecorations, getGetHabitDecorationsQueryKey, useGetHabit, useGetHabitJourney, getGetHabitJourneyQueryKey, getGetHabitQueryKey, useListHabits, useListRewards,  useStartHabitJourney } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { Crosshair, Maximize2 } from 'lucide-react';
import { PageHead, Empty, Loading, ErrorBlock } from '@/components/journey-ui';
import { JourneyMap } from '@/components/journey/journey-map';
import { NodeDetails } from '@/components/journey/node-details';
import { calendarDay, MILESTONES, needsRolloverRefetch, successCount } from '@/lib/journey-map';
import { base } from '@/lib/journey-map';
import { DecorShop } from '@/components/journey/decor-shop';
import { FullscreenOverlay } from '@/components/journey/fullscreen';
import { writeLastHabit } from '@/lib/decor';
import { RewardCard, RewardEditDialog, AddRewardPanel, RewardEditor, emptyDraft, draftError, buildRewardInput, refreshRewards, type RewardDraft } from '@/components/reward/real-reward';
import { SharingButton } from '@/components/social/sharing';
import { usePhotoUpload } from '@/hooks/use-photo-upload';
import { invalidateDailyAll } from '@/hooks/use-daily';
import { journeyDayFromSearch } from '@/lib/memory-navigation';

export function HabitJourneyPage() {
  const { habitId } = useParams<{ habitId: string }>(), id = Number(habitId), [, nav] = useLocation();
  const requestedDay = journeyDayFromSearch(useSearch());
  const habit = useGetHabit(id, { query: { enabled: !!id, queryKey: getGetHabitQueryKey(id) } });
  const j = useGetHabitJourney(id, { query: { enabled: !!id, queryKey: getGetHabitJourneyQueryKey(id), refetchOnWindowFocus: true, refetchOnMount: 'always' } });
  const habits = useListHabits();
  useListRewards();
  const qc = useQueryClient();
  const start = useStartHabitJourney({ mutation: { onSuccess: created => {
    qc.setQueryData(getGetHabitJourneyQueryKey(created.habitId), created);
    invalidateDailyAll(qc, created.habitId);
    refreshRewards(qc, created.habitId);
  } } });
  const [startDraft, setStartDraft] = useState<RewardDraft>(emptyDraft());
  const [starting, setStarting] = useState(false);
  const [editReward, setEditReward] = useState(false);
  const { uploadPhoto } = usePhotoUpload();
  const startJourney = async () => {
    const e = draftError(startDraft); if (e) { toast.error(e); return; }
    setStarting(true);
    try { const journeyReward = await buildRewardInput(startDraft, uploadPhoto); start.mutate({ habitId: id, ...(journeyReward ? { data: { journeyReward } } : {}) }); }
    catch { toast.error('تعذّر رفع صورة المكافأة. لم تبدأ الرحلة.'); } finally { setStarting(false); }
  };
  const [full, setFull] = useState(false);
  const [closing, setClosing] = useState(false);
  const fsBtn = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const currentHabit = useRef(id); currentHabit.current = id;
  const fullRef = useRef(full); fullRef.current = full;
  const closingRef = useRef(false);
  const session = useRef(0);
  const returnPosition = useRef<{ session: number; controller: AbortController; habitId: number; height: number; x: number; y: number; width: number; viewportHeight: number } | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const enterFullscreen = () => {
    if (fullRef.current || closingRef.current) return;
    // Capture before replacing the in-flow page with the portal. Otherwise
    // the document can shrink and clamp its scroll before history is saved.
    returnPosition.current = {
      session: ++session.current, controller: new AbortController(),
      habitId: id, height: layoutRef.current?.offsetHeight ?? 0,
      x: window.scrollX, y: window.scrollY,
      width: window.innerWidth, viewportHeight: window.innerHeight,
    };
    fullRef.current = true;
    setFull(true);
  };
  const closeFullscreen = () => {
    closingRef.current = true;
    fullRef.current = false;
    setClosing(true);
    setFull(false);
  };
  const restorePage = (saved: NonNullable<typeof returnPosition.current>) => {
    if (!layoutRef.current?.isConnected || saved.session !== session.current || fullRef.current) return;
    closingRef.current = false;
    setClosing(false);
    if (saved.controller.signal.aborted || saved.habitId !== currentHabit.current) return;
    if (saved.width === window.innerWidth && saved.viewportHeight === window.innerHeight) {
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
    }
    setLayoutRevision(n => n + 1);
    // React must commit the enabled return button before it can receive focus.
    requestAnimationFrame(() => {
      if (layoutRef.current?.isConnected && saved.session === session.current && saved.habitId === currentHabit.current && !fullRef.current) {
        fsBtn.current?.focus({ preventScroll: true });
      }
    });
  };
  useEffect(() => {
    if (returnPosition.current && returnPosition.current.habitId !== id) {
      returnPosition.current.controller.abort();
      if (fullRef.current) closeFullscreen();
    }
  }, [id]);
  useEffect(() => () => { returnPosition.current?.controller.abort(); }, []);
  const deco = useGetHabitDecorations(id, { query: { enabled: !!id, queryKey: getGetHabitDecorationsQueryKey(id) } });
  useEffect(() => { if (id && habit.data && habits.data?.some(h => h.id === id)) writeLastHabit(id); }, [id, habit.data, habits.data]);
  const [sel, setSel] = useState<number | null>(requestedDay);
  const [cel, setCel] = useState(false);
  const prevSucc = useRef<number | null>(null);
  useEffect(() => { setSel(requestedDay); setCel(false); prevSucc.current = null; window.scrollTo({ top: 0, behavior: 'instant' }); }, [id]);
  useEffect(() => { setSel(requestedDay); }, [requestedDay]);
  const refetchRef = useRef(j.refetch); refetchRef.current = j.refetch;
  const jRef = useRef(j.data); jRef.current = j.data;
  useEffect(() => { const t = setInterval(() => { const jj = jRef.current; if (jj && needsRolloverRefetch(new Date(), jj)) refetchRef.current(); }, 60000); return () => clearInterval(t); }, []);
  const d = j.data;
  useEffect(() => { if (!d) return; const s = successCount(d, d.today.slice(0, 10)); if (prevSucc.current !== null && s > prevSucc.current) { setCel(true); const t = setTimeout(() => setCel(false), 4000); prevSucc.current = s; return () => clearTimeout(t); } prevSucc.current = s; return undefined; }, [d]);
  const selectDay = (n: number) => {
    setSel(n);
    nav(`/habits/${id}/journey?day=${n}`, { replace: true });
    if (window.innerWidth < 1024) requestAnimationFrame(() => {
      const detail = document.querySelector<HTMLElement>('[data-testid="node-details"]');
      detail?.scrollIntoView({ block: 'start', behavior: 'instant' });
      detail?.focus({ preventScroll: true });
    });
  };
  const focus = () => { const n = d ? calendarDay(d) : 1; setSel(n); nav(`/habits/${id}/journey?day=${n}`, { replace: true }); document.getElementById(`jnode-${n}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  const picker = habits.data && habits.data.length > 1 && <select className="field !w-auto" aria-label="اختيار العادة" value={id} onChange={e => nav(`/habits/${e.target.value}/journey`)}>{habits.data.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select>;
  const preservePagePosition = !full && returnPosition.current?.habitId === id
    && !returnPosition.current.controller.signal.aborted
    && returnPosition.current.width === window.innerWidth && returnPosition.current.viewportHeight === window.innerHeight;
  const savedReturn = returnPosition.current;
  const wrap = (c: ReactNode) => full && savedReturn ? <>
    <div aria-hidden="true" data-testid="journey-fullscreen-placeholder" style={{ height: returnPosition.current?.height ?? 0 }} />
    <FullscreenOverlay onClose={closeFullscreen} returnSignal={savedReturn.controller.signal} onAfterClose={() => restorePage(savedReturn)}>{c}</FullscreenOverlay>
  </> : c;
  return <div ref={layoutRef}>{wrap(<div className="page-enter">
    {full ? <div className="flex flex-wrap gap-3 items-center justify-between mb-4"><h1 className="text-xl font-black">{habit.data ? `رحلة ${habit.data.title}` : 'رحلة العادة'}</h1>{picker}</div> : <><Link href={`/habits/${id}`} className="btn btn-light mb-3">العودة للعادة</Link>
    <PageHead overline="خريطة الجزر" title={habit.data ? `رحلة ${habit.data.title}` : 'رحلة العادة'} desc="اثنان وعشرون يومًا تقويميًا، وكل يوم له مكانه على الطريق." action={picker || undefined} /></>}
    {j.isLoading || habit.isLoading ? <Loading /> : j.isError || habit.isError || !d || !habit.data ? <ErrorBlock retry={() => { j.refetch(); habit.refetch(); }} /> : !d.startDate || !d.total || !d.days.length ? <div>
      <Empty title="لا رحلة لهذه العادة" desc="يمكنك بدء 22 يومًا من اليوم، مع إبقاء سجلّك السابق محفوظًا." action={<div className="text-right space-y-3 w-full max-w-sm mx-auto"><RewardEditor draft={startDraft} onChange={setStartDraft} disabled={start.isPending || starting} /><button className="btn" disabled={start.isPending || starting} onClick={startJourney} data-testid="button-start-journey">{start.isPending || starting ? 'جارٍ بدء الرحلة…' : 'ابدأ رحلة لهذه العادة'}</button></div>} />
      {start.isError && <p role="alert" className="text-sm mt-3">تعذّر بدء الرحلة. سجلّك محفوظ؛ حاول مرة أخرى.</p>}
    </div> : (() => {
      const cur = sel ?? calendarDay(d), day = d.days.find(x => x.dayNumber === cur) ?? d.days[0];
      return <><div className="flex flex-wrap gap-2 mb-4" aria-label="تقدّم الرحلة">
        <span className="badge">{d.status === 'not_started' ? 'الرحلة لم تبدأ بعد' : `اليوم ${calendarDay(d)} من 22`}</span>
        <span className="badge">الاتساق: {d.consistency.successfulDays} نجاح من {d.consistency.eligibleDays} أيام مجدولة</span>
      </div><div data-journey-layout className={`grid ${full ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'lg:grid-cols-[minmax(0,560px)_1fr]'} gap-6 items-start`}>
        <div className={`min-w-0 ${full ? 'lg:sticky lg:top-4' : ''}`}>
          {cel && <div role="status" className="paper rounded-2xl p-3 mb-3 pop flex gap-3 items-center"><img src={base('component-pikura-star-20750.gif')} alt="" className="h-10 motion-reduce:hidden" />{(MILESTONES as readonly number[]).includes(calendarDay(d)) ? 'أكملت يوم هذه المحطة. خطوة جديدة في رحلتك.' : 'خطوة اليوم محفوظة. أثر جديد على جزيرتك.'}</div>}
          <JourneyMap journey={d} selected={cur} onSelect={selectDay} placements={deco.data?.placements} fullscreen={full} preservePagePosition={preservePagePosition} layoutRevision={layoutRevision} />
        </div>
        <div className="space-y-4 lg:sticky lg:top-4 min-w-0">
          <div data-journey-controls className="flex flex-wrap gap-2 items-center"><button className="btn" onClick={focus} data-testid="button-focus-current"><Crosshair size={16} />اذهب إلى اليوم {calendarDay(d)}</button>{!full && <button ref={fsBtn} className="btn btn-light" disabled={closing} onClick={enterFullscreen} data-testid="button-fullscreen"><Maximize2 size={16} />ملء الشاشة</button>}<Link href="/character" className="btn btn-light">الشخصية والمتجر</Link><span className="badge">{d.successful} ناجحة · {d.restDays} راحة · {d.missedDays} فائتة</span></div>
          {d.status === 'expired' && <p className="panel rounded-xl p-3 text-sm">انتهت الرحلة دون إكمال، وتبقى خريطتك محفوظة كما هي.</p>}
          {d.status === 'completed' && <Link href={`/habits/${id}/journey/complete`} className="btn btn-coral">ملخص إكمال الرحلة</Link>}
          <NodeDetails key={`${id}:${day.date}`} habit={habit.data} journey={d} day={day} />
          <div className="mb-3" data-testid="journey-sharing"><SharingButton resourceType="journey" resourceId={String(id)} title="مشاركة هذه الرحلة" /></div>
          {(d.realReward || d.status === 'active') && <div data-journey-reward data-testid="journey-reward-wrapper">{d.realReward ? <RewardCard reward={d.realReward} journeyDay={calendarDay(d)} onEdit={() => setEditReward(true)} /> : <AddRewardPanel habitId={id} />}</div>}
          {d.realReward && d.status === 'active' && calendarDay(d) >= 22 && <p role="status" data-testid="text-final-day" className="text-sm font-bold text-[#a8571e]">اليوم الأخير: وجهتك النهائية، عادتك {habit.data.title}، ومكافأتك {d.realReward.title}.</p>}
          {editReward && d.realReward && <RewardEditDialog reward={d.realReward} onClose={() => setEditReward(false)} />}
          <DecorShop habitId={id} />
        </div>
      </div></>;
    })()}
  </div>)}</div>;
}
