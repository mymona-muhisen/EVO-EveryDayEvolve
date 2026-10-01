import { useGetHabitJourney, useListRewards, getGetHabitJourneyQueryKey, type Habit } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Gift } from 'lucide-react';

export function JourneyLine({ habit, today }: { habit: Habit; today: string }) {
  const j = useGetHabitJourney(habit.id, { query: { queryKey: getGetHabitJourneyQueryKey(habit.id) } });
  const rewards = useListRewards();
  if (j.isLoading) return <div className="skeleton h-10" />;
  if (j.isError || !j.data || !j.data.total) return null;
  const d = j.data, elapsedScheduled = d.days.filter(x => x.scheduled && x.date.slice(0, 10) <= today).length, remaining = Math.max(0, d.length - d.currentDay);
  const reward = habit.rewardId ? rewards.data?.find(r => r.id === habit.rewardId) : null;
  return <div className="min-w-0 text-sm space-y-1.5" data-testid={`journey-line-${habit.id}`}>
    <div className="flex flex-wrap justify-between gap-x-3"><b>اليوم {d.currentDay} من {d.length}</b><span className="muted">تبقّى {remaining} يومًا</span></div>
    <div className="muted">{d.successful} ناجحة من {elapsedScheduled} أيام مجدولة مضت</div>
    <Link href={`/habits/${habit.id}/journey`} className="underline font-bold">خريطة الرحلة</Link>
    {reward && <div className="flex items-start gap-2 min-w-0"><Gift size={15} className="text-[#b87755] mt-1 shrink-0" /><span className="min-w-0 break-words">مكافأتك: {reward.title} · {reward.isRedeemed ? 'حصلت عليها' : `${reward.coinCost} عملة`}</span></div>}
  </div>;
}
