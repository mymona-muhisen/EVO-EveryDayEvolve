import { useState } from 'react';
import { Link, useParams, useLocation } from 'wouter';
import { Heart, Flag, ShieldOff, UserMinus, Lock, ArrowRight } from 'lucide-react';
import { useGetSocialProfile, getGetSocialProfileQueryKey } from '@workspace/api-client-react';
import { ErrorBlock } from '@/components/journey-ui';
import { arDate } from '@/components/journey-ui';
import { SocialAvatar, InlineError, SoftEmpty, statusOf } from '@/components/social/social-common';
import { ConfirmFriendModal, ReportModal, EncourageModal, SharedCharacter, SocialMemoryPhoto } from '@/components/social/social-widgets';

function Block({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return <section className="paper rounded-[22px] p-5 md:p-6" data-testid={testId}><h2 className="text-xl font-extrabold mt-0 mb-4">{title}</h2>{children}</section>;
}
const Nothing = ({ text }: { text: string }) => <p className="flex items-center gap-2 text-sm muted m-0"><Lock size={15} className="shrink-0" />{text}</p>;

export function FriendProfilePage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const [, nav] = useLocation();
  const q = useGetSocialProfile(userId, { query: { enabled: !!userId, queryKey: getGetSocialProfileQueryKey(userId), retry: false } });
  const [modal, setModal] = useState<'encourage' | 'remove' | 'block' | 'report' | null>(null);
  const back = <Link href="/friends" className="inline-flex items-center gap-2 min-h-11 text-sm font-bold text-[#245448]" data-testid="link-back-friends"><ArrowRight size={16} />الأصدقاء</Link>;
  if (q.isLoading) return <div>{back}<div className="skeleton h-40 mb-4" /><div className="skeleton h-28" /></div>;
  if (q.isError || !q.data) {
    const s = statusOf(q.error);
    if (s === 403 || s === 404) return <div>{back}<SoftEmpty icon={<Lock size={22} />} title="هذا الملف غير متاح" desc="قد لا تكونان صديقين، أو أن الوصول أُغلق. لا نكشف أكثر من ذلك حمايةً للخصوصية." /></div>;
    return <div>{back}<ErrorBlock retry={() => q.refetch()} /></div>;
  }
  const p = q.data, u = p.user;
  return <div className="max-w-[860px] space-y-5">
    {back}
    <div className="rounded-[26px] bg-[#214e43] text-[#fff9e9] p-6 flex flex-wrap items-center gap-4" data-testid="card-profile-head">
      <SocialAvatar user={u} size={72} />
      <div className="flex-1 min-w-[180px]"><h1 className="text-3xl font-black m-0" data-testid="text-profile-name">{u.displayName}</h1><div dir="ltr" className="text-sm text-[#cfe0d2]" style={{ textAlign: 'right' }}>{u.username ? `@${u.username}` : ''}</div></div>
      <button type="button" className="btn !bg-[#e2ad73] !text-[#1d463b] !border-[#e2ad73] min-h-11" onClick={() => setModal('encourage')} data-testid="button-encourage"><Heart size={16} />شجّعه</button>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-light min-h-11" onClick={() => setModal('remove')} data-testid="button-profile-remove"><UserMinus size={15} />إزالة</button>
      <button type="button" className="btn btn-light min-h-11" onClick={() => setModal('block')} data-testid="button-profile-block"><ShieldOff size={15} />حظر</button>
      <button type="button" className="btn btn-light min-h-11" onClick={() => setModal('report')} data-testid="button-profile-report"><Flag size={15} />إبلاغ</button></div>

    <Block title="الشخصية" testId="section-character">{p.character.length ? <SharedCharacter items={p.character} /> : <Nothing text="لا شيء مشترك معك هنا. لم يشارك شخصيته معك." />}</Block>
    <Block title="الرحلات" testId="section-journeys">{p.visibleJourneySummaries.length === 0 ? <Nothing text="لا رحلات مشتركة معك." /> :
      <ul className="m-0 p-0 list-none grid gap-3">{p.visibleJourneySummaries.map(j => <li key={j.journeyId} className="rounded-2xl bg-[#faf4e4] border border-[#e6dcc2] p-4" data-testid={`card-journey-${j.journeyId}`}>
        <div className="flex items-center gap-2 font-bold"><span aria-hidden>{j.emoji}</span>{j.title}{j.completed && <span className="badge">اكتملت</span>}</div>
        <div className="h-2 rounded-full bg-[#e3d9c9] overflow-hidden my-3"><div className="h-full bg-[#245448]" style={{ width: `${Math.min(100, j.progressDay / 22 * 100)}%` }} /></div>
        <div className="text-sm muted">وصل إلى اليوم {j.progressDay} من 22 · {j.successfulDayCount} يومًا ناجحًا</div>{j.consistencyPercentage != null && <div className="text-sm muted mt-1" data-testid={`text-consistency-${j.journeyId}`}>الاستمرارية: {Math.round(j.consistencyPercentage)}% من الأيام المجدولة</div>}</li>)}</ul>}</Block>
    <Block title="الإنجازات" testId="section-achievements">{p.achievements.length === 0 ? <Nothing text="لا إنجازات مشتركة معك." /> :
      <ul className="m-0 p-0 list-none grid sm:grid-cols-2 gap-3">{p.achievements.map((a, i) => <li key={i} className="rounded-2xl bg-[#f6e5bf] p-4"><div className="font-bold"><span aria-hidden>{a.emoji}</span> {a.title}</div><div className="text-sm">{a.description}</div><div className="text-xs muted mt-1">{arDate(a.reachedAt)}</div></li>)}</ul>}</Block>
    <Block title="ذكريات مشتركة" testId="section-memories">{p.sharedMemories.length === 0 ? <Nothing text="لا ذكريات مشتركة معك." /> :
      <ul className="m-0 p-0 list-none grid grid-cols-2 md:grid-cols-3 gap-3">{p.sharedMemories.map(m => <li key={m.id} className="rounded-2xl overflow-hidden bg-[#faf4e4] border border-[#e6dcc2]" data-testid={`card-memory-${m.id}`}><SocialMemoryPhoto memoryId={m.id} className="w-full h-36" /><div className="p-2 text-xs"><div className="muted">{arDate(m.date.slice(0, 10))}</div>{m.caption && <div className="mt-1 break-words">{m.caption}</div>}</div></li>)}</ul>}</Block>
    <Block title="مكافآت مشتركة" testId="section-rewards">{p.sharedRewards.length === 0 ? <Nothing text="لا مكافآت مشتركة معك." /> :
      <ul className="m-0 p-0 list-none flex flex-wrap gap-2">{p.sharedRewards.map(r => <li key={r.id} className="badge !py-2 !px-3" data-testid={`card-reward-${r.id}`}><span aria-hidden>{r.emoji}</span> {r.title}</li>)}</ul>}</Block>
    {q.isFetching && !q.isLoading && <InlineError message="نحدّث الملف…" />}
    {modal === 'encourage' && <EncourageModal user={u} journeys={p.visibleJourneySummaries} onClose={() => setModal(null)} />}
    {(modal === 'remove' || modal === 'block') && <ConfirmFriendModal mode={modal} user={u} onClose={() => setModal(null)} onDone={() => nav('/friends')} />}
    {modal === 'report' && <ReportModal user={u} onClose={() => setModal(null)} />}
  </div>;
}
