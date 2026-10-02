import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { useGetHabitDecorations, getGetHabitDecorationsQueryKey, useGetHabit, useGetHabitJourney, getGetHabitJourneyQueryKey, getGetHabitQueryKey, useListHabits, useStartHabitJourney } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowRight, Crosshair, Maximize2, Minimize2, Palette } from 'lucide-react';
import { PageHead, Empty, Loading, ErrorBlock } from '@/components/journey-ui';
import { JourneyMap, type FocusRequest } from '@/components/journey/journey-map';
import { Modal } from '@/components/journey/scoped-modal';
import { Layer } from '@/components/journey/layer';
import { closeTopLayer } from '@/components/journey/layers';
import { RewardPanel, landmarkInfo } from '@/components/journey/reward-landmark';
import { NodeDetails } from '@/components/journey/node-details';
import { calendarDay, MILESTONES, needsRolloverRefetch, successCount } from '@/lib/journey-map';
import { base } from '@/lib/journey-map';
import { DecorShop } from '@/components/journey/decor-shop';
import { FullscreenOverlay } from '@/components/journey/fullscreen';
import { writeLastHabit } from '@/lib/decor';
import { RewardEditor, emptyDraft, draftError, buildRewardInput, refreshRewards, type RewardDraft } from '@/components/reward/real-reward';
import { SharingButton } from '@/components/social/sharing';
import { usePhotoUpload } from '@/hooks/use-photo-upload';
import { invalidateDailyAll } from '@/hooks/use-daily';
import { journeyDayFromSearch } from '@/lib/memory-navigation';

