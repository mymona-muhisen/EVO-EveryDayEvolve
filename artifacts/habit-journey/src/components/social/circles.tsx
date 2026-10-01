import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListIncomingSocialGroupInvitationsQueryKey,
  getListSocialGroupsQueryKey,
  getListSocialChallengesQueryKey,
  getListSocialFriendsQueryKey,
  getListSocialNotificationsQueryKey,
  useCreateSocialChallenge,
  useInviteUsersToSocialChallenge,
  useListIncomingSocialGroupInvitations,
  useListSocialFriends,
  useRespondToSocialGroupInvitation,
  type SocialFriend,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowLeft, LoaderCircle, ShieldCheck, Users, X } from 'lucide-react';

import { SocialModal } from './social-common';
export { SocialModal } from './social-common';

export function FriendCheckboxList({
  friends,
  selected,
  onChange,
  isLoading,
  isError,
  onRetry,
  emptyText = 'أضف أصدقاء أولًا لتتمكن من إرسال الدعوات.',
}: {
  friends?: SocialFriend[];
  selected: string[];
  onChange: (next: string[]) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  emptyText?: string;
}) {
  if (isLoading) return <div className="flex min-h-20 items-center justify-center gap-2 text-sm muted" role="status"><LoaderCircle size={18} className="animate-spin" /> جارٍ تحميل الأصدقاء…</div>;
  if (isError) return <div className="rounded-xl border border-[#ead5cd] bg-[#fff7f2] p-3 text-sm" role="alert">تعذّر تحميل الأصدقاء. {onRetry && <button type="button" className="ms-1 min-h-11 underline" onClick={onRetry}>أعد المحاولة</button>}</div>;
  if (!friends?.length) return <p className="muted rounded-xl bg-[#f6f1e7] p-3 text-sm leading-6">{emptyText}</p>;
  return (
    <div className="max-h-56 space-y-2 overflow-y-auto">
      {friends.map(friend => {
        const checked = selected.includes(friend.id);
        return (
          <label key={friend.id} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${checked ? 'border-[#3b765c] bg-[#e7efe4]' : 'border-[#e6ddce] bg-white/60'}`}>
            <input
              type="checkbox"
              className="h-5 w-5 accent-[#245448]"
              checked={checked}
              onChange={event => onChange(event.target.checked ? [...selected, friend.id] : selected.filter(id => id !== friend.id))}
            />
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e5ece0] font-bold text-[#285b48]">{friend.avatarEmoji}</span>
            <span className="min-w-0 flex-1 truncate font-semibold">{friend.displayName}</span>
            {friend.username && <span className="truncate text-xs muted" dir="ltr">@{friend.username}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function SocialGroupInvitationInbox({ onAccepted }: { onAccepted?: (groupId: number) => void }) {
  const invitations = useListIncomingSocialGroupInvitations();
  const respond = useRespondToSocialGroupInvitation();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListIncomingSocialGroupInvitationsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListSocialGroupsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
  };
  if (invitations.isLoading) return <section className="paper mb-7 rounded-[22px] p-5" aria-busy="true"><div className="mb-3 h-5 w-44 skeleton" /><div className="h-16 skeleton" /></section>;
  if (invitations.isError) return <section className="mb-7 rounded-2xl border border-[#ead5cd] bg-[#fff7f2] p-4 text-sm" role="alert">تعذّر تحميل دعوات المجموعات. <button type="button" className="min-h-11 underline" onClick={() => invitations.refetch()}>أعد المحاولة</button></section>;
  if (!invitations.data?.length) return null;
  return (
    <section className="paper mb-7 rounded-[22px] p-5 sm:p-6" aria-label="دعوات المجموعات">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#e5ece0] text-[#285b48]"><Users size={21} /></span>
        <div><div className="eyebrow">مساحتك الخاصة</div><h2 className="m-0 text-xl font-extrabold">دعوات وصلت إليك</h2></div>
      </div>
      <div className="space-y-3">
        {invitations.data.map(invite => (
          <div key={invite.id} className="flex flex-col gap-3 rounded-xl border border-[#e8dfce] bg-white/50 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1"><strong>{invite.groupName}</strong><p className="muted mb-0 mt-1 text-sm">دعوة من {invite.inviter.displayName} إلى مجموعة خاصة.</p></div>
            <div className="flex gap-2">
              <button type="button" className="btn !min-h-11 !px-4" disabled={respond.isPending} onClick={() => respond.mutate({ invitationId: invite.id, data: { decision: 'accept' } }, {
                onSuccess: () => { refresh(); toast.success('قبلت الدعوة إلى المجموعة'); onAccepted?.(invite.groupId); },
                onError: () => toast.error('تعذّر قبول الدعوة. أعد المحاولة.'),
              })}>قبول</button>
              <button type="button" className="btn btn-light !min-h-11 !px-4" disabled={respond.isPending} onClick={() => respond.mutate({ invitationId: invite.id, data: { decision: 'decline' } }, {
                onSuccess: () => { refresh(); toast.success('تم رفض الدعوة'); },
                onError: () => toast.error('تعذّر رفض الدعوة. أعد المحاولة.'),
              })}>رفض</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type CreatedHabitDetail = { habitId: number; title?: string };

export function PostHabitChallengePrompt() {
  const [habit, setHabit] = useState<CreatedHabitDetail | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const friends = useListSocialFriends({ query: { enabled: !!habit, queryKey: getListSocialFriendsQueryKey() } });
  const create = useCreateSocialChallenge();
  const invite = useInviteUsersToSocialChallenge();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  useEffect(() => {
    const handleCreated = (event: Event) => {
      const detail = (event as CustomEvent<CreatedHabitDetail>).detail;
      if (!detail || !Number.isInteger(detail.habitId) || detail.habitId <= 0) return;
      setHabit(detail);
      setTitle(detail.title?.trim() ? `رحلة ${detail.title.trim()} معًا` : '');
      setDescription('');
      setSelected([]);
    };
    window.addEventListener('habit-journey-created', handleCreated);
    return () => window.removeEventListener('habit-journey-created', handleCreated);
  }, []);

  const close = () => setHabit(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!habit) return;
    if (!selected.length) { toast.info('اختر صديقًا واحدًا على الأقل لإرسال الدعوة'); return; }
    try {
      const challenge = await create.mutateAsync({ data: {
        sourceHabitId: habit.habitId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      } });
      void qc.invalidateQueries({ queryKey: getListSocialChallengesQueryKey() });
      try {
        await invite.mutateAsync({ challengeId: challenge.id, data: { inviteeUserIds: selected } });
        toast.success('أُنشئت الرحلة المشتركة وأُرسلت الدعوات');
      } catch {
        toast.error('أُنشئت الرحلة، لكن تعذّر إرسال بعض الدعوات. يمكنك المحاولة من صفحة التحدي.');
      }
      void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
      close();
      navigate(`/challenges/${challenge.id}`);
    } catch {
      toast.error('تعذّر إنشاء الرحلة المشتركة. لم نرسل أي دعوات.');
    }
  };

  if (!habit) return null;
  return (
    <SocialModal title="هل تود خوضها مع أصدقاء؟" onClose={close}>
      <form className="space-y-4" onSubmit={submit}>
        <div className="rounded-2xl border border-[#cfdfce] bg-[#e6eee2] p-4 text-sm leading-7 text-[#245448]">
          <div className="mb-1 flex items-center gap-2 font-bold"><ShieldCheck size={17} /> رحلتك محفوظة كما هي</div>
          <p className="m-0">إنشاء دعوة اختيارك وحده. سيبدأ كل صديق رحلة شخصية مستقلة عند قبوله، ولن تُشارك تفاصيل عادتك الخاصة.</p>
        </div>
        <div className="space-y-3">
          <label className="block"><span className="mb-2 block text-sm font-bold">اسم التحدي (اختياري)</span><input className="field" maxLength={80} value={title} onChange={event => setTitle(event.target.value)} placeholder="رحلة جديدة معًا" /></label>
          <label className="block"><span className="mb-2 block text-sm font-bold">وصف قصير (اختياري)</span><textarea className="field min-h-20" maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="خطوات صغيرة، كلٌّ بطريقته." /></label>
        </div>
        <div><div className="mb-2 text-sm font-bold">اختر أصدقاء للدعوة</div><FriendCheckboxList friends={friends.data} selected={selected} onChange={setSelected} isLoading={friends.isLoading} isError={friends.isError} onRetry={() => friends.refetch()} /></div>
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-between">
          <button type="button" className="btn btn-light !min-h-11" onClick={close}>ليس الآن</button>
          <button type="submit" className="btn !min-h-11" disabled={create.isPending || invite.isPending || friends.isLoading || friends.isError || !friends.data?.length}>{create.isPending || invite.isPending ? 'نجهّز الدعوات…' : 'أنشئ التحدي وأرسل الدعوات'} <ArrowLeft size={16} /></button>
        </div>
      </form>
    </SocialModal>
  );
}