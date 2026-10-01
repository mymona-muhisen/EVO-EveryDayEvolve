import { useEffect, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useGetHabit, useGetHabitJourney, getGetHabitJourneyQueryKey, getGetHabitQueryKey } from '@workspace/api-client-react';
import { PageHead, Empty, Loading, ErrorBlock } from '@/components/journey-ui';
import { base, canShowUnlocked } from '@/lib/journey-map';

export function HabitJourneyCompletePage() {
  const { habitId } = useParams<{ habitId: string }>(), id = Number(habitId);
  const habit = useGetHabit(id, { query: { enabled: !!id, queryKey: getGetHabitQueryKey(id) } });
  const j = useGetHabitJourney(id, { query: { enabled: !!id, queryKey: getGetHabitJourneyQueryKey(id), refetchOnMount: 'always' } });
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [id]);
  useEffect(() => {
    if (j.data?.status !== 'completed') return;
    const key = `journey-completion-seen:${id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { return; }
    setCelebrate(true);
    const timeout = setTimeout(() => setCelebrate(false), 4000);
    return () => { clearTimeout(timeout); setCelebrate(false); };
  }, [id, j.data?.status]);
  if (j.isLoading || habit.isLoading) return <Loading />;
  const d = j.data;
  if (j.isError || habit.isError || !d || !habit.data) return <ErrorBlock retry={() => { j.refetch(); habit.refetch(); }} />;
  const back = <Link href={`/habits/${id}/journey`} className="btn btn-light">عرض الخريطة</Link>;
  if (d.status !== 'completed') return <Empty title={d.status === 'expired' ? 'انتهت الرحلة دون إكمال' : 'الرحلة لم تكتمل بعد'} desc={d.status === 'expired' ? 'خريطتك محفوظة كما كانت.' : 'تكتمل حين ينجح آخر يوم مجدول وتبلغ اليوم الثاني والعشرين.'} action={back} />;
  const e = d.earnings, r = d.selectedReward;
  return <div className="page-enter max-w-2xl mx-auto">
    {celebrate && <div role="status" className="paper rounded-xl p-3 mb-3 flex gap-3 items-center pop"><img src={base('component-pikura-star-20750.gif')} alt="" className="h-9 motion-reduce:hidden" />وصلت إلى نهاية رحلتك. إنجازك محفوظ.</div>}
    <div className="relative h-48 mb-4" aria-label="شخصيتك في نهاية الرحلة">
      <img src={base('island-adventure.webp')} alt="" className="absolute bottom-0 left-1/2 -translate-x-1/2 h-40" />
      <div className="absolute top-6 left-1/2 -translate-x-1/2">
        <img src={base('character-idle.gif')} alt="شخصيتك" className="h-16 w-auto motion-reduce:hidden" style={{ imageRendering: 'pixelated' }} />
        <img src={base('character-idle-still.webp')} alt="شخصيتك" className="h-16 w-auto hidden motion-reduce:block" style={{ imageRendering: 'pixelated' }} />
      </div>
    </div>
    <PageHead overline="وصلت" title="اكتملت رحلتك" desc={habit.data?.title} />
    <p className="text-center mb-4">22 يومًا تقويميًا · الاتساق: {d.consistency.successfulDays} نجاح من {d.consistency.eligibleDays} أيام مجدولة</p>
    <div className="grid grid-cols-3 gap-2 text-center mb-4">
      <div className="panel rounded-xl p-3"><b className="text-2xl block" data-testid="text-success">{d.successful}</b><small>ناجحة</small></div>
      <div className="panel rounded-xl p-3"><b className="text-2xl block">{d.missedDays}</b><small>فائتة</small></div>
      <div className="panel rounded-xl p-3"><b className="text-2xl block">{d.restDays}</b><small>راحة</small></div>
    </div>
    <div className="paper rounded-2xl p-5 mb-4"><p>خبرة الرحلة: <b data-testid="text-xp">{e.xp}</b> · عملات الرحلة: <b data-testid="text-coins">{e.coins}</b></p>{(!e.xpComplete||e.coinHistoryMayBeIncomplete) && <p className="text-sm muted mt-2">بعض الأيام القديمة لا تحمل سجل مكافأة معروفًا ({e.unknownCheckins})، فالرقم جزئي.</p>}</div>
    {r && <div className="paper rounded-2xl p-5 mb-4">مكافأتك: <b>{r.title}</b> · {canShowUnlocked(d) ? (r.isRedeemed ? 'حصلت عليها' : 'مفتوحة، والاستبدال خيارك') : 'غير مفتوحة'}</div>}
    <div className="flex flex-wrap gap-2">{r && <Link href="/rewards" className="btn">عرض المكافأة</Link>}<Link href="/habits" className="btn btn-coral">ابدأ عادة جديدة</Link>{back}</div>
  </div>;
}
