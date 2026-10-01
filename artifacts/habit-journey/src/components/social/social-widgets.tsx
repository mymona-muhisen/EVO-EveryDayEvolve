import { useState } from 'react';
import { Link } from 'wouter';
import { toast } from 'sonner';
import { Users, Bell, ArrowLeft, ImageOff, Heart } from 'lucide-react';
import {
  useGetSocialProfile, getGetSocialProfileQueryKey,
  useGetSocialMe, getGetSocialMeQueryKey, useUpdateSocialMe, useListSocialFriends, getListSocialFriendsQueryKey,
  useListIncomingSocialFriendRequests, getListIncomingSocialFriendRequestsQueryKey,
  useRemoveSocialFriend, useCreateSocialBlock, useCreateSocialReport, useCreateSocialEncouragement, useGetSocialMemoryPhoto, getGetSocialMemoryPhotoQueryKey,
  SocialReportInputReason, SocialEncouragementInputTemplate, SocialEncouragementInputType,
  type SocialUserSummary, type SocialJourneySummary, type SocialEquippedCharacterItem,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { SocialModal, SocialAvatar, InlineError, socialError, useRefreshSocial, useObjectUrl, useUnreadCount, newRequestId, normalizeUsername, usernameValid, statusOf } from './social-common';
import { GenericSharingControl } from './sharing';
import { CHARACTER_STILL, slotLabels } from '@/components/character/character-avatar';

/* ---------- friend management modals ---------- */
export function ConfirmFriendModal({ mode, user, onClose, onDone }: { mode: 'remove' | 'block'; user: SocialUserSummary; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefreshSocial();
  const rm = useRemoveSocialFriend(), bl = useCreateSocialBlock();
  const pending = rm.isPending || bl.isPending;
  const opts = { onSuccess: () => { refresh(); toast.success(mode === 'remove' ? 'أُزيلت الصداقة وانقطع الوصول فورًا.' : 'حُظر المستخدم.'); onDone?.(); onClose(); }, onError: (e: unknown) => toast.error(socialError(e)) };
  const go = () => mode === 'remove' ? rm.mutate({ friendUserId: user.id }, opts) : bl.mutate({ data: { blockedUserId: user.id } }, opts);
  return <SocialModal title={mode === 'remove' ? 'إزالة صديق' : 'حظر مستخدم'} onClose={onClose} testId={`modal-${mode}`}>
    <p className="mt-0">{mode === 'remove' ? `ستزول الصداقة مع ${user.displayName}، ويفقد كل منكما رؤية ما شاركه الآخر. لا يُرسل له إشعار.` : `سيُحظر ${user.displayName}: تُزال الصداقة والطلبات، ولن يرى أي شيء منك ولن تراه.`}</p>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn min-h-11" disabled={pending} onClick={go} data-testid={`button-confirm-${mode}`}>{pending ? 'لحظة…' : mode === 'remove' ? 'نعم، أزل الصديق' : 'نعم، احظر'}</button>
      <button type="button" className="btn btn-light min-h-11" onClick={onClose}>تراجع</button></div>
  </SocialModal>;
}

const reasons: [keyof typeof SocialReportInputReason, string][] = [['spam', 'رسائل مزعجة'], ['inappropriate_content', 'محتوى غير لائق'], ['harassment', 'مضايقة'], ['other', 'سبب آخر']];
export function ReportModal({ user, onClose }: { user: SocialUserSummary; onClose: () => void }) {
  const [reason, setReason] = useState<keyof typeof SocialReportInputReason>('spam'), [details, setDetails] = useState('');
  const rep = useCreateSocialReport();
  const submit = () => rep.mutate({ data: { reportedUserId: user.id, reason, ...(details.trim() ? { details: details.trim() } : {}) } }, {
    onSuccess: () => { toast.success('وصلنا بلاغك. شكرًا لأنك نبّهتنا.'); onClose(); }, onError: e => toast.error(socialError(e, 'تعذّر إرسال البلاغ.')) });
  return <SocialModal title={`الإبلاغ عن ${user.displayName}`} onClose={onClose} testId="modal-report">
    <div role="radiogroup" className="grid gap-2 mb-3">{reasons.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={reason === v} onClick={() => setReason(v)} data-testid={`radio-report-${v}`} className={`min-h-11 rounded-xl border px-3 text-right ${reason === v ? 'bg-[#e2ece0] border-[#245448] font-bold' : 'bg-[#fffaf0] border-[#ded7c7]'}`}>{l}</button>)}</div>
    <label className="block mb-4"><span className="block text-sm font-bold mb-2">تفاصيل اختيارية</span><textarea className="field min-h-24" maxLength={500} value={details} onChange={e => setDetails(e.target.value)} data-testid="input-report-details" /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn min-h-11" disabled={rep.isPending} onClick={submit} data-testid="button-submit-report">{rep.isPending ? 'نرسل…' : 'أرسل البلاغ'}</button><button type="button" className="btn btn-light min-h-11" onClick={onClose}>إلغاء</button></div>
  </SocialModal>;
}

/* ---------- encouragement ---------- */
const templates: [keyof typeof SocialEncouragementInputTemplate, string][] = [['nice_work', 'عمل جميل'], ['keep_going', 'واصل، أنت تتقدّم'], ['great_job', 'أحسنت'], ['you_got_this', 'أنت قادر على ذلك'], ['keep_moving', 'خطوة بعد خطوة']];
const kinds: [keyof typeof SocialEncouragementInputType, string][] = [['cheer', 'تشجيع'], ['clap', 'تصفيق'], ['fire', 'حماس'], ['support', 'دعم']];
export function EncourageModal({ user, journeys, onClose }: { user: SocialUserSummary; journeys: SocialJourneySummary[]; onClose: () => void }) {
  const [tpl, setTpl] = useState<keyof typeof SocialEncouragementInputTemplate>('nice_work'), [kind, setKind] = useState<keyof typeof SocialEncouragementInputType>('cheer');
  const [msg, setMsg] = useState(''), [jid, setJid] = useState<number | ''>(''), [rid, setRid] = useState(newRequestId), [sent, setSent] = useState(false), [err, setErr] = useState('');
  const enc = useCreateSocialEncouragement();
  const refresh = useRefreshSocial();
  const send = () => { setErr(''); enc.mutate({ data: { receiverUserId: user.id, type: kind, template: tpl, requestId: rid, ...(jid ? { journeyId: Number(jid) } : {}), ...(msg.trim() ? { message: msg.trim() } : {}) } }, {
    onSuccess: () => { setSent(true); setRid(newRequestId()); refresh(); toast.success('وصل تشجيعك.'); },
    onError: e => { const s = statusOf(e); setErr(s === 409 ? 'أرسلت تشجيعًا قبل لحظات. انتظر دقيقة ثم أعد المحاولة.' : socialError(e, 'تعذّر إرسال التشجيع. يمكنك إعادة المحاولة بأمان.')); } }); };
  return <SocialModal title={`شجّع ${user.displayName}`} onClose={onClose} testId="modal-encourage">
    {sent ? <div className="text-center py-4"><Heart className="mx-auto mb-3 text-[#c87953]" /><p className="font-bold">وصلت رسالتك.</p><button type="button" className="btn min-h-11" onClick={onClose}>تم</button></div> : <>
      <div className="text-sm font-bold mb-2">الرسالة</div>
      <div className="grid gap-2 mb-4" role="radiogroup">{templates.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={tpl === v} onClick={() => setTpl(v)} data-testid={`radio-template-${v}`} className={`min-h-11 rounded-xl border px-3 text-right ${tpl === v ? 'bg-[#e2ece0] border-[#245448] font-bold' : 'bg-[#fffaf0] border-[#ded7c7]'}`}>{l}</button>)}</div>
      <div className="text-sm font-bold mb-2">النوع</div>
      <div className="flex flex-wrap gap-2 mb-4" role="radiogroup">{kinds.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={kind === v} onClick={() => setKind(v)} data-testid={`radio-kind-${v}`} className={`min-h-11 rounded-full border px-4 ${kind === v ? 'bg-[#245448] text-[#fff9e9] border-[#245448]' : 'bg-[#fffaf0] border-[#ded7c7]'}`}>{l}</button>)}</div>
      {journeys.length > 0 && <label className="block mb-4"><span className="block text-sm font-bold mb-2">بخصوص رحلة (اختياري)</span><select className="field min-h-11" value={jid} onChange={e => setJid(e.target.value ? Number(e.target.value) : '')} data-testid="select-encourage-journey"><option value="">بلا رحلة محددة</option>{journeys.map(j => <option key={j.journeyId} value={j.journeyId}>{j.title}</option>)}</select></label>}
      <label className="block mb-4"><span className="block text-sm font-bold mb-2">كلمة منك (اختياري)</span><textarea className="field min-h-20" maxLength={120} value={msg} onChange={e => setMsg(e.target.value)} data-testid="input-encourage-message" /><span className="text-xs muted">{msg.length} / 120</span></label>
      {err && <div className="mb-3"><InlineError message={err} /></div>}
      <button type="button" className="btn min-h-11" disabled={enc.isPending} onClick={send} data-testid="button-send-encouragement">{enc.isPending ? 'نرسل…' : 'أرسل التشجيع'}</button></>}
  </SocialModal>;
}

