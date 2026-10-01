import { Link } from 'wouter';
import { Coins, Sparkles } from 'lucide-react';
import { useListHabits, useGetHabitJourney, getGetHabitJourneyQueryKey } from '@workspace/api-client-react';
import { CharacterAvatar } from './character-avatar';
import { useGlobalCharacter } from '@/hooks/use-character';
import { readLastHabit } from '@/lib/decor';
import { calendarDay } from '@/lib/journey-map';

export function CharacterSummary({ profile = false }: { profile?: boolean }) {
  const character = useGlobalCharacter();
  const habits = useListHabits();
  const remembered = readLastHabit();
  const active = habits.data?.find(h => h.id === remembered && h.isActive) ?? habits.data?.find(h => h.isActive);
  const journey = useGetHabitJourney(active?.id ?? 0, { query: {
    enabled: !!active,
    queryKey: getGetHabitJourneyQueryKey(active?.id ?? 0),
    refetchOnMount: 'always',
  } });
  const d = character.data;
  return <section className="paper rounded-[22px] p-5 min-w-0" aria-label="شخصيتك وتقدّمك" data-testid={profile ? 'profile-character-widget' : 'dashboard-character-widget'}>
    {character.isLoading ? <div className="skeleton h-36" aria-label="تحميل الشخصية" /> : character.isError || !d ? <div role="alert" className="text-sm">
      تعذّر تحميل الشخصية. <button className="underline font-bold" onClick={() => character.refetch()}>إعادة المحاولة</button>
    </div> : <>
      <div className="flex items-center gap-4 min-w-0">
        <CharacterAvatar items={d.equippedItems} height={profile ? 120 : 96} testId={profile ? 'profile-character' : 'dashboard-character'} />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">شخصيتك في كل رحلة</p>
          <h2 className="text-xl font-black mt-1">المستوى {d.level}</h2>
          <p className="text-sm mt-1 inline-flex items-center gap-1"><Coins size={14} />{d.walletCoins} عملة</p>
          <p className="text-xs muted mt-1">إجمالي الخبرة: {d.totalXp} XP</p>
        </div>
      </div>
      {character.levelUp && <p role="status" className="panel rounded-xl p-2 mt-3 text-sm font-bold pop motion-reduce:animate-none">
        ارتقيت إلى المستوى {character.levelUp}. خبرتك السابقة محفوظة.
      </p>}
      <div className="flex justify-between gap-2 mt-3 text-xs"><span>نحو المستوى التالي</span><span dir="ltr">{d.xp} / {d.nextLevelXp} XP</span></div>
      <div role="progressbar" aria-label="خبرة المستوى الحالي" aria-valuemin={0} aria-valuemax={d.nextLevelXp} aria-valuenow={d.xp} className="h-2 rounded-full bg-[#e3e0cc] mt-2 overflow-hidden">
        <div className="h-full rounded-full bg-[#245448] transition-[width] motion-reduce:transition-none" style={{ width: `${d.progressPercent}%` }} />
      </div>
      {habits.isLoading ? <p className="text-xs muted mt-3">تحميل الرحلة الحالية…</p> : habits.isError ? <p className="text-xs muted mt-3">تعذّر تحميل الرحلة الحالية.</p> : active ? <Link href={`/habits/${active.id}/journey`} className="block text-sm mt-3">
        <span className="font-bold">{active.title}</span>
        {journey.data?.startDate && journey.data.total > 0 ? <span className="muted"> · اليوم {calendarDay(journey.data)} / 22{journey.data.status === 'completed' ? ' · مكتملة' : journey.data.status === 'expired' ? ' · منتهية' : ''}</span> : journey.isError ? <span className="muted"> · تعذّر تحميل التقدّم</span> : null}
      </Link> : <p className="text-xs muted mt-3">لا توجد عادة نشطة حاليًا.</p>}
      <Link href="/character" className="btn btn-light mt-4 !py-2"><Sparkles size={15} />تخصيص الشخصية</Link>
    </>}
  </section>;
}