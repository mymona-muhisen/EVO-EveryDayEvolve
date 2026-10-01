import { Link } from 'wouter';
import { Plus } from 'lucide-react';
import { useListHabits } from '@workspace/api-client-react';
import { dayKey } from '@/lib/daily';
import { useDailyOverview } from '@/hooks/use-daily';
import { DailyExecutionCard } from './execution-card';
import { JourneyLine } from './journey-line';
import { MilestoneRow } from './consistency';
import { Loading, ErrorBlock, Empty } from '@/components/journey-ui';

export function DailyHomeList({ date: rawDate }: { date: string }) {
  const date = dayKey(rawDate);
  const ov = useDailyOverview(date), habits = useListHabits();
  if (ov.isLoading) return <Loading />;
  if (ov.isError || !ov.data) return <ErrorBlock retry={() => ov.refetch()} />;
  const items = ov.data.habits.filter(h => h.scheduledToday);
  if (!items.length) return <Empty title="لا خطوة مطلوبة اليوم" desc="أضف عادة صغيرة، أو استرح إن كان اليوم يوم راحة." action={<Link href="/habits" className="btn"><Plus size={16} /> العادات</Link>} />;
  return <div className="space-y-4">{items.map(it => { const h = habits.data?.find(x => x.id === it.habitId); return <div key={it.habitId} className="rise">
    <DailyExecutionCard today={date} state={it.execution} stamp={ov.dataUpdatedAt} habit={h} title={it.title} emoji={h?.emoji} linkTo={`/habits/${it.habitId}`} refetch={() => ov.refetch()} />
    <div className="px-3 pt-3 space-y-3 min-w-0">{h && <JourneyLine habit={h} today={date} />}<MilestoneRow milestones={it.rewardMilestones} /></div>
  </div>; })}</div>;
}
