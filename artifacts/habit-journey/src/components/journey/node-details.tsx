import { Link } from 'wouter';
import type { Habit, HabitDay, HabitJourney } from '@workspace/api-client-react';
import { Lock } from 'lucide-react';
import { DayMemory, canCaptureDay } from '@/components/memory/memory';
import { arDate } from '@/components/journey-ui';
import { DailyDayPanel } from '@/components/daily/day-panel';
import { classifyDay, hasRecoveryRecord, historyRows, isTodayExecutable, MILESTONES, STATE_LABEL } from '@/lib/journey-map';

export function NodeDetails({ habit, journey, day }: { habit: Habit; journey: HabitJourney; day: HabitDay }) {
  const today = journey.today.slice(0, 10), s = classifyDay(day, today), h = historyRows(day);
  const ms = (MILESTONES as readonly number[]).includes(day.dayNumber);
  return <section className="paper rounded-[22px] p-5 space-y-3 focus-visible:outline-2" data-testid="node-details" aria-live="polite" tabIndex={-1}>
    <div className="flex justify-between gap-2"><h2 className="font-black text-lg">اليوم {day.dayNumber} · {arDate(day.date.slice(0, 10))}</h2><span className="badge">{STATE_LABEL[s]}</span></div>
    {ms && <p className="text-sm panel rounded-xl p-3">{day.dayNumber === 22 ? 'محطة النهاية. تُحسب النهاية فقط حين ينجح آخر يوم مجدول وتبلغ اليوم الثاني والعشرين.' : 'محطة على الطريق. هي علامة وليست نجاحًا بحد ذاتها؛ نجاح اليوم يُحسب من خطوتك الفعلية.'}</p>}
    {isTodayExecutable(day, today) && <><div className="text-sm muted">هدف اليوم {h.target} · الحد الأدنى {h.minimum} · المنجز {h.actual}</div><DailyDayPanel habit={habit} today={today} journey={journey} showMemoryPrompt={false} /></>}
    {s === 'future' && <p className="text-sm flex gap-2 items-center"><Lock size={15} />هذا اليوم مغلق حتى {arDate(day.date.slice(0, 10))}. لا يمكن تنفيذه مبكرًا.</p>}
    {s === 'rest' && <p className="text-sm">يوم راحة مجدول، لا يُحسب فائتًا.</p>}
    {!isTodayExecutable(day, today) && (s === 'success' || s === 'recovered' || s === 'missed' || s === 'pending') && <dl className="grid grid-cols-2 gap-2 text-sm">
      <div className="panel rounded-xl p-3"><dt className="muted">الهدف</dt><dd className="font-bold">{h.target}</dd></div>
      <div className="panel rounded-xl p-3"><dt className="muted">المنجز</dt><dd className="font-bold">{h.actual}</dd></div>
      <div className="panel rounded-xl p-3"><dt className="muted">الصعوبة</dt><dd className="font-bold">{h.difficulty}</dd></div>
      <div className="panel rounded-xl p-3"><dt className="muted">السبب</dt><dd className="font-bold">{h.reason}</dd></div>
    </dl>}
    {(day.memoryId || s === 'success' || s === 'recovered') && <DayMemory canCreate={canCaptureDay(day, today)} habitId={habit.id} date={day.date.slice(0, 10)} dayNumber={day.dayNumber} memoryId={day.memoryId} />}
    {hasRecoveryRecord(day) && <p className="text-xs muted">سجل استعادة: {day.recoveryUsed} من {day.recoveryLimit} (غير متاحة الآن).</p>}
    {journey.status === 'completed' && <Link href={`/habits/${habit.id}/journey/complete`} className="btn">عرض ملخص الرحلة</Link>}
  </section>;
}
