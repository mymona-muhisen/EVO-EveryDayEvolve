import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Lock, Users, UserCheck, Share2, Check } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetSocialResourceSharing, getGetSocialResourceSharingQueryKey, useUpdateSocialResourceSharing,
  useListSocialFriends, getListSocialFriendsQueryKey, type SocialResourceType, type SocialSharing,
} from '@workspace/api-client-react';
import { SocialModal, SocialAvatar, InlineError, ListSkeleton, socialError, useRefreshSocial } from './social-common';

type Vis = 'private' | 'friends' | 'selected';
const options: { v: Vis; label: string; hint: string; icon: typeof Lock }[] = [
  { v: 'private', label: 'خاص', hint: 'أنت وحدك ترى هذا.', icon: Lock },
  { v: 'friends', label: 'أصدقائي', hint: 'أصدقاؤك المقبولون حاليًا.', icon: Users },
  { v: 'selected', label: 'أشخاص محددون', hint: 'من تختارهم من أصدقائك فقط.', icon: UserCheck },
];

export const sharingLabel = (s?: Pick<SocialSharing, 'visibility' | 'selectedUserIds'>) =>
  !s || s.visibility === 'private' ? 'خاص' : s.visibility === 'friends' ? 'مع أصدقائك' : `مع ${s.selectedUserIds.length} من أصدقائك`;

