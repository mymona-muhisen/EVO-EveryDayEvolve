import { Link } from 'wouter';
import { Lock } from 'lucide-react';
import { useListHabits, useListRewards } from '@workspace/api-client-react';
import { findHabitReward } from '@/lib/daily';
import { useDailyOverview } from '@/hooks/use-daily';
import { ConsistencyLine, MilestoneRow } from './consistency';
import { SectionTitle, ErrorBlock, Empty } from '@/components/journey-ui';

export function ConsistencyOverview({ settings }: { settings?: boolean }) {
  const ov = useDailyOverview(), rewards = useListRewards(), habits = useListHabits();
  return <section className="paper rounded-[24px] p-5 md:p-6 mb-8" data-testid="section-consistency">
    <SectionTitle label="اتساقك" title={settings ? 'كيف نحسب اتساقك' : 'اتساق عاداتك'} />
    {settings && <p className="muted text-sm leading-7 mb-4">نعدّ الأيام المجدولة التي مضت فقط، ونُخرج أيام الراحة والأيام القادمة. اليوم الذي فات لا يمحو شيئًا ولا يعيد رحلتك إلى البداية.</p>}
    {ov.isLoading ? <div className="skeleton h-24" /> : ov.isError || !ov.data ? <ErrorBlock retry={() => ov.refetch()} /> : !ov.data.habits.length ? <Empty title="لا عادات نشطة بعد" desc="حين تبدأ عادة ستظهر هنا أيامك الناجحة." /> :
      <div className="space-y-5">{ov.data.habits.map(h => { const r = findHabitReward(habits.data?.find(x => x.id === h.habitId), rewards.data); return <div key={h.habitId} data-testid={`consistency-${h.habitId}`}><Link href={`/habits/${h.habitId}`} className="font-bold block mb-2">{h.title}</Link><ConsistencyLine successful={h.successfulDays} eligible={h.eligibleDays} compact /><div className="mt-3"><MilestoneRow milestones={h.rewardMilestones} reward={r} /></div></div>; })}</div>}
    <div className="mt-5 rounded-xl bg-[#f3ead9] p-3 text-sm flex gap-2 items-start" data-testid="text-recovery-disabled"><Lock size={15} className="mt-1 shrink-0" /><span>العودة الخفيفة بعد يوم فائت غير متاحة بعد. استعادة السلسلة المدفوعة القديمة تعمل كما كانت، وهي أمر مختلف عن الاتساق.</span></div>
  </section>;
}