/* ---------- private photo ---------- */
export function SocialMemoryPhoto({ memoryId, className = '' }: { memoryId: number; className?: string }) {
  const q = useGetSocialMemoryPhoto(memoryId, { query: { queryKey: getGetSocialMemoryPhotoQueryKey(memoryId), retry: false, staleTime: 0, gcTime: 0 } });
  const url = useObjectUrl(q.data);
  if (q.isLoading) return <div className={`skeleton ${className}`} />;
  if (q.isError || !url) return <button type="button" onClick={() => q.refetch()} className={`bg-[#efe6d0] flex flex-col items-center justify-center gap-1 text-xs muted ${className}`} data-testid={`photo-error-${memoryId}`}><ImageOff size={20} />{statusOf(q.error) === 403 || statusOf(q.error) === 404 ? 'الصورة غير متاحة لك' : 'تعذّر التحميل، المس للمحاولة'}</button>;
  return <img src={url} alt="ذكرى مشتركة" className={`object-cover ${className}`} data-testid={`photo-${memoryId}`} />;
}

/* ---------- character renderer (permission controlled by the API response) ---------- */
export function SharedCharacter({ items }: { items: SocialEquippedCharacterItem[] }) {
  return <div className="flex flex-wrap items-center gap-5" data-testid="shared-character">
    <img src={CHARACTER_STILL} alt="شخصية صديقك" className="w-28 h-28 object-contain" />
    <ul className="m-0 p-0 list-none flex-1 min-w-[150px] grid gap-1.5">{items.map((i, n) => <li key={n} className="flex items-center gap-2 text-sm"><span aria-hidden>{i.emoji}</span><b>{i.name}</b><span className="muted text-xs">{slotLabels[i.slot] ?? i.slot}</span></li>)}</ul></div>;
}

