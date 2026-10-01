import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { toast } from 'sonner';
import { CheckCheck, BellOff } from 'lucide-react';
import { listSocialNotifications, getListSocialNotificationsQueryKey, useMarkSocialNotificationRead, useMarkAllSocialNotificationsRead, type SocialNotification } from '@workspace/api-client-react';
import { PageHead, arDate } from '@/components/journey-ui';
import { SocialAvatar, InlineError, ListSkeleton, SoftEmpty, socialError, useRefreshSocial } from '@/components/social/social-common';

const PAGE = 30;
const encouragementText: Record<string, string> = { nice_work: 'عمل جميل!', keep_going: 'واصل التقدم!', great_job: 'أحسنت!', you_got_this: 'أنت قادر على ذلك!', keep_moving: 'تابع بخطواتك!' };
function describe(n: SocialNotification): { text: string; href?: string; cta?: string } {
  const who = n.actor?.displayName ?? 'شخص ما';
  switch (n.type) {
    case 'friend_request_received': return { text: `${who} أرسل لك طلب صداقة.`, href: '/friends', cta: 'افتح الطلبات' };
    case 'friend_request_accepted': return { text: `${who} قبل طلب صداقتك.`, href: n.actor ? `/friends/${n.actor.id}` : '/friends', cta: 'الملف' };
    case 'challenge_invitation': return { text: `${who} دعاك إلى تحدٍّ.`, href: n.challengeId ? `/challenges/${n.challengeId}` : '/challenges', cta: 'افتح التحدي' };
    case 'challenge_accepted': return { text: `${who} انضم إلى تحديك.`, href: n.challengeId ? `/challenges/${n.challengeId}` : '/challenges', cta: 'افتح التحدي' };
    case 'challenge_declined': return { text: `${who} اعتذر عن التحدي.`, href: n.challengeId ? `/challenges/${n.challengeId}` : '/challenges', cta: 'افتح التحدي' };
    case 'group_invitation': return { text: `${who} دعاك إلى دائرة.`, href: '/groups', cta: 'افتح الدعوات' };
    case 'group_member_joined': return { text: `${who} انضم إلى دائرتك.`, href: n.groupId ? `/groups/${n.groupId}` : '/groups', cta: 'افتح الدائرة' };
    case 'encouragement_received': return { text: `${who} أرسل لك تشجيعًا: ${n.encouragementMessage || encouragementText[n.encouragementTemplate ?? ''] || 'واصل بخطواتك.'}`, href: n.groupId ? `/groups/${n.groupId}` : n.actor ? `/friends/${n.actor.id}` : undefined, cta: n.groupId ? 'افتح الدائرة' : 'الملف' };
    case 'shared_milestone': return { text: `${who} وصل إلى محطة في رحلة شاركها معك.`, href: n.actor ? `/friends/${n.actor.id}` : undefined, cta: 'الملف' };
    case 'group_milestone': return { text: 'وصلت دائرتك إلى محطة جديدة.', href: n.groupId ? `/groups/${n.groupId}` : '/groups', cta: 'افتح الدائرة' };
    default: return { text: 'إشعار جديد.' };
  }
}

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const params = { limit: PAGE, ...(unreadOnly ? { unreadOnly: true } : {}) };
  const q = useInfiniteQuery({
    queryKey: getListSocialNotificationsQueryKey(params),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => listSocialNotifications({ ...params, ...(pageParam == null ? {} : { beforeId: pageParam }) }),
    getNextPageParam: lastPage => lastPage.length === PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
    retry: false, staleTime: 15_000, refetchInterval: 60_000,
  });
  const read = useMarkSocialNotificationRead(), all = useMarkAllSocialNotificationsRead(), refresh = useRefreshSocial();
  const list = Array.from(new Map((q.data?.pages.flat() ?? []).map(n => [n.id, n])).values()), unread = list.filter(n => !n.readAt).length;
  const markOne = (id: number) => read.mutate({ notificationId: id }, { onSuccess: () => refresh(), onError: e => toast.error(socialError(e)) });
  return <div className="max-w-[760px]">
    <PageHead overline="صندوقك" title="الإشعارات" desc="أخبار الأصدقاء والدعوات فقط. لا شيء عن الأيام الفائتة." action={<button className="btn btn-light min-h-11" disabled={all.isPending || unread === 0} data-testid="button-read-all" onClick={() => all.mutate(undefined as never, { onSuccess: r => { toast.success(r.updatedCount ? 'عُلّمت كلها كمقروءة.' : 'لا جديد لتعليمه.'); refresh(); }, onError: e => toast.error(socialError(e)) })}><CheckCheck size={16} />قراءة الكل</button>} />
    <div className="flex gap-2 mb-5" role="tablist">{[false, true].map(v => <button key={String(v)} role="tab" aria-selected={unreadOnly === v} type="button" onClick={() => setUnreadOnly(v)} data-testid={v ? 'tab-unread' : 'tab-all'} className={`min-h-11 px-4 rounded-full border text-sm font-bold ${unreadOnly === v ? 'bg-[#245448] text-[#fff9e9] border-[#ded7c7]' : 'bg-[#fffaf0] border-[#ded7c7]'}`}>{v ? 'غير المقروءة' : 'الكل'}</button>)}</div>
    {q.isLoading ? <ListSkeleton rows={4} /> : q.isError ? <InlineError message="تعذّر تحميل الإشعارات." retry={() => q.refetch()} />
      : list.length === 0 ? <SoftEmpty icon={<BellOff size={22} />} title={unreadOnly ? 'لا إشعارات غير مقروءة' : 'صندوقك هادئ'} desc="حين يحدث شيء مع أصدقائك ستجده هنا." />
      : <><ul className="m-0 p-0 list-none space-y-3">{list.map(n => { const d = describe(n); return <li key={n.id} data-testid={`row-notification-${n.id}`} className={`rounded-2xl p-4 flex flex-wrap items-center gap-3 border ${n.readAt ? 'bg-[#fffaf0] border-[#e8dfcb]' : 'bg-[#e9efe3] border-[#bdd0b9]'}`}>
        {n.actor ? <SocialAvatar user={n.actor} size={40} /> : <span className="w-10 h-10 rounded-full bg-[#e5eadc]" />}
        <div className="flex-1 min-w-[180px]"><div className={n.readAt ? '' : 'font-bold'}>{d.text}</div><div className="text-xs muted">{arDate(n.createdAt)}</div></div>
        <div className="flex gap-2 flex-wrap">
          {d.href && <Link href={d.href} onClick={() => !n.readAt && markOne(n.id)} className="btn min-h-11" data-testid={`link-notification-${n.id}`}>{d.cta}</Link>}
          {!n.readAt && <button type="button" className="btn btn-light min-h-11" disabled={read.isPending} onClick={() => markOne(n.id)} data-testid={`button-read-${n.id}`}>تمّت القراءة</button>}</div></li>; })}</ul>
        {q.hasNextPage && <div className="text-center mt-5"><button type="button" className="btn btn-light min-h-11" disabled={q.isFetching} onClick={() => void q.fetchNextPage()} data-testid="button-load-more">{q.isFetching ? 'نحمّل…' : 'عرض المزيد'}</button></div>}</>}
  </div>;
}
