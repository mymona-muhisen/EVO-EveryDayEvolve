import { lazy, Suspense, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Plus, Coins } from 'lucide-react';
import { useGetDashboardHome, getGetDashboardHomeQueryKey, type User } from '@workspace/api-client-react';
import { HabitPlanForm } from '@/components/habit-plan-form';
import { Loading, ErrorBlock, Modal } from '@/components/journey-ui';
import { useDashboardFreshness } from '@/hooks/use-dashboard-freshness';
import { dayKey } from '@/lib/daily';
import {
  Retry, greetingText, FocusSection, OtherHabits, JourneyPreview, RewardPreview, CompletionHero,
  GuidedStart, Opportunity, MissedDayReflection,
} from '@/components/dashboard/dashboard-sections';

const LazyTime = lazy(() => import('@/components/dashboard/dashboard-secondary').then(m => ({ default: m.TimeCard })));
const Secondary = lazy(() => import('@/components/dashboard/dashboard-secondary'));
type Seed = { title: string; minutes: number; category: 'productivity'; emoji: string; intent?: string };

export function HomePage({ user }: { user: User }) {
  useDashboardFreshness();
  const q = useGetDashboardHome({ query: { queryKey: getGetDashboardHomeQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000, refetchInterval: 30000 } });
  const [, nav] = useLocation();
  const [createOpen, setCreateOpen] = useState(false), [seed, setSeed] = useState<Seed | undefined>();
  if (q.isLoading) return <div aria-busy="true" aria-label="تحميل الصفحة الرئيسية"><Loading /></div>;
  const d = q.data;
  if (!d) return <ErrorBlock retry={() => q.refetch()} />;
  const retry = () => q.refetch();
  const open = (s?: Seed) => { setSeed(s); setCreateOpen(true); };
  const opp = d.coach?.analysis?.status === 'ready' ? d.coach.analysis.opportunity : null;
  const name = (d.profile.displayName || user.displayName).split(' ')[0];
  const habitsDown = d.sectionStatus.habits === 'unavailable';
  const completion = d.completion ?? (d.journey?.status === 'completed'
    ? { journey: d.journey, reward: d.reward?.habitId === d.journey.habitId ? d.reward : null }
    : null);
  const complete = !!completion;
  const focusDone = !!d.focus && !!completion && completion.journey.habitId === d.focus.habit.id
    && d.focus.execution.checkin?.completed === true;
  const stamp = q.dataUpdatedAt;
  const hasPlan = !!d.focus || !!d.missedDay || !!d.journey || complete || d.otherHabits.length > 0;
  const noHabit = !habitsDown && !hasPlan;
  const showPlan = !habitsDown && hasPlan && !d.focus && !complete;
  const ts = d.time?.session?.status as string | undefined;
  const trackingPrimary = noHabit && d.state !== 'new_user' && !!ts && ts !== 'finished';

  return <div className="max-w-6xl mx-auto min-w-0">
    <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div><div className="eyebrow">مساحتك</div><h1 className="text-2xl md:text-4xl font-black leading-[1.4]" data-testid="text-greeting">{greetingText(d.greeting)}، {name}.</h1></div>
      <div className="flex items-center gap-2">
        <span className="badge !text-sm"><Coins size={14} aria-hidden="true" />{d.profile.coins} عملة</span>
        <button type="button" className="btn btn-light min-h-11" data-testid="button-create-habit" onClick={() => open()}><Plus size={16} aria-hidden="true" /> عادة جديدة</button>
      </div>
    </header>

    <div className="grid lg:grid-cols-[1.5fr_.9fr] gap-5">
      <div className="space-y-5 min-w-0">
        {q.isError && <Retry what="تحديث الصفحة؛ نعرض آخر حالة محفوظة" onRetry={retry} />}
        {habitsDown && <Retry what="عاداتك" onRetry={retry} />}
        {d.missedDay && <MissedDayReflection key={`${d.missedDay.habit.id}:${dayKey(d.missedDay.execution.date)}`} d={d} item={d.missedDay} />}
        {d.focus && !focusDone && <FocusSection key={`${d.focus.habit.id}:${dayKey(d.focus.execution.date)}`} d={d} focus={d.focus} stamp={stamp} onRefetch={retry} />}
        {completion && <CompletionHero d={{ ...d, journey: completion.journey, reward: completion.reward }} compact={!!d.focus && !focusDone} onAnother={() => open()} />}
        {showPlan && <section className="paper rounded-[26px] p-6" data-testid="section-plan-day">
          <div className="eyebrow">خطتك محفوظة</div>
          <h2 className="text-2xl font-black">{d.journey?.status === 'upcoming' ? 'رحلتك تبدأ قريبًا' : d.journey?.status === 'expired' ? 'وصلت رحلتك إلى نهاية أيامها' : 'اليوم راحة في خطتك'}</h2>
          <p className="muted text-sm leading-7 mt-2">{d.journey?.status === 'expired' ? 'راجع أيام رحلتك وما سجّلته فيها، ثم اختر خطوتك القادمة. مرور الأيام وحده لا يفتح المكافأة.' : 'لا توجد خطوة مقرّرة للتنفيذ اليوم. الراحة ليست يومًا فائتًا، ولا تحتاج إلى التعويض عنها.'}</p>
          <Link href={d.journey ? `/habits/${d.journey.habitId}/journey` : '/habits'} className="btn btn-light min-h-11 mt-4">راجع خطتك</Link>
        </section>}
        {trackingPrimary && <Suspense fallback={<div className="skeleton h-40" />}><LazyTime d={d} onRetry={retry} primary /></Suspense>}
        {noHabit && (d.state === 'new_user' ? <GuidedStart /> : opp ? <Opportunity d={d} onExplore={() => nav('/time')} /> : <section className={`paper rounded-[26px] ${trackingPrimary ? 'p-4' : 'p-6'}`} data-testid="section-no-habit"><h2 className="text-2xl font-black">لا عادة نشطة اليوم</h2><p className="muted mt-2 text-sm">ابدأ بخطوة صغيرة، أو افهم يومك أولًا.</p><div className="flex flex-wrap gap-2 mt-4"><button type="button" className="btn min-h-11" onClick={() => open()}>أنشئ عادة</button><Link href="/time" className="btn btn-light min-h-11" data-testid="link-start-tracking">ابدأ التتبع</Link></div></section>)}
        <OtherHabits items={d.otherHabits} />
        <div className="grid md:grid-cols-2 gap-5"><JourneyPreview d={d} /><RewardPreview d={d} /></div>
        {d.sectionStatus.journey === 'unavailable' && <Retry what="الرحلة" onRetry={retry} />}
        {d.sectionStatus.reward === 'unavailable' && <Retry what="المكافأة" onRetry={retry} />}
      </div>
      <aside className="space-y-4 min-w-0">
        <Suspense fallback={<div className="skeleton h-32" aria-label="تحميل" />}><Secondary hideTime={trackingPrimary} d={d} onRetry={retry} /></Suspense>
      </aside>
    </div>
    {createOpen && <Modal title="عادة جديدة على الطريق" onClose={() => setCreateOpen(false)}><HabitPlanForm seed={seed} onSaved={() => setCreateOpen(false)} /></Modal>}
  </div>;
}
