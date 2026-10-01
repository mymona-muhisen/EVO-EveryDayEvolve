import { useState } from 'react';
import { Link } from 'wouter';
import { toast } from 'sonner';
import { Search, UserPlus, Check, X, MoreHorizontal, ShieldOff, Flag, UserMinus, Users, Inbox, Ban, Sparkles } from 'lucide-react';
import {
  useListSocialFriends, getListSocialFriendsQueryKey, useListIncomingSocialFriendRequests, getListIncomingSocialFriendRequestsQueryKey,
  useListOutgoingSocialFriendRequests, getListOutgoingSocialFriendRequestsQueryKey, useSearchSocialUsers, getSearchSocialUsersQueryKey,
  useSendSocialFriendRequest, useRespondToSocialFriendRequest, useCancelSocialFriendRequest, useListSocialBlocks, getListSocialBlocksQueryKey,
  useRemoveSocialBlock, useListSocialActivity, getListSocialActivityQueryKey, useGetSocialMe, getGetSocialMeQueryKey,
  type SocialUserSummary, type SocialUserSearchResult,
} from '@workspace/api-client-react';
import { PageHead } from '@/components/journey-ui';
import { PersonLine, InlineError, ListSkeleton, SoftEmpty, socialError, useRefreshSocial, normalizeUsername, usernameValid } from '@/components/social/social-common';
import { ConfirmFriendModal, ReportModal } from '@/components/social/social-widgets';
import { arDate } from '@/components/journey-ui';

type Tab = 'friends' | 'requests' | 'search' | 'blocked';
const tabs: { id: Tab; label: string; icon: typeof Users }[] = [{ id: 'friends', label: 'أصدقائي', icon: Users }, { id: 'requests', label: 'الطلبات', icon: Inbox }, { id: 'search', label: 'إضافة', icon: UserPlus }, { id: 'blocked', label: 'المحظورون', icon: Ban }];
const eventText: Record<string, string> = { successful_day: 'أنجز يومًا جديدًا', milestone: 'وصل إلى محطة', journey_completed: 'أتمّ رحلته' };

