import { useGetHabitJourney, getGetHabitJourneyQueryKey, type Habit } from '@workspace/api-client-react';
import { Link } from 'wouter';

export function JourneyLine({ habit, today }: { habit: Habit; today: string }) {
  const j = useGetHabitJourney(habit.id, { query: { queryKey: getGetHabitJourneyQueryKey(habit.id) } });
  if (j.isLoading) return <div className="skeleton h-10" />;
  if (j.isError || !j.data || !j.data.total) return null;
  const d = j.data, elapsedScheduled = d.days.filter(x => x.scheduled && x.date.slice(0, 10) <= today).length, remaining = Math.max(0, d.length - d.currentDay);
  const reward = d.realReward;
  return <div className="min-w-0 text-sm space-y-1.5" data-testid={`journey-line-${habit.id}`}>
    <div className="flex flex-wrap justify-between gap-x-3"><b>اليوم {d.currentDay} من {d.length}</b><span className="muted">تبقّى {remaining} يومًا</span></div>
    <div className="muted">{d.successful} ناجحة من {elapsedScheduled} أيام مجدولة مضت</div>
    <Link href={`/habits/${habit.id}/journey`} className="underline font-bold">خريطة الرحلة</Link>
    {reward && <Link href={`/habits/${habit.id}/journey?reward=1`} className="flex items-start gap-2 min-w-0"><img src={`${import.meta.env.BASE_URL}assets/journey-gift.png`} alt="" className="w-7 h-7 object-contain shrink-0" /><span className="min-w-0 break-words">مكافأة الرحلة: {reward.title} · {reward.status === 'claimed' ? 'استلمتها' : reward.status === 'unlocked' ? 'جاهزة للاستلام' : 'تنتظرك عند نهاية الرحلة'}</span></Link>}
  </div>;
}