/* ---------- settings panel ---------- */
export function SocialSettingsPanel() {
  const me = useGetSocialMe({ query: { queryKey: getGetSocialMeQueryKey(), retry: false } });
  const qc = useQueryClient(), refresh = useRefreshSocial(), upd = useUpdateSocialMe();
  const [val, setVal] = useState<string | null>(null), [err, setErr] = useState('');
  const current = me.data?.username ?? '', shown = val ?? current, norm = normalizeUsername(shown);
  const save = () => {
    if (!usernameValid(norm)) { setErr('من 3 إلى 24 حرفًا: أحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط.'); return; }
    setErr(''); upd.mutate({ data: { username: norm } }, {
      onSuccess: r => { qc.setQueryData(getGetSocialMeQueryKey(), r); setVal(null); refresh(); toast.success('حُفظ اسم المستخدم.'); },
      onError: e => { const m = statusOf(e) === 409 ? 'هذا الاسم مستخدم. جرّب غيره.' : socialError(e, 'تعذّر حفظ الاسم.'); setErr(m); toast.error(m); } });
  };
  return <section className="paper rounded-[22px] p-5 md:p-7 max-w-[760px] space-y-6" data-testid="panel-social-settings">
    <div><div className="eyebrow mb-1">الأصدقاء والخصوصية</div><h2 className="text-2xl font-extrabold m-0">من يراك، وماذا يرى</h2><p className="muted text-sm mt-1">كل شيء خاص حتى تقرر. لا بحث بالاسم الحقيقي، فقط باسم المستخدم.</p></div>
    {me.isLoading ? <div className="skeleton h-24" /> : me.isError ? <InlineError message="تعذّر تحميل إعدادات الأصدقاء." retry={() => me.refetch()} /> : <>
      <form onSubmit={e => { e.preventDefault(); save(); }}>
        <label className="block"><span className="block text-sm font-bold mb-2">اسم المستخدم</span>
          <div className="flex flex-wrap gap-2"><input dir="ltr" className="field min-h-11 flex-1 min-w-[180px]" style={{ textAlign: 'left' }} value={shown} onChange={e => setVal(e.target.value)} placeholder="مثال: noor_22" maxLength={25} autoCapitalize="none" autoCorrect="off" spellCheck={false} data-testid="input-username" />
            <button type="submit" className="btn min-h-11" disabled={upd.isPending || !norm || norm === current} data-testid="button-save-username">{upd.isPending ? 'نحفظ…' : current ? 'غيّر الاسم' : 'احفظ الاسم'}</button></div></label>
        {!current && <p className="text-xs muted mt-2 mb-0">لم تختر اسمًا بعد، لذلك لا يستطيع أحد العثور عليك.</p>}
        {err && <p role="alert" className="text-sm text-[#a35548] mt-2 mb-0" data-testid="text-username-error">{err}</p>}
      </form>
      <GenericSharingControl resourceType="character" resourceId="profile" title="شخصيتي وما ترتديه" />
      <GenericSharingControl resourceType="achievements" resourceId="profile" title="إنجازاتي" />
    </>}
    <Link href="/friends" className="btn btn-light min-h-11" data-testid="link-friends-from-settings"><Users size={16} /> إدارة الأصدقاء</Link>
  </section>;
}

