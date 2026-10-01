import { useEffect, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useClaimJourneyReward, useGetHabit, useGetHabitJourney, getGetHabitJourneyQueryKey, getGetHabitQueryKey } from '@workspace/api-client-react';
import { PageHead, Empty, Loading, ErrorBlock } from '@/components/journey-ui';
import { RewardThumb, refreshRewards } from '@/components/reward/real-reward';
import { base, classifyDay } from '@/lib/journey-map';
import { CharacterAvatar } from '@/components/character/character-avatar';
import { useGlobalCharacter } from '@/hooks/use-character';

export function HabitJourneyCompletePage() {
  const { habitId } = useParams<{ habitId: string }>(), id = Number(habitId);
  const character = useGlobalCharacter();
  const habit = useGetHabit(id, { query: { enabled: !!id, queryKey: getGetHabitQueryKey(id) } });
  const j = useGetHabitJourney(id, { query: { enabled: !!id, queryKey: getGetHabitJourneyQueryKey(id), refetchOnMount: 'always' } });
  const [celebrate, setCelebrate] = useState(false);
  const claim = useClaimJourneyReward(), qc = useQueryClient();
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
  const e = d.earnings, rr = d.realReward, today = d.today.slice(0, 10);
  const recovered = d.days.filter(x => classifyDay(x, today) === 'recovered').length;
  const doClaim = () => { if (rr) claim.mutate({ journeyRewardId: rr.id }, { onSuccess: claimed => { qc.setQueryData(getGetHabitJourneyQueryKey(id), (old: typeof d | undefined) => old ? { ...old, realReward: claimed } : old); refreshRewards(qc, id, rr.id); } }); };
  return <div className="page-enter max-w-2xl mx-auto">
    {celebrate && <div role="status" className="paper rounded-xl p-3 mb-3 flex gap-3 items-center pop"><img src={base('component-pikura-star-20750.gif')} alt="" className="h-9 motion-reduce:hidden" />وصلت إلى نهاية رحلتك. إنجازك محفوظ.</div>}
    <div className="relative h-48 mb-4" aria-label="شخصيتك في نهاية الرحلة">
      <img src={base('island-adventure.webp')} alt="" className="absolute bottom-0 left-1/2 -translate-x-1/2 h-40" />
      <div className="absolute top-6 left-1/2 -translate-x-1/2">
        {character.data ? <CharacterAvatar items={character.data.equippedItems} height={64} testId="completion-character" /> : character.isError ? <span role="alert" className="text-xs">تعذّر تحميل الشخصية</span> : <div className="skeleton w-14 h-16" />}
      </div>
    </div>
    <PageHead overline="وصلت" title="اكتملت رحلتك" desc={habit.data?.title} />
    <p className="text-center mb-4">22 يومًا تقويميًا · الاتساق: {d.consistency.successfulDays} نجاح من {d.consistency.eligibleDays} أيام مجدولة</p>
    <div className={`grid ${recovered ? 'grid-cols-4' : 'grid-cols-3'} gap-2 text-center mb-4`}>
      <div className="panel rounded-xl p-3"><b className="text-2xl block" data-testid="text-success">{d.successful}</b><small>ناجحة</small></div>
      <div className="panel rounded-xl p-3"><b className="text-2xl block">{d.missedDays}</b><small>فائتة</small></div>
      <div className="panel rounded-xl p-3"><b className="text-2xl block">{d.restDays}</b><small>راحة</small></div>
      {recovered > 0 && <div className="panel rounded-xl p-3" data-testid="text-recovered"><b className="text-2xl block">{recovered}</b><small>مُستعادة</small></div>}
    </div>
    <div className="paper rounded-2xl p-5 mb-4"><p>خبرة الرحلة: <b data-testid="text-xp">{e.xp}</b> · عملات الرحلة: <b data-testid="text-coins">{e.coins}</b></p>{(!e.xpComplete||e.coinHistoryMayBeIncomplete) && <p className="text-sm muted mt-2">بعض الأيام القديمة لا تحمل سجل مكافأة معروفًا ({e.unknownCheckins})، فالرقم جزئي.</p>}</div>
    {rr ? <div className="paper rounded-2xl p-5 mb-4" data-testid="card-completion-reward">
      <div className="flex gap-3 items-center min-w-0"><RewardThumb path={rr.imageUrl} size={64} /><div className="min-w-0 flex-1"><div className="text-xs muted">مكافأتك</div><div className="font-bold text-lg break-words">{rr.title}</div>{rr.description && <p className="text-sm muted break-words">{rr.description}</p>}{rr.estimatedValue != null && <p className="text-xs muted">قيمة تقديرية {rr.estimatedValue}</p>}</div></div>
      {rr.status === 'pending' && <p className="text-sm mt-3" data-testid="text-reward-pending">لم تُفتح بعد؛ يفتحها الخادم عند إتمام الرحلة.</p>}
      {rr.status === 'unlocked' && <div className="mt-3 space-y-2"><p className="text-sm font-bold text-[#245448]" data-testid="text-reward-unlocked">فُتحت مكافأتك. هذا وعدك لنفسك؛ لا شراء هنا، تستلمها بنفسك.</p>
        <button type="button" data-testid="button-claim-reward" className="btn btn-coral" disabled={claim.isPending} onClick={doClaim}>{claim.isPending ? 'نسجّل…' : claim.isError ? 'أعد المحاولة' : 'استلم المكافأة'}</button>
        {claim.isError && <p role="alert" data-testid="text-claim-error" className="text-sm text-[#b96355]">تعذّر تسجيل الاستلام. مكافأتك ما زالت مفتوحة؛ حاول مرة أخرى.</p>}</div>}
      {rr.status === 'claimed' && <div className="mt-3" role="status" data-testid="text-reward-claimed"><p className="font-bold">تم استلام المكافأة.</p><p className="text-sm muted">استمتع بها، فقد استحققت هذه اللحظة.</p></div>}
    </div> : <div className="panel rounded-2xl p-4 mb-4 text-sm" data-testid="text-no-reward">هذه الرحلة بلا مكافأة حقيقية مرتبطة، وإنجازك محفوظ.</div>}
    <div className="flex flex-wrap gap-2"><Link href="/habits?new=1" data-testid="link-start-another" className="btn btn-coral">ابدأ رحلة أخرى</Link>{back}</div>
  </div>;
}