export function HabitJourneyPage() {
  const { habitId } = useParams<{ habitId: string }>(), id = Number(habitId), [, nav] = useLocation();
  const search = useSearch(), requestedDay = journeyDayFromSearch(search), requestedReward = new URLSearchParams(search).get('reward') === '1';
  const habit = useGetHabit(id, { query: { enabled: !!id, queryKey: getGetHabitQueryKey(id) } });
  const j = useGetHabitJourney(id, { query: { enabled: !!id, queryKey: getGetHabitJourneyQueryKey(id), refetchOnWindowFocus: true, refetchOnMount: 'always' } });
  const habits = useListHabits();
  const qc = useQueryClient();
  const start = useStartHabitJourney({ mutation: { onSuccess: created => {
    qc.setQueryData(getGetHabitJourneyQueryKey(created.habitId), created);
    invalidateDailyAll(qc, created.habitId);
    refreshRewards(qc, created.habitId);
  } } });
  const [startDraft, setStartDraft] = useState<RewardDraft>(emptyDraft());
  const [starting, setStarting] = useState(false);
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
  const [rewardOpen, setRewardOpen] = useState(requestedReward);
  const [decorOpen, setDecorOpen] = useState(false);
  const [ws, setWs] = useState<HTMLDivElement | null>(null);
  const [focusReq, setFocusReq] = useState<FocusRequest>({ kind: 'day', tick: 0 });
  const tick = useRef(0);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => { const m = window.matchMedia('(max-width: 767px)'); const f = () => setMobile(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  useEffect(() => { setSel(requestedDay); setRewardOpen(requestedReward); setDecorOpen(false); setCel(false); prevSucc.current = null; }, [id]);
  useEffect(() => { setSel(requestedDay); }, [requestedDay]);
  useEffect(() => { if (requestedReward) setRewardOpen(true); }, [requestedReward]);
  useEffect(() => { if (full) return undefined; const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && closeTopLayer(null)) e.preventDefault(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [full]);
  const refetchRef = useRef(j.refetch); refetchRef.current = j.refetch;
  const jRef = useRef(j.data); jRef.current = j.data;
  useEffect(() => { const t = setInterval(() => { const jj = jRef.current; if (jj && needsRolloverRefetch(new Date(), jj)) refetchRef.current(); }, 60000); return () => clearInterval(t); }, []);
  const d = j.data;
  useEffect(() => { if (!d) return; const s = successCount(d, d.today.slice(0, 10)); if (prevSucc.current !== null && s > prevSucc.current) { setCel(true); const t = setTimeout(() => setCel(false), 4000); prevSucc.current = s; return () => clearTimeout(t); } prevSucc.current = s; return undefined; }, [d]);
  const url = (day: number | null, reward = false) => `/habits/${id}/journey${day || reward ? '?' : ''}${[day ? `day=${day}` : '', reward ? 'reward=1' : ''].filter(Boolean).join('&')}`;
  const request = (kind: 'day' | 'reward', day?: number) => setFocusReq({ kind, day, tick: ++tick.current });
  const selectDay = (n: number) => { setSel(n); setRewardOpen(false); nav(url(n), { replace: true }); request('day', n); };
  const closeDetails = () => { setSel(null); nav(url(null, rewardOpen), { replace: true }); };
  const openReward = () => { setSel(null); setRewardOpen(true); nav(url(null), { replace: true }); request('reward'); };
  const closeReward = () => { setRewardOpen(false); if (requestedReward) nav(url(sel), { replace: true }); };
  const focus = () => { const n = d ? calendarDay(d) : 1; setRewardOpen(false); selectDay(n); };
  const deepDone = useRef<string | null>(null);
  useEffect(() => {
    if (!d || !d.days.length) return undefined;
    const key = `${id}:${requestedDay}:${requestedReward}`;
    if (deepDone.current === key) return undefined;
    deepDone.current = key;
    if (!requestedDay && !requestedReward) return undefined;
    const t = setTimeout(() => request(requestedDay ? 'day' : 'reward', requestedDay ?? undefined), 150);
    return () => clearTimeout(t);
  }, [d, id, requestedDay, requestedReward]);
  const picker = habits.data && habits.data.length > 1 && <select className="field !w-auto !py-1 !text-sm" aria-label="اختيار العادة" value={id} onChange={e => nav(`/habits/${e.target.value}/journey`)}>{habits.data.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select>;
  const preservePagePosition = !full && returnPosition.current?.habitId === id
    && !returnPosition.current.controller.signal.aborted
    && returnPosition.current.width === window.innerWidth && returnPosition.current.viewportHeight === window.innerHeight;
  const savedReturn = returnPosition.current;
  const wrap = (c: ReactNode) => full && savedReturn ? <>
    <div aria-hidden="true" data-testid="journey-fullscreen-placeholder" style={{ height: 0 }} />
    <FullscreenOverlay onClose={closeFullscreen} returnSignal={savedReturn.controller.signal} onAfterClose={() => restorePage(savedReturn)}>{c}</FullscreenOverlay>
  </> : c;
  const ready = !(j.isLoading || habit.isLoading) && !(j.isError || habit.isError || !d || !habit.data);
  const hasJourney = ready && !!d && !!d.startDate && !!d.total && d.days.length > 0;
  const state = !ready ? (j.isLoading || habit.isLoading ? <Loading /> : <ErrorBlock retry={() => { j.refetch(); habit.refetch(); }} />) : null;
  const scroller = (c: ReactNode) => <div className="h-full overflow-auto p-5 md:p-8" data-testid="journey-state-scroll"><Link href={`/habits/${id}`} className="btn btn-light mb-3">العودة للعادة</Link><PageHead overline="خريطة الجزر" title={habit.data ? `رحلة ${habit.data.title}` : 'رحلة العادة'} desc="اثنان وعشرون يومًا تقويميًا، وكل يوم له مكانه على الطريق." action={picker || undefined} />{c}</div>;
  let content: ReactNode;
  if (!hasJourney || !d || !habit.data) {
    content = scroller(state ?? <div>
      <Empty title="لا رحلة لهذه العادة" desc="يمكنك بدء 22 يومًا من اليوم، مع إبقاء سجلّك السابق محفوظًا." action={<div className="text-right space-y-3 w-full max-w-sm mx-auto"><RewardEditor draft={startDraft} onChange={setStartDraft} disabled={start.isPending || starting} /><button className="btn" disabled={start.isPending || starting} onClick={startJourney} data-testid="button-start-journey">{start.isPending || starting ? 'جارٍ بدء الرحلة…' : 'ابدأ رحلة لهذه العادة'}</button></div>} />
      {start.isError && <p role="alert" className="text-sm mt-3">تعذّر بدء الرحلة. سجلّك محفوظ؛ حاول مرة أخرى.</p>}
    </div>);
  } else {
    const today = calendarDay(d), day = sel ? d.days.find(x => x.dayNumber === sel) : undefined, detailsOpen = !!day;
    const lm = landmarkInfo(d);
    const obstruct = rewardOpen ? (mobile ? 'bottom' : null) : detailsOpen ? (mobile ? 'bottom' : 'side') : null;
    const pct = Math.min(100, today / 22 * 100);
    const actionCls = 'btn !py-1.5 !px-3 text-sm';
    content = <div className="h-full flex flex-col min-h-0 bg-[#f2ecdc]" data-layout-rev={layoutRevision} data-journey-layout>
      {!full && <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 md:px-4 py-2 border-b border-[#e8dfcb] bg-[#fbf7ed]" data-testid="journey-header">
        <Link href={`/habits/${id}`} aria-label="العودة للعادة" className="btn btn-light !p-2 min-w-9 min-h-9"><ArrowRight size={16} /></Link>
        <div className="min-w-0"><h1 className="font-black text-base leading-tight truncate" data-testid="text-journey-title">رحلة {habit.data.title}</h1>
          <p className="text-xs muted leading-tight" aria-label="تقدّم الرحلة">{d.status === 'not_started' ? 'الرحلة لم تبدأ بعد' : `اليوم ${today} من 22`} · الالتزام: {d.consistency.successfulDays} نجاح • {d.consistency.eligibleDays} أيام مجدولة</p></div>
        <div className="hidden lg:block w-28 h-1.5 rounded-full bg-[#e3d9c9] overflow-hidden" aria-hidden="true"><div className="h-full bg-[#245448]" style={{ width: `${pct}%` }} /></div>
        <span className="badge hidden xl:inline-flex">{d.successful} ناجحة · {d.restDays} راحة · {d.missedDays} فائتة</span>
        <div data-journey-controls className="flex flex-wrap items-center gap-2 ms-auto">
          {picker}
          <button className={actionCls} onClick={focus} data-testid="button-focus-current"><Crosshair size={15} />اذهب إلى اليوم {today}</button>
          <button className={`${actionCls} btn-light`} onClick={() => setDecorOpen(true)} data-testid="button-open-decor"><Palette size={15} />الديكور والمتجر</button>
          <button ref={fsBtn} className={`${actionCls} btn-light`} disabled={closing} onClick={enterFullscreen} data-testid="button-fullscreen"><Maximize2 size={15} />ملء الشاشة</button>
          {d.status === 'completed' && <Link href={`/habits/${id}/journey/complete`} className={`${actionCls} btn-coral`}>ملخص الإكمال</Link>}
        </div>
      </div>}
      <div ref={setWs} className="relative flex-1 min-h-0" data-testid="journey-workspace">
        <JourneyMap journey={d} selected={sel} onSelect={selectDay} placements={deco.data?.placements} focusRequest={focusReq} obstruct={obstruct} landmark={lm} onOpenReward={openReward} />
        {full && <div className="absolute top-2 inset-x-2 z-10 flex items-center gap-3 pointer-events-none" data-testid="journey-hud">
          <div className="paper rounded-2xl px-3 py-2 pointer-events-auto min-w-0 max-w-[60%]"><div className="font-black text-sm truncate">رحلة {habit.data.title}</div><div className="text-xs">اليوم {today} من 22</div><div className="h-1.5 mt-1 rounded-full bg-[#e3d9c9] overflow-hidden"><div className="h-full bg-[#245448]" style={{ width: `${pct}%` }} /></div></div>
          <button className={`${actionCls} pointer-events-auto`} onClick={focus} data-testid="button-focus-current"><Crosshair size={15} /><span className="hidden sm:inline">اليوم {today}</span></button>
          <button className={`${actionCls} btn-light pointer-events-auto ms-auto`} onClick={() => closeFullscreen()} data-testid="button-exit-fullscreen"><Minimize2 size={15} />خروج من ملء الشاشة</button>
        </div>}
        {(d.status === 'expired' || cel) && <div role="status" className={`absolute inset-x-3 ${full ? 'top-20' : 'top-3'} mx-auto max-w-md z-10 paper rounded-2xl p-3 pop flex gap-3 items-center pointer-events-none`}>{cel && <img src={base('component-pikura-star-20750.gif')} alt="" className="h-10 motion-reduce:hidden" />}{d.status === 'expired' && !cel ? 'انتهت الرحلة دون إكمال، وتبقى خريطتك محفوظة كما هي.' : (MILESTONES as readonly number[]).includes(today) ? 'أكملت يوم هذه المحطة. خطوة جديدة في رحلتك.' : 'خطوة اليوم محفوظة. أثر جديد على جزيرتك.'}</div>}
        {ws && detailsOpen && day && <Layer container={ws} modal={mobile} restore={() => document.getElementById(`jnode-${day.dayNumber}`)} variant="details" label={`تفاصيل اليوم ${day.dayNumber}`} onClose={closeDetails} testId="day-details-layer">
          <div className="space-y-3"><NodeDetails key={`${id}:${day.date}`} habit={habit.data} journey={d} day={day} />
            <div data-testid="journey-sharing"><SharingButton resourceType="journey" resourceId={String(id)} title="مشاركة هذه الرحلة" /></div></div>
        </Layer>}
        {ws && rewardOpen && <Layer container={ws} modal restore={() => document.querySelector<HTMLElement>('[data-testid="landmark-reward"]')} variant="reward" label="مكافأة الرحلة" onClose={closeReward} testId="reward-layer"><RewardPanel journey={d} habitId={id} /></Layer>}
      </div>
      {decorOpen && <Modal title="الديكور والمتجر" onClose={() => setDecorOpen(false)}><DecorShop habitId={id} /></Modal>}
    </div>;
  }
  return <div ref={layoutRef} className="h-full min-h-0">{wrap(<div className="h-full min-h-0">{content}</div>)}</div>;
}