/* ---------- home compact card ---------- */
function PeopleRow({ f }: { f: SocialUserSummary }) {
  const [enc, setEnc] = useState(false);
  const q = useGetSocialProfile(f.id, { query: { queryKey: getGetSocialProfileQueryKey(f.id), retry: false, staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true } });
  const js = q.data?.visibleJourneySummaries ?? [];
  const j = js[0];
  return <li className="flex items-center gap-3 min-h-11" data-testid={`row-people-${f.id}`}>
    <Link href={`/friends/${f.id}`} className="flex items-center gap-3 flex-1 min-w-0"><SocialAvatar user={f} size={40} />
      <span className="min-w-0"><span className="block font-bold text-sm truncate">{f.displayName}</span>
        <span className="block text-xs muted truncate">{q.isLoading ? '...' : j ? `${j.title} · ${j.completed ? 'اكتملت' : `اليوم ${j.progressDay} من 22`}` : 'لا رحلات مشتركة'}</span></span></Link>
    {q.data && <button type="button" className="btn btn-light !p-0 w-11 h-11 shrink-0" aria-label={`شجّع ${f.displayName}`} onClick={() => setEnc(true)} data-testid={`button-people-encourage-${f.id}`}><Heart size={16} /></button>}
    {enc && <EncourageModal user={f} journeys={js} onClose={() => setEnc(false)} />}
  </li>;
}

export function YourPeopleCard() {
  const live = { retry: false, staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true } as const;
  const fr = useListSocialFriends({ query: { queryKey: getListSocialFriendsQueryKey(), ...live } });
  const inc = useListIncomingSocialFriendRequests({ query: { queryKey: getListIncomingSocialFriendRequestsQueryKey(), ...live } });
  const { count } = useUnreadCount();
  const pending = (inc.data ?? []).filter(r => r.status === 'pending').length;
  const list = fr.data ?? [];
  return <div className="paper rounded-[22px] p-5" data-testid="card-your-people">
    <div className="flex items-center justify-between gap-3 mb-3"><h3 className="font-extrabold text-lg m-0">أشخاصي</h3>
      <Link href="/notifications" className="relative min-h-11 px-3 rounded-xl flex items-center gap-2 text-sm font-bold hover:bg-[#efe6d0]" data-testid="link-home-notifications"><Bell size={16} />الإشعارات{count > 0 && <span className="badge !bg-[#f3d6b8]" data-testid="text-home-unread">{count}</span>}</Link></div>
    {fr.isLoading ? <div className="skeleton h-14" /> : fr.isError ? <InlineError message="تعذّر تحميل أصدقائك." retry={() => fr.refetch()} />
      : list.length === 0 ? <p className="text-sm muted m-0 mb-3">لا أصدقاء بعد. ادعُ شخصًا تثق به باسم مستخدمه، وكل شيء يبقى خاصًا حتى تشارك.</p>
      : <ul className="m-0 p-0 list-none space-y-2 mb-3">{list.slice(0, 3).map(f => <PeopleRow key={f.id} f={f} />)}{list.length > 3 && <li className="text-xs muted">و{list.length - 3} آخرين</li>}</ul>}
    <Link href="/friends" className="flex items-center justify-between min-h-11 text-sm font-bold text-[#245448]" data-testid="link-home-friends"><span>{pending > 0 ? `${pending} طلب صداقة ينتظرك` : 'الأصدقاء والطلبات'}</span><ArrowLeft size={15} /></Link>
  </div>;
}
