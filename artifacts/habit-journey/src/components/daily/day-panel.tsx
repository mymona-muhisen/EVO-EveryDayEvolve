import { useState } from 'react';
import type { Habit, HabitJourney } from '@workspace/api-client-react';
import { dayKey } from '@/lib/daily';
import { useDailyState } from '@/hooks/use-daily';
import { JourneyLine } from './journey-line';
import { DailyExecutionCard } from './execution-card';
import { Loading, ErrorBlock, arDate } from '@/components/journey-ui';

export function DailyDayPanel({ habit, today: rawToday, journey, showMemoryPrompt = true }: { habit: Habit; today: string; journey?: HabitJourney; showMemoryPrompt?: boolean }) {
  const today = dayKey(rawToday);
  const [date, setDate] = useState(today);
  const q = useDailyState(habit.id, date);
  const past = (journey?.days ?? []).filter(d => d.scheduled && d.date.slice(0, 10) < today && !d.checkin?.completed).slice(-6).reverse();
  return <div className="space-y-3">
    {date !== today && <button className="text-sm underline" data-testid="button-back-today" onClick={() => setDate(today)}>العودة إلى اليوم</button>}
    {date !== today && <p className="text-sm font-bold">{arDate(date)}</p>}
    {q.isLoading ? <Loading /> : q.isError || !q.data ? <ErrorBlock retry={() => q.refetch()} /> : <DailyExecutionCard today={today} showMemoryPrompt={showMemoryPrompt || date !== today} state={q.data} stamp={q.dataUpdatedAt} habit={habit} refetch={() => q.refetch()} />}
    <div className="paper rounded-[18px] p-4"><JourneyLine habit={habit} today={today} /></div>
    {past.length > 0 && <div className="paper rounded-[18px] p-4" data-testid="list-past-days"><p className="text-sm font-bold mb-2">أيام فاتت، بلا أي حكم</p><div className="flex flex-wrap gap-2">{past.map(d => <button key={d.date} onClick={() => setDate(d.date.slice(0, 10))} className={`px-3 min-h-10 rounded-full text-sm ${date === d.date.slice(0, 10) ? 'bg-[#245448] text-white' : 'bg-[#eae4d5]'}`}>{arDate(d.date)}</button>)}</div></div>}
  </div>;
}
