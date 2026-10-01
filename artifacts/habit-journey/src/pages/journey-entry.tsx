import { Link, Redirect } from 'wouter';
import { useListHabits } from '@workspace/api-client-react';
import { Loading, ErrorBlock, Empty } from '@/components/journey-ui';
import { pickHabit, readLastHabit } from '@/lib/decor';

export function JourneyEntryPage() {
  const habits = useListHabits();
  if (habits.isLoading) return <Loading />;
  if (habits.isError || !habits.data) return <ErrorBlock retry={() => habits.refetch()} />;
  const h = pickHabit(habits.data, readLastHabit());
  if (!h) return <Empty title="الخريطة تنتظر عادتك الأولى" desc="أنشئ عادة وستظهر لها خريطة جزر خاصة بها." action={<Link href="/habits" className="btn">أنشئ عادة</Link>} />;
  return <Redirect to={`/habits/${h.id}/journey`} replace />;
}
