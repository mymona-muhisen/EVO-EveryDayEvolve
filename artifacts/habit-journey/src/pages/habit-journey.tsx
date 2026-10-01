import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import { useGetHabitDecorations, getGetHabitDecorationsQueryKey, useGetHabit, useGetHabitJourney, getGetHabitJourneyQueryKey, getGetHabitQueryKey, useListHabits, useListRewards, useStartHabitJourney } from '@workspace/api-client-react';
import { Crosshair, Maximize2 } from 'lucide-react';
import { PageHead, Empty, Loading, ErrorBlock } from '@/components/journey-ui';
import { JourneyMap } from '@/components/journey/journey-map';
import { NodeDetails } from '@/components/journey/node-details';
import { calendarDay, MILESTONES, needsRolloverRefetch, successCount } from '@/lib/journey-map';
import { base } from '@/lib/journey-map';
import { DecorShop } from '@/components/journey/decor-shop';
import { FullscreenOverlay } from '@/components/journey/fullscreen';
import { writeLastHabit } from '@/lib/decor';
import { invalidateDailyAll } from '@/hooks/use-daily';

export function HabitJourneyPage() {
  const { habitId } = useParams<{ habitId: string }>(), id = Number(habitId), [, nav] = useLocation();
  const habit = useGetHabit(id, { query: { enabled: !!id, queryKey: getGetHabitQueryKey(id) } });
  const j = useGetHabitJourney(id, { query: { enabled: !!id, queryKey: getGetHabitJourneyQueryKey(id), refetchOnWindowFocus: true, refetchOnMount: 'always' } });
  const habits = useListHabits();
  useListRewards();
  const qc = useQueryClient();
  const start = useStartHabitJourney({ mutation: { onSuccess: created => {
    qc.setQueryData(getGetHabitJourneyQueryKey(created.habitId), created);
    invalidateDailyAll(qc, created.habitId);
  } } });
  const [full, setFull] = useState(false);
  const fsBtn = useRef<HTMLButtonElement>(null);
  const wasFullscreen = useRef(false);
  useEffect(() => {
    const restore = wasFullscreen.current && !full;
    wasFullscreen.current = full;
    if (!restore) return;
    const frame = requestAnimationFrame(() => fsBtn.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [full]);
  const deco = useGetHabitDecorations(id, { query: { enabled: !!id, queryKey: getGetHabitDecorationsQueryKey(id) } });
  useEffect(() => { if (id && habit.data && habits.data?.some(h => h.id === id)) writeLastHabit(id); }, [id, habit.data, habits.data]);
  const [sel, setSel] = useState<number | null>(null);
  const [cel, setCel] = useState(false);
  const prevSucc = useRef<number | null>(null);
  useEffect(() => { setSel(null); setCel(false); prevSucc.current = null; window.scrollTo({ top: 0, behavior: 'instant' }); }, [id]);
  const refetchRef = useRef(j.refetch); refetchRef.current = j.refetch;
  const jRef = useRef(j.data); jRef.current = j.data;
  useEffect(() => { const t = setInterval(() => { const jj = jRef.current; if (jj && needsRolloverRefetch(new Date(), jj)) refetchRef.current(); }, 60000); return () => clearInterval(t); }, []);
  const d = j.data;
  useEffect(() => { if (!d) return; const s = successCount(d, d.today.slice(0, 10)); if (prevSucc.current !== null && s > prevSucc.current) { setCel(true); const t = setTimeout(() => setCel(false), 4000); prevSucc.current = s; return () => clearTimeout(t); } prevSucc.current = s; return undefined; }, [d]);
  const focus = () => { const n = d ? calendarDay(d) : 1; setSel(n); document.getElementById(`jnode-${n}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  const picker = habits.data && habits.data.length > 1 && <select className="field !w-auto" aria-label="اختيار العادة" value={id} onChange={e => nav(`/habits/${e.target.value}/journey`)}>{habits.data.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select>;
  const wrap = (c: ReactNode) => full ? <FullscreenOverlay onClose={() => setFull(false)}>{c}</FullscreenOverlay> : c;
  return <>{wrap(<div className="page-enter">
    {full ? <div className="flex flex-wrap gap-3 items-center justify-between mb-4"><h1 className="text-xl font-black">{habit.data ? `رحلة ${habit.data.title}` : 'رحلة العادة'}</h1>{picker}</div> : <><Link href={`/habits/${id}`} className="btn btn-light mb-3">العودة للعادة</Link>
    <PageHead overline="خريطة الجزر" title={habit.data ? `رحلة ${habit.data.title}` : 'رحلة العادة'} desc="اثنان وعشرون يومًا تقويميًا، وكل يوم له مكانه على الطريق." action={picker || undefined} /></>}
    {j.isLoading || habit.isLoading ? <Loading /> : j.isError || habit.isError || !d || !habit.data ? <ErrorBlock retry={() => { j.refetch(); habit.refetch(); }} /> : !d.startDate || !d.total || !d.days.length ? <div>
      <Empty title="لا رحلة لهذه العادة" desc="يمكنك بدء 22 يومًا من اليوم، مع إبقاء سجلّك السابق محفوظًا." action={<button className="btn" disabled={start.isPending} onClick={() => start.mutate({ habitId: id })} data-testid="button-start-journey">{start.isPending ? 'جارٍ بدء الرحلة…' : 'ابدأ رحلة لهذه العادة'}</button>} />
      {start.isError && <p role="alert" className="text-sm mt-3">تعذّر بدء الرحلة. سجلّك محفوظ؛ حاول مرة أخرى.</p>}
    </div> : (() => {
      const cur = sel ?? calendarDay(d), day = d.days.find(x => x.dayNumber === cur) ?? d.days[0];
      return <><div className="flex flex-wrap gap-2 mb-4" aria-label="تقدّم الرحلة">
        <span className="badge">{d.status === 'not_started' ? 'الرحلة لم تبدأ بعد' : `اليوم ${calendarDay(d)} من 22`}</span>
        <span className="badge">الاتساق: {d.consistency.successfulDays} نجاح من {d.consistency.eligibleDays} أيام مجدولة</span>
      </div><div className={`grid ${full ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'lg:grid-cols-[minmax(0,560px)_1fr]'} gap-6 items-start`}>
        <div className={`min-w-0 ${full ? 'lg:sticky lg:top-4' : ''}`}>
          {cel && <div role="status" className="paper rounded-2xl p-3 mb-3 pop flex gap-3 items-center"><img src={base('component-pikura-star-20750.gif')} alt="" className="h-10 motion-reduce:hidden" />{(MILESTONES as readonly number[]).includes(calendarDay(d)) ? 'أكملت يوم هذه المحطة. خطوة جديدة في رحلتك.' : 'خطوة اليوم محفوظة. أثر جديد على جزيرتك.'}</div>}
          <JourneyMap journey={d} selected={cur} onSelect={setSel} placements={deco.data?.placements} fullscreen={full} />
        </div>
        <div className="space-y-4 lg:sticky lg:top-4 min-w-0">
          <div className="flex flex-wrap gap-2 items-center"><button className="btn" onClick={focus} data-testid="button-focus-current"><Crosshair size={16} />اذهب إلى اليوم {calendarDay(d)}</button>{!full && <button ref={fsBtn} className="btn btn-light" onClick={() => setFull(true)} data-testid="button-fullscreen"><Maximize2 size={16} />ملء الشاشة</button>}<Link href="/character" className="btn btn-light">الشخصية والمتجر</Link><span className="badge">{d.successful} ناجحة · {d.restDays} راحة · {d.missedDays} فائتة</span></div>
          {d.status === 'expired' && <p className="panel rounded-xl p-3 text-sm">انتهت الرحلة دون إكمال، وتبقى خريطتك محفوظة كما هي.</p>}
          {d.status === 'completed' && <Link href={`/habits/${id}/journey/complete`} className="btn btn-coral">ملخص إكمال الرحلة</Link>}
          <NodeDetails habit={habit.data} journey={d} day={day} /><DecorShop habitId={id} />
        </div>
      </div></>;
    })()}
  </div>)}</>;
}