export function FriendsPage() {
  const [tab, setTab] = useState<Tab>('friends');
  const incoming = useListIncomingSocialFriendRequests({ query: { queryKey: getListIncomingSocialFriendRequestsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const pend = (incoming.data ?? []).filter(r => r.status === 'pending').length;
  return <div className="max-w-[860px]">
    <PageHead overline="دائرة الثقة" title="الأصدقاء" desc="أشخاص تختارهم يشجّعونك بهدوء. لا خلاصة عامة، ولا شيء يُرى قبل أن تشارك." />
    <div role="tablist" className="flex gap-1 overflow-x-auto mb-6 p-1 rounded-2xl bg-[#efe6d0]">
      {tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" data-testid={`tab-${t.id}`} onClick={() => setTab(t.id)} className={`flex-1 min-h-11 px-3 rounded-xl flex items-center justify-center gap-2 whitespace-nowrap text-sm font-bold ${tab === t.id ? 'bg-[#fffaf0] text-[#245448] shadow-sm' : 'text-[#5d6f63]'}`}><t.icon size={16} />{t.label}{t.id === 'requests' && pend > 0 && <span className="badge !bg-[#f3d6b8]">{pend}</span>}</button>)}
    </div>
    {tab === 'friends' && <FriendsTab goAdd={() => setTab('search')} />}
    {tab === 'requests' && <RequestsTab />}
    {tab === 'search' && <SearchTab />}
    {tab === 'blocked' && <BlockedTab />}
  </div>;
}

function FriendsTab({ goAdd }: { goAdd: () => void }) {
  const fr = useListSocialFriends({ query: { queryKey: getListSocialFriendsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const [menu, setMenu] = useState<string | null>(null);
  const [act, setAct] = useState<{ mode: 'remove' | 'block' | 'report'; user: SocialUserSummary } | null>(null);
  if (fr.isLoading) return <ListSkeleton />;
  if (fr.isError) return <InlineError message="تعذّر تحميل أصدقائك." retry={() => fr.refetch()} />;
  const list = fr.data ?? [];
  return <div className="space-y-8">
    {list.length === 0 ? <SoftEmpty icon={<Users size={22} />} title="لا أصدقاء بعد" desc="ابحث عن شخص تثق به باسم مستخدمه وأرسل له طلبًا." action={<button className="btn min-h-11" onClick={goAdd} data-testid="button-go-add">أضف صديقًا</button>} />
      : <ul className="m-0 p-0 list-none space-y-3">{list.map(f => <li key={f.id} className="paper rounded-2xl p-3 relative" data-testid={`row-friend-${f.id}`}>
        <PersonLine user={f} extra={<div className="text-xs muted">أصدقاء منذ {arDate(f.friendsSince)}</div>} right={<div className="flex gap-2 items-center">
          <Link href={`/friends/${f.id}`} className="btn btn-light min-h-11" data-testid={`link-friend-${f.id}`}>الملف</Link>
          <button type="button" aria-label="المزيد" aria-expanded={menu === f.id} className="btn btn-light !p-0 w-11 h-11" onClick={() => setMenu(menu === f.id ? null : f.id)} data-testid={`button-friend-menu-${f.id}`}><MoreHorizontal size={18} /></button></div>} />
        {menu === f.id && <div className="mt-3 flex flex-wrap gap-2 border-t border-[#e8dfcb] pt-3">
          <button type="button" className="btn btn-light min-h-11" onClick={() => { setMenu(null); setAct({ mode: 'remove', user: f }); }} data-testid={`button-remove-${f.id}`}><UserMinus size={15} />إزالة</button>
          <button type="button" className="btn btn-light min-h-11" onClick={() => { setMenu(null); setAct({ mode: 'block', user: f }); }} data-testid={`button-block-${f.id}`}><ShieldOff size={15} />حظر</button>
          <button type="button" className="btn btn-light min-h-11" onClick={() => { setMenu(null); setAct({ mode: 'report', user: f }); }} data-testid={`button-report-${f.id}`}><Flag size={15} />إبلاغ</button></div>}
      </li>)}</ul>}
    <ActivitySection hasFriends={list.length > 0} />
    {act && (act.mode === 'report' ? <ReportModal user={act.user} onClose={() => setAct(null)} /> : <ConfirmFriendModal mode={act.mode} user={act.user} onClose={() => setAct(null)} />)}
  </div>;
}

function ActivitySection({ hasFriends }: { hasFriends: boolean }) {
  const params = { limit: 20 };
  const q = useListSocialActivity(params, { query: { queryKey: getListSocialActivityQueryKey(params), retry: false, enabled: hasFriends } });
  if (!hasFriends) return null;
  return <section><h2 className="text-xl font-extrabold mb-3">لحظات إيجابية من أصدقائك</h2>
    {q.isLoading ? <ListSkeleton rows={2} /> : q.isError ? <InlineError message="تعذّر تحميل النشاط." retry={() => q.refetch()} />
      : !q.data?.length ? <SoftEmpty icon={<Sparkles size={22} />} title="هدوء جميل" desc="حين يشارك أصدقاؤك تقدمهم ستظهر هنا خطواتهم الناجحة فقط." />
      : <ul className="m-0 p-0 list-none space-y-2">{q.data.map(a => <li key={a.id} className="rounded-2xl bg-[#e9efe3] p-3" data-testid={`row-activity-${a.id}`}>
        <PersonLine user={a.actor} extra={<div className="text-sm">{eventText[a.eventType] ?? 'خطوة جديدة'}{a.journey ? ` في «${a.journey.title}»` : ''}{a.progressDay != null ? ` · اليوم ${a.progressDay}` : ''}{a.milestoneTitle ? ` · ${a.milestoneTitle}` : ''}</div>} right={<Link href={`/friends/${a.actor.id}`} className="btn btn-light min-h-11">شجّعه</Link>} /></li>)}</ul>}
  </section>;
}

function RequestsTab() {
  const inc = useListIncomingSocialFriendRequests({ query: { queryKey: getListIncomingSocialFriendRequestsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const out = useListOutgoingSocialFriendRequests({ query: { queryKey: getListOutgoingSocialFriendRequestsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const refresh = useRefreshSocial();
  const respond = useRespondToSocialFriendRequest(), cancel = useCancelSocialFriendRequest();
  const [block, setBlock] = useState<SocialUserSummary | null>(null);
  const busy = respond.isPending || cancel.isPending;
  const onErr = (e: unknown) => { toast.error(socialError(e)); refresh(); };
  const answer = (id: number, decision: 'accept' | 'decline') => respond.mutate({ requestId: id, data: { decision } }, { onSuccess: () => { toast.success(decision === 'accept' ? 'أصبحتما صديقين.' : 'رُفض الطلب.'); refresh(); }, onError: onErr });
  const pi = (inc.data ?? []).filter(r => r.status === 'pending'), po = (out.data ?? []).filter(r => r.status === 'pending');
  return <div className="space-y-8">
    <section><h2 className="text-xl font-extrabold mb-3">طلبات وصلتك</h2>
      {inc.isLoading ? <ListSkeleton rows={2} /> : inc.isError ? <InlineError message="تعذّر تحميل الطلبات الواردة." retry={() => inc.refetch()} />
        : pi.length === 0 ? <SoftEmpty title="لا طلبات جديدة" desc="عندما يرسل لك أحد طلبًا سيظهر هنا." />
        : <ul className="m-0 p-0 list-none space-y-3">{pi.map(r => <li key={r.id} className="paper rounded-2xl p-3" data-testid={`row-incoming-${r.id}`}><PersonLine user={r.sender} extra={<div className="text-xs muted">{arDate(r.createdAt)}</div>} />
          <div className="flex flex-wrap gap-2 mt-3"><button className="btn min-h-11" disabled={busy} onClick={() => answer(r.id, 'accept')} data-testid={`button-accept-${r.id}`}><Check size={15} />قبول</button>
            <button className="btn btn-light min-h-11" disabled={busy} onClick={() => answer(r.id, 'decline')} data-testid={`button-decline-${r.id}`}><X size={15} />رفض</button>
            <button className="btn btn-light min-h-11" disabled={busy} onClick={() => setBlock(r.sender)} data-testid={`button-block-incoming-${r.id}`}><ShieldOff size={15} />حظر</button></div></li>)}</ul>}</section>
    <section><h2 className="text-xl font-extrabold mb-3">طلبات أرسلتها</h2>
      {out.isLoading ? <ListSkeleton rows={2} /> : out.isError ? <InlineError message="تعذّر تحميل الطلبات المرسلة." retry={() => out.refetch()} />
        : po.length === 0 ? <SoftEmpty title="لا طلبات معلّقة" desc="الطلبات التي ترسلها تنتظر ردّ صاحبها هنا." />
        : <ul className="m-0 p-0 list-none space-y-3">{po.map(r => <li key={r.id} className="paper rounded-2xl p-3" data-testid={`row-outgoing-${r.id}`}><PersonLine user={r.recipient} extra={<div className="text-xs muted">بانتظار الرد</div>}
          right={<button className="btn btn-light min-h-11" disabled={busy} onClick={() => cancel.mutate({ requestId: r.id }, { onSuccess: () => { toast.success('أُلغي الطلب.'); refresh(); }, onError: onErr })} data-testid={`button-cancel-${r.id}`}>إلغاء الطلب</button>} /></li>)}</ul>}</section>
    {block && <ConfirmFriendModal mode="block" user={block} onClose={() => setBlock(null)} />}
  </div>;
}

function SearchTab() {
  const [input, setInput] = useState(''), [term, setTerm] = useState(''), [err, setErr] = useState('');
  const me = useGetSocialMe({ query: { queryKey: getGetSocialMeQueryKey(), retry: false } });
  const q = useSearchSocialUsers({ q: term }, { query: { enabled: term.length >= 2, queryKey: getSearchSocialUsersQueryKey({ q: term }), retry: false, staleTime: 0 } });
  const inc = useListIncomingSocialFriendRequests({ query: { queryKey: getListIncomingSocialFriendRequestsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const out = useListOutgoingSocialFriendRequests({ query: { queryKey: getListOutgoingSocialFriendRequestsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const send = useSendSocialFriendRequest(), respond = useRespondToSocialFriendRequest(), cancel = useCancelSocialFriendRequest();
  const refresh = useRefreshSocial();
  const submit = (e: React.FormEvent) => { e.preventDefault(); const n = normalizeUsername(input); if (!usernameValid(n, 2)) { setErr('اكتب اسم مستخدم من حرفين إلى 24: إنجليزي صغير وأرقام وشرطة سفلية.'); setTerm(''); return; } setErr(''); setInput(n); setTerm(n); };
  const onErr = (e: unknown) => { toast.error(socialError(e)); refresh(); };
  const reqFor = (list: typeof inc.data, uid: string) => (list ?? []).find(r => r.status === 'pending' && (r.sender.id === uid || r.recipient.id === uid));
  const action = (u: SocialUserSearchResult) => {
    const b = (label: string, fn: () => void, testid: string, light = false) => <button className={`btn min-h-11 ${light ? 'btn-light' : ''}`} disabled={send.isPending || respond.isPending || cancel.isPending} onClick={fn} data-testid={testid}>{label}</button>;
    switch (u.relationship) {
      case 'none': return b('أرسل طلبًا', () => send.mutate({ data: { recipientUserId: u.id } }, { onSuccess: () => { toast.success('أُرسل الطلب.'); refresh(); }, onError: onErr }), `button-send-${u.id}`);
      case 'pending_outgoing': { const r = reqFor(out.data, u.id); return r ? b('إلغاء الطلب', () => cancel.mutate({ requestId: r.id }, { onSuccess: () => { toast.success('أُلغي الطلب.'); refresh(); }, onError: onErr }), `button-cancel-search-${u.id}`, true) : <span className="badge">بانتظار الرد</span>; }
      case 'pending_incoming': { const r = reqFor(inc.data, u.id); return r ? b('قبول', () => respond.mutate({ requestId: r.id, data: { decision: 'accept' } }, { onSuccess: () => { toast.success('أصبحتما صديقين.'); refresh(); }, onError: onErr }), `button-accept-search-${u.id}`) : <span className="badge">أرسل لك طلبًا</span>; }
      case 'friend': return <Link href={`/friends/${u.id}`} className="btn btn-light min-h-11">صديقك، افتح الملف</Link>;
      default: return <span className="badge">غير متاح</span>;
    }
  };
  const results = (q.data ?? []).filter(u => u.id !== me.data?.id);
  return <div>
    {me.data && !me.data.username && <div className="rounded-2xl bg-[#f6e5bf] p-4 mb-4 text-sm">لم تختر اسم مستخدم بعد، لذلك لن يجدك الآخرون. اختره من <Link href="/settings" className="font-bold underline" data-testid="link-choose-username">الإعدادات</Link>.</div>}
    <form onSubmit={submit} className="flex gap-2 mb-2" role="search">
      <input dir="ltr" style={{ textAlign: 'left' }} className="field min-h-11 flex-1" placeholder="اسم المستخدم بالإنجليزية، مثل noor_22" value={input} onChange={e => setInput(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={25} aria-label="اسم المستخدم" data-testid="input-search-username" />
      <button className="btn min-h-11" type="submit" data-testid="button-search"><Search size={16} />بحث</button></form>
    <p className="text-xs muted mb-5">البحث باسم المستخدم فقط ولا يتأثر بحالة الأحرف. لا نعرض بريدًا ولا بيانات أخرى.</p>
    {err && <p role="alert" className="text-sm text-[#a35548]" data-testid="text-search-error">{err}</p>}
    {term && !err && (q.isLoading ? <ListSkeleton rows={2} /> : q.isError ? <InlineError message={socialError(q.error, 'تعذّر البحث.')} retry={() => q.refetch()} />
      : results.length === 0 ? <SoftEmpty icon={<Search size={22} />} title="لا نتائج" desc={`لم نجد اسم مستخدم يطابق «${term}». تأكد من الكتابة وجرّب مجددًا.`} />
      : <ul className="m-0 p-0 list-none space-y-3">{results.map(u => <li key={u.id} className="paper rounded-2xl p-3" data-testid={`row-result-${u.id}`}><PersonLine user={u} right={action(u)} /></li>)}</ul>)}
  </div>;
}

function BlockedTab() {
  const bl = useListSocialBlocks({ query: { queryKey: getListSocialBlocksQueryKey(), retry: false } });
  const un = useRemoveSocialBlock(), refresh = useRefreshSocial();
  if (bl.isLoading) return <ListSkeleton rows={2} />;
  if (bl.isError) return <InlineError message="تعذّر تحميل المحظورين." retry={() => bl.refetch()} />;
  if (!bl.data?.length) return <SoftEmpty icon={<Ban size={22} />} title="لا أحد محظور" desc="من تحظره لا يراك ولا تراه. يمكنك فك الحظر في أي وقت." />;
  return <ul className="m-0 p-0 list-none space-y-3">{bl.data.map(b => <li key={b.id} className="paper rounded-2xl p-3" data-testid={`row-blocked-${b.id}`}><PersonLine user={b}
    right={<button className="btn btn-light min-h-11" disabled={un.isPending} data-testid={`button-unblock-${b.id}`} onClick={() => un.mutate({ blockedUserId: b.id }, { onSuccess: () => { toast.success('فُكّ الحظر. الصداقة لا تعود تلقائيًا.'); refresh(); }, onError: e => toast.error(socialError(e)) })}>فك الحظر</button>} /></li>)}</ul>;
}