/** Owner-only explicit sharing control. Starts private/empty; nothing changes until Save or Revoke. */
export function GenericSharingControl({ resourceType, resourceId, title, compact = false }: { resourceType: SocialResourceType; resourceId: string; title?: string; compact?: boolean }) {
  const key = getGetSocialResourceSharingQueryKey(resourceType, resourceId);
  const q = useGetSocialResourceSharing(resourceType, resourceId, { query: { queryKey: key, retry: false } });
  const friends = useListSocialFriends({ query: { queryKey: getListSocialFriendsQueryKey(), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false } });
  const qc = useQueryClient(), refresh = useRefreshSocial();
  const upd = useUpdateSocialResourceSharing();
  const [vis, setVis] = useState<Vis>('private'), [sel, setSel] = useState<string[]>([]);
  const initFor = useRef<string | null>(null), id = `${resourceType}:${resourceId}`;
  useEffect(() => { initFor.current = null; setVis('private'); setSel([]); }, [id]);
  useEffect(() => {
    if (q.data && initFor.current !== id) { initFor.current = id; setVis(q.data.visibility); setSel(q.data.selectedUserIds); }
  }, [q.data, id]);
  const saved = q.data, accepted = new Set((friends.data ?? []).map(f => f.id));
  const dirty = !!saved && (saved.visibility !== vis || (vis === 'selected' && [...sel].sort().join() !== [...saved.selectedUserIds].sort().join()));
  const send = (visibility: Vis, ids: string[], ok: string) => upd.mutate({ resourceType, resourceId, data: { visibility, ...(visibility === 'selected' ? { selectedUserIds: ids } : {}) } }, {
    onSuccess: r => { qc.setQueryData(key, r); setVis(r.visibility); setSel(r.selectedUserIds); toast.success(ok); refresh(); },
    onError: e => toast.error(socialError(e, 'تعذّر حفظ المشاركة. لم يتغيّر شيء.')),
  });
  const save = () => {
    if (vis === 'selected' && sel.length === 0) { toast.error('اختر صديقًا واحدًا على الأقل، أو اجعلها خاصة.'); return; }
    send(vis, vis === 'selected' ? sel.filter(i => accepted.has(i)) : [], vis === 'private' ? 'عادت خاصة بك.' : 'حُفظت المشاركة.');
  };
  const toggle = (uid: string) => setSel(s => s.includes(uid) ? s.filter(x => x !== uid) : [...s, uid]);
  if (q.isLoading) return <ListSkeleton rows={2} />;
  if (q.isError) return <InlineError message="تعذّر قراءة إعداد المشاركة. حتى تتأكد، افترض أنها خاصة." retry={() => q.refetch()} />;
  return <div className="space-y-3" data-testid={`sharing-${resourceType}-${resourceId}`}>
    {title && <div className="font-bold">{title}</div>}
    <div role="radiogroup" aria-label="من يستطيع الرؤية" className={compact ? 'grid gap-2' : 'grid sm:grid-cols-3 gap-2'}>
      {options.map(o => { const on = vis === o.v; return <button key={o.v} type="button" role="radio" aria-checked={on} data-testid={`radio-sharing-${o.v}`} onClick={() => setVis(o.v)}
        className={`min-h-11 text-right rounded-2xl border p-3 flex items-start gap-3 transition-colors ${on ? 'bg-[#e2ece0] border-[#245448]' : 'bg-[#fffaf0] border-[#ded7c7] hover:bg-[#f6efdc]'}`}>
        <o.icon size={18} className="mt-1 shrink-0 text-[#245448]" /><span className="min-w-0"><b className="block">{o.label}</b><span className="text-xs muted">{o.hint}</span></span></button>; })}
    </div>
    {vis === 'selected' && <div className="rounded-2xl bg-[#faf4e4] border border-[#e6dcc2] p-3">
      <div className="text-sm font-bold mb-2">اختر من أصدقائك المقبولين</div>
      {friends.isLoading ? <ListSkeleton rows={2} /> : friends.isError ? <InlineError message="تعذّر تحميل قائمة الأصدقاء." retry={() => friends.refetch()} />
        : !friends.data?.length ? <p className="text-sm muted m-0">لا أصدقاء مقبولين بعد. أضف صديقًا من صفحة الأصدقاء ثم عد إلى هنا.</p>
        : <ul className="space-y-1 m-0 p-0 list-none max-h-56 overflow-auto">{friends.data.map(f => { const on = sel.includes(f.id); return <li key={f.id}>
          <button type="button" role="checkbox" aria-checked={on} data-testid={`check-recipient-${f.id}`} onClick={() => toggle(f.id)} className={`w-full min-h-11 rounded-xl flex items-center gap-3 px-2 text-right ${on ? 'bg-[#dfe9d8]' : 'hover:bg-[#f2ead6]'}`}>
            <SocialAvatar user={f} size={34} /><span className="flex-1 min-w-0 truncate">{f.displayName}{f.username && <span className="text-xs muted" dir="ltr"> @{f.username}</span>}</span>
            <span className={`w-6 h-6 rounded-md border flex items-center justify-center ${on ? 'bg-[#245448] border-[#245448] text-[#fff9e9]' : 'border-[#b9b29b]'}`}>{on && <Check size={14} />}</span></button></li>; })}</ul>}
    </div>}
    <div className="flex flex-wrap gap-2 items-center">
      <button type="button" className="btn min-h-11" disabled={!dirty || upd.isPending} onClick={save} data-testid="button-sharing-save">{upd.isPending ? 'نحفظ…' : 'احفظ المشاركة'}</button>
      {saved && saved.visibility !== 'private' && <button type="button" className="btn btn-light min-h-11" disabled={upd.isPending} onClick={() => send('private', [], 'عادت خاصة بك. سُحب الوصول فورًا.')} data-testid="button-sharing-revoke">إلغاء المشاركة</button>}
      <span className="text-xs muted" data-testid="text-sharing-status">الحالة الحالية: {sharingLabel(saved)}</span>
    </div>
    <p className="text-xs muted m-0">المشاركة من جهتك فقط، ولا تُمنح بالمقابل. لا شيء يُشارك تلقائيًا.</p>
  </div>;
}

/** Compact trigger that opens the control in a portaled modal and shows the live status. */
export function SharingButton({ resourceType, resourceId, title, className = '' }: { resourceType: SocialResourceType; resourceId: string; title: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const q = useGetSocialResourceSharing(resourceType, resourceId, { query: { queryKey: getGetSocialResourceSharingQueryKey(resourceType, resourceId), retry: false } });
  const label = q.isLoading ? '…' : q.isError ? 'تعذّر التحقق' : sharingLabel(q.data);
  return <>
    <button type="button" onClick={() => setOpen(true)} data-testid={`button-share-${resourceType}-${resourceId}`} className={`inline-flex items-center gap-2 min-h-11 px-3 rounded-xl border border-[#d9dbc8] bg-[#fffaf0] text-sm font-bold text-[#245448] ${className}`}>
      <Share2 size={15} /> المشاركة: <span data-testid={`text-share-status-${resourceType}-${resourceId}`}>{label}</span></button>
    {open && <SocialModal title={title} onClose={() => setOpen(false)}><GenericSharingControl resourceType={resourceType} resourceId={resourceId} compact /></SocialModal>}
  </>;
}
