import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetSocialGroupQueryKey,
  getGetSocialGroupCoverQueryKey,
  getListIncomingSocialGroupInvitationsQueryKey,
  getListMySocialGroupJourneySharesQueryKey,
  getListSocialGroupActivityQueryKey,
  getListSocialGroupEncouragementsQueryKey,
  getListSocialGroupsQueryKey,
  getListSocialFriendsQueryKey,
  getListSocialNotificationsQueryKey,
  getListHabitsQueryKey,
  useCreateSocialGroup,
  useCreateSocialGroupEncouragement,
  useGetSocialGroup,
  useGetSocialGroupCover,
  useInviteUsersToSocialGroup,
  useLeaveSocialGroup,
  useListHabits,
  useListMySocialGroupJourneyShares,
  useListSocialGroupActivity,
  useListSocialGroupEncouragements,
  useListSocialGroups,
  useListSocialFriends,
  useRevokeMySocialGroupJourneyShare,
  useShareMyJourneyWithSocialGroup,
  useUpdateSocialGroupCover,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowLeft, ImagePlus, LockKeyhole, MessageCircle, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { usePhotoUpload } from '@/hooks/use-photo-upload';
import { AddButton, Empty, ErrorBlock, Field, Loading, PageHead, SectionTitle } from '@/components/journey-ui';
import { FriendCheckboxList, SocialGroupInvitationInbox, SocialModal } from '@/components/social/circles';

const errorText = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message && error.message !== 'Unknown error') return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
};

const httpStatus = (error: unknown) => (
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined
);

const templates = [
  ['nice_work', 'عمل جميل'],
  ['keep_going', 'واصل التقدّم'],
  ['great_job', 'أحسنت'],
  ['you_got_this', 'أنت قادر'],
  ['keep_moving', 'خطوة أخرى'],
] as const;

export function GroupsPage() {
  const groups = useListSocialGroups();
  const friends = useListSocialFriends();
  const create = useCreateSocialGroup();
  const invite = useInviteUsersToSocialGroup();
  const updateCover = useUpdateSocialGroupCover();
  const { uploadPhoto } = usePhotoUpload();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState('');
  const [maxMembers, setMaxMembers] = useState(10);
  const [friendsSelected, setFriendsSelected] = useState<string[]>([]);
  const [coverFile, setCoverFile] = useState<File | null>(null);

  const resetCreate = () => {
    setCreating(false);
    setName('');
    setDescription('');
    setGoal('');
    setMaxMembers(10);
    setFriendsSelected([]);
    setCoverFile(null);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListSocialGroupsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListIncomingSocialGroupInvitationsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListSocialFriendsQueryKey() });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !goal.trim()) return;
    try {
      const group = await create.mutateAsync({ data: {
        name: name.trim(),
        goalDescription: goal.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        maxMembers,
      } });
      refresh();
      let coverFailed = false;
      let inviteFailed = false;
      if (coverFile) {
        try {
          const imageObjectPath = await uploadPhoto(coverFile);
          await updateCover.mutateAsync({ groupId: group.id, data: { imageObjectPath } });
        } catch {
          coverFailed = true;
        }
      }
      if (friendsSelected.length) {
        try {
          await invite.mutateAsync({ groupId: group.id, data: { inviteeUserIds: friendsSelected } });
          void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
        } catch {
          inviteFailed = true;
        }
      }
      resetCreate();
      void qc.invalidateQueries({ queryKey: getGetSocialGroupQueryKey(group.id) });
      void qc.invalidateQueries({ queryKey: getGetSocialGroupCoverQueryKey(group.id) });
      if (coverFailed) toast.error('أُنشئت المجموعة، لكن تعذّر حفظ صورة الغلاف. يمكنك رفعها من صفحة المجموعة.');
      if (inviteFailed) toast.error('أُنشئت المجموعة، لكن تعذّر إرسال بعض الدعوات. يمكنك المحاولة من صفحة المجموعة.');
      if (!coverFailed && !inviteFailed) toast.success('أُنشئت مجموعتك الخاصة');
      navigate(`/groups/${group.id}`);
    } catch (error) {
      toast.error(errorText(error, 'تعذّر إنشاء المجموعة. أعد المحاولة.'));
    }
  };

  return (
    <div dir="rtl">
      <PageHead
        overline="الرفقة باختيارك"
        title="مجموعاتك الخاصة"
        desc="مساحة صغيرة لأصدقاء تدعوهم بنفسك. الانضمام لا يشارك عاداتك أو تفاصيل رحلتك."
        action={<AddButton onClick={() => setCreating(true)} label="أنشئ مجموعة" />}
      />
      <SocialGroupInvitationInbox onAccepted={id => navigate(`/groups/${id}`)} />
      {groups.isLoading ? <Loading /> : groups.isError ? <ErrorBlock retry={() => groups.refetch()} /> : !groups.data?.length ? (
        <Empty title="لا توجد مجموعات بعد" desc="أنشئ مساحة خاصة وادعُ أصدقاءك المقبولين. لن تُشارك أي عادة إلا باختيارك." action={<AddButton onClick={() => setCreating(true)} label="أنشئ أول مجموعة" />} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.data.map((group, index) => (
            <Link key={group.id} href={`/groups/${group.id}`} className="paper rise overflow-hidden rounded-[22px] transition-transform hover:-translate-y-1" style={{ animationDelay: `${index * 50}ms` }}>
              <div className="flex min-h-[135px] items-center justify-center bg-[#e5ece0] text-[#285b48]">
                {group.coverUrl ? <div className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole size={18} /> صورة غلاف خاصة بالأعضاء</div> : <Users size={37} />}
              </div>
              <div className="p-5 sm:p-6">
                <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="m-0 text-xl font-extrabold">{group.name}</h2>{group.role === 'owner' && <span className="rounded-full bg-[#f4e6cd] px-2.5 py-1 text-xs font-bold">المالك</span>}</div>
                <p className="muted mt-2 min-h-12 text-sm leading-7">{group.description || group.goalDescription}</p>
                <div className="mt-4 flex items-center justify-between border-t border-[#eee4d4] pt-4 text-sm">
                  <span>{group.memberCount} من {group.maxMembers} أعضاء</span>
                  <span className="flex items-center gap-1 font-bold text-[#27614c]">عرض المجموعة <ArrowLeft size={15} /></span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating && <SocialModal title="أنشئ مجموعة خاصة" onClose={resetCreate}>
        <form onSubmit={submit} className="space-y-1">
          <p className="mb-4 rounded-xl bg-[#e6eee2] p-3 text-sm leading-6 text-[#245448]">المجموعة بدعوة فقط. لن تنشئ رمز انضمام عامًا، ولن يرى الأعضاء عاداتك إلا إذا شاركتها معهم لاحقًا.</p>
          <Field label="اسم المجموعة"><input className="field" required minLength={1} maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="رفاق الخطوات الصغيرة" /></Field>
          <Field label="ما الهدف الذي يجمعكم؟"><textarea className="field min-h-20" required maxLength={250} value={goal} onChange={event => setGoal(event.target.value)} placeholder="هدف لطيف نتقدم إليه معًا" /></Field>
          <Field label="وصف إضافي (اختياري)"><textarea className="field min-h-20" maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="مساحة آمنة للتشجيع المتبادل" /></Field>
          <Field label="الحد الأقصى للأعضاء"><input className="field" type="number" min={2} max={30} required value={maxMembers} onChange={event => setMaxMembers(Number(event.target.value))} /></Field>
          <Field label="صورة غلاف خاصة (اختياري)"><input className="field !h-auto !py-2.5" type="file" accept="image/*" onChange={event => setCoverFile(event.target.files?.[0] ?? null)} /><span className="mt-1 block text-xs muted">{coverFile ? coverFile.name : 'تُرفع الصورة إلى مساحة التخزين الخاصة بعد إنشاء المجموعة.'}</span></Field>
          <div className="mb-4"><div className="mb-2 text-sm font-bold">ادعُ أصدقاء مقبولين (اختياري)</div><FriendCheckboxList friends={friends.data} selected={friendsSelected} onChange={setFriendsSelected} isLoading={friends.isLoading} isError={friends.isError} onRetry={() => friends.refetch()} /></div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button type="button" className="btn btn-light !min-h-11" onClick={resetCreate}>إلغاء</button>
            <button type="submit" className="btn !min-h-11" disabled={create.isPending || invite.isPending || updateCover.isPending || maxMembers < 2 || maxMembers > 30 || friends.isLoading || friends.isError}>{create.isPending || invite.isPending || updateCover.isPending ? 'ننشئ مجموعتك…' : 'إنشاء المجموعة'} <ArrowLeft size={16} /></button>
          </div>
        </form>
      </SocialModal>}
    </div>
  );
}

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const id = Number(groupId);
  const [coverBlocked, setCoverBlocked] = useState(false);
  const blockedCoverUrl = useRef<string | null>(null);
  const group = useGetSocialGroup(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getGetSocialGroupQueryKey(id) } });
  const cover = useGetSocialGroupCover(id, { query: { enabled: Number.isInteger(id) && id > 0 && !group.isError && !group.isFetching && !coverBlocked && !!group.data?.coverUrl, queryKey: getGetSocialGroupCoverQueryKey(id) } });
  const activity = useListSocialGroupActivity(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getListSocialGroupActivityQueryKey(id) } });
  const shares = useListMySocialGroupJourneyShares(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getListMySocialGroupJourneySharesQueryKey(id) } });
  const encouragements = useListSocialGroupEncouragements(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getListSocialGroupEncouragementsQueryKey(id) } });
  const habits = useListHabits();
  const friends = useListSocialFriends();
  const invite = useInviteUsersToSocialGroup();
  const leave = useLeaveSocialGroup();
  const share = useShareMyJourneyWithSocialGroup();
  const revoke = useRevokeMySocialGroupJourneyShare();
  const cheer = useCreateSocialGroupEncouragement();
  const updateCover = useUpdateSocialGroupCover();
  const { uploadPhoto } = usePhotoUpload();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [coverObjectUrl, setCoverObjectUrl] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedFriends, setSelectedFriends] = useState<string[]>([]);
  const [selectedHabit, setSelectedHabit] = useState<number | ''>('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [recipient, setRecipient] = useState('');
  const [template, setTemplate] = useState<(typeof templates)[number][0]>('nice_work');
  const [message, setMessage] = useState('');

  const coverStatus = httpStatus(cover.error);
  const coverAccessDenied = coverStatus === 403 || coverStatus === 404;

  useEffect(() => {
    blockedCoverUrl.current = null;
    setCoverBlocked(false);
  }, [id]);

  useEffect(() => {
    if (!group.data?.coverUrl || group.isError || group.isFetching || cover.isError || coverBlocked || !cover.data) {
      setCoverObjectUrl('');
      return;
    }
    const url = URL.createObjectURL(cover.data);
    setCoverObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cover.data, group.data?.coverUrl, group.isError, group.isFetching, cover.isError, coverBlocked]);

  useEffect(() => {
    if (group.isError || !group.data?.coverUrl || coverAccessDenied) {
      if (coverAccessDenied) {
        blockedCoverUrl.current = group.data?.coverUrl ?? null;
        setCoverBlocked(true);
      } else if (group.isError) {
        blockedCoverUrl.current = null;
        setCoverBlocked(true);
      } else {
        blockedCoverUrl.current = null;
        setCoverBlocked(false);
      }
      void qc.cancelQueries({ queryKey: getGetSocialGroupCoverQueryKey(id), exact: true });
      qc.removeQueries({ queryKey: getGetSocialGroupCoverQueryKey(id), exact: true });
    } else if (group.data.coverUrl !== blockedCoverUrl.current) {
      blockedCoverUrl.current = null;
      setCoverBlocked(false);
    }
  }, [id, group.isError, group.data?.coverUrl, coverAccessDenied, qc]);

  const sharedHabitIds = useMemo(() => new Set((shares.data || []).map(item => item.journey.journeyId)), [shares.data]);
  const refreshGroup = () => {
    void qc.invalidateQueries({ queryKey: getGetSocialGroupQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getGetSocialGroupCoverQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListMySocialGroupJourneySharesQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListSocialGroupActivityQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListSocialGroupEncouragementsQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListSocialGroupsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
  };
  const refreshNotifications = () => {
    void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
  };
  const clearCoverCache = () => {
    setCoverObjectUrl('');
    blockedCoverUrl.current = group.data?.coverUrl ?? null;
    setCoverBlocked(true);
    void qc.cancelQueries({ queryKey: getGetSocialGroupCoverQueryKey(id), exact: true });
    qc.removeQueries({ queryKey: getGetSocialGroupCoverQueryKey(id), exact: true });
  };

  if (!Number.isInteger(id) || id <= 0) return <div dir="rtl"><ErrorBlock retry={() => navigate('/groups')} /></div>;
  if (group.isLoading) return <div dir="rtl"><Loading /></div>;
  if (group.isError || !group.data) return <div dir="rtl"><ErrorBlock retry={() => group.refetch()} /></div>;
  const current = group.data;

  const submitInvitations = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedFriends.length) { toast.info('اختر صديقًا واحدًا على الأقل'); return; }
    invite.mutate({ groupId: id, data: { inviteeUserIds: selectedFriends } }, {
      onSuccess: () => { refreshGroup(); refreshNotifications(); setInviteOpen(false); setSelectedFriends([]); toast.success('أُرسلت دعوات المجموعة'); },
      onError: error => toast.error(errorText(error, 'تعذّر إرسال الدعوات. قد تكون المجموعة بلغت حد الأعضاء.')),
    });
  };

  const saveCover = async (event: FormEvent) => {
    event.preventDefault();
    if (!coverFile) { toast.info('اختر صورة أولًا'); return; }
    try {
      const imageObjectPath = await uploadPhoto(coverFile);
      await updateCover.mutateAsync({ groupId: id, data: { imageObjectPath } });
      setCoverFile(null);
      blockedCoverUrl.current = null;
      setCoverBlocked(false);
      refreshGroup();
      toast.success('حُفظ غلاف المجموعة الخاص');
    } catch (error) {
      toast.error(errorText(error, 'تعذّر رفع الصورة أو حفظها. أعد المحاولة.'));
    }
  };

  const deleteCover = () => updateCover.mutate({ groupId: id, data: { imageObjectPath: null } }, {
    onSuccess: () => { clearCoverCache(); refreshGroup(); setCoverFile(null); toast.success('أزيل غلاف المجموعة'); },
    onError: error => toast.error(errorText(error, 'تعذّر إزالة الغلاف. أعد المحاولة.')),
  });

  const sendCheer = (event: FormEvent) => {
    event.preventDefault();
    const data = {
      ...(recipient ? { receiverUserId: recipient } : {}),
      template,
      ...(message.trim() ? { message: message.trim() } : {}),
      requestId: crypto.randomUUID(),
    };
    cheer.mutate({ groupId: id, data }, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListSocialGroupEncouragementsQueryKey(id) });
        refreshNotifications();
        setMessage('');
        toast.success('وصلت كلماتك الطيبة');
      },
      onError: error => toast.error(errorText(error, 'تعذّر إرسال التشجيع. أعد المحاولة بعد قليل.')),
    });
  };

  return (
    <div dir="rtl">
      <Link href="/groups" className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm muted"><ArrowLeft size={16} /> العودة إلى المجموعات</Link>
      <PageHead
        overline={current.role === 'owner' ? 'مجموعتك الخاصة' : 'مساحة بدعوة'}
        title={current.name}
        desc={current.description || current.goalDescription}
        action={<div className="flex flex-wrap gap-2"><button type="button" className="btn btn-light !min-h-11" onClick={() => setInviteOpen(true)}><Plus size={16} /> دعوة أصدقاء</button><button type="button" className="btn btn-light !min-h-11" disabled={leave.isPending} onClick={() => {
          if (!window.confirm('هل تريد مغادرة هذه المجموعة؟ لن يتغير أي شيء في عاداتك الخاصة.')) return;
          leave.mutate({ groupId: id }, { onSuccess: () => { clearCoverCache(); refreshGroup(); toast.success('غادرت المجموعة'); navigate('/groups'); }, onError: error => toast.error(errorText(error, 'تعذّر مغادرة المجموعة. أعد المحاولة.')) });
        }}><ArrowLeft size={16} /> مغادرة المجموعة</button></div>}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-[#d9e3d3] bg-[#e8efe4] p-4 text-sm leading-6 text-[#245448]">
        <ShieldCheck size={20} className="shrink-0" /><span>العضوية لا تشارك عاداتك. لا تظهر هنا إلا الرحلات التي اخترت مشاركتها صراحةً مع هذه المجموعة.</span>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.72fr)]">
        <main className="space-y-5">
          <section className="paper overflow-hidden rounded-[24px]">
            <div className="relative flex min-h-44 items-center justify-center bg-[#e5ece0]">
              {current.coverUrl && coverObjectUrl && !cover.isError && !coverBlocked && !group.isError && !group.isFetching ? <img src={coverObjectUrl} alt={`غلاف خاص بمجموعة ${current.name}`} className="absolute inset-0 h-full w-full object-cover" /> : current.coverUrl && !coverAccessDenied && !coverBlocked && !group.isError ? <div className="relative flex items-center gap-2 rounded-full bg-white/85 px-4 py-2 text-sm font-semibold"><LockKeyhole size={16} /> جارٍ تحميل الغلاف الخاص</div> : <div className="text-center text-[#285b48]"><ImagePlus size={32} className="mx-auto mb-2" /><span className="text-sm font-semibold">{coverAccessDenied || coverBlocked ? 'لم يعد الغلاف الخاص متاحًا' : 'مساحة خاصة بأعضاء المجموعة'}</span></div>}
              {cover.isError && !coverAccessDenied && <button type="button" className="relative rounded-full bg-white/90 px-4 py-2 text-sm underline" onClick={() => cover.refetch()}>تعذّر تحميل الغلاف. أعد المحاولة</button>}
            </div>
            {current.role === 'owner' && <form onSubmit={saveCover} className="flex flex-col gap-3 border-t border-[#eee4d4] p-4 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1"><span className="mb-2 block text-sm font-bold">تحديث صورة الغلاف الخاصة</span><input className="field !h-auto !py-2.5" type="file" accept="image/*" onChange={event => setCoverFile(event.target.files?.[0] ?? null)} /></label>
              <div className="flex gap-2"><button type="submit" className="btn !min-h-11" disabled={!coverFile || updateCover.isPending}>{updateCover.isPending ? 'جارٍ الحفظ…' : 'حفظ الصورة'}</button>{current.coverUrl && <button type="button" className="btn btn-light !min-h-11 !px-3" disabled={updateCover.isPending} aria-label="حذف صورة الغلاف" onClick={deleteCover}><Trash2 size={17} /></button>}</div>
            </form>}
          </section>

          <section className="paper rounded-[24px] p-5 sm:p-7">
            <SectionTitle label="الموافقة بيدك دائمًا" title="رحلاتك المشتركة" />
            {habits.isLoading || shares.isLoading ? <div className="skeleton h-20" /> : habits.isError || shares.isError ? <div role="alert" className="rounded-xl bg-[#fff7f2] p-4 text-sm">تعذّر تحميل اختيارات المشاركة. <button type="button" className="min-h-11 underline" onClick={() => { habits.refetch(); shares.refetch(); }}>أعد المحاولة</button></div> : (
              <>
                {shares.data?.length ? <div className="mb-4 space-y-2">{shares.data.map(item => <div key={item.journey.journeyId} className="flex flex-col gap-3 rounded-xl border border-[#dce5d6] bg-[#f5f8f1] p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1"><strong>{item.journey.emoji} {item.journey.title}</strong><p className="muted mb-0 mt-1 text-xs">مشاركة اختيارية مع هذه المجموعة فقط · {item.journey.successfulDayCount} يومًا ناجحًا من {item.journey.progressDay} يومًا منقضيًا</p></div>
                  <button type="button" className="btn btn-light !min-h-11 !px-3" disabled={revoke.isPending} onClick={() => revoke.mutate({ groupId: id, journeyId: item.journey.journeyId }, { onSuccess: () => { refreshGroup(); toast.success('أوقفت مشاركة هذه الرحلة'); }, onError: error => toast.error(errorText(error, 'تعذّر إيقاف المشاركة.')) })}>إيقاف المشاركة</button>
                </div>)}</div> : <p className="muted rounded-xl bg-[#f6f1e7] p-4 text-sm leading-6">لم تختر مشاركة أي رحلة بعد. لن يرى الأعضاء أي تقدّم شخصي قبل اختيارك هنا.</p>}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select className="field min-w-0 flex-1" aria-label="اختر رحلة شخصية لمشاركتها" value={selectedHabit} onChange={event => setSelectedHabit(event.target.value ? Number(event.target.value) : '')}>
                    <option value="">اختر من عاداتك الحالية…</option>
                    {(habits.data || []).filter(habit => !sharedHabitIds.has(habit.id)).map(habit => <option key={habit.id} value={habit.id}>{habit.emoji} {habit.title}</option>)}
                  </select>
                  <button type="button" className="btn !min-h-11" disabled={!selectedHabit || share.isPending} onClick={() => {
                    if (!selectedHabit) return;
                    share.mutate({ groupId: id, data: { journeyId: selectedHabit } }, { onSuccess: () => { setSelectedHabit(''); refreshGroup(); toast.success('شاركت تقدّم هذه الرحلة مع المجموعة'); }, onError: error => toast.error(errorText(error, 'تعذّر مشاركة الرحلة.')) });
                  }}>مشاركة باختياري</button>
                </div>
                {!habits.data?.length && <p className="muted mb-0 mt-2 text-xs">لا توجد عادات للاختيار الآن.</p>}
              </>
            )}
          </section>

          <section className="paper rounded-[24px] p-5 sm:p-7">
            <SectionTitle label="لا ترتيب ولا مقارنة" title="الأعضاء وتقدّمهم المختار" />
            {current.members.length ? <div className="space-y-3">{current.members.map(member => (
              <div key={member.user.id} className="rounded-2xl border border-[#eee4d4] p-4">
                <div className="flex items-center gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#e5ece0] text-xl">{member.user.avatarEmoji}</span><div className="min-w-0 flex-1"><strong>{member.user.displayName}</strong><div className="muted text-xs">{member.role === 'owner' ? 'مالك المجموعة' : 'عضو'}</div></div></div>
                {member.sharedJourneys.length > 0 ? <div className="mt-3 space-y-2 border-t border-[#eee4d4] pt-3">{member.sharedJourneys.map(journey => <div key={journey.journeyId} className="rounded-xl bg-[#f6f1e7] p-3">
                  <div className="flex items-center justify-between gap-3"><strong className="truncate text-sm">{journey.emoji} {journey.title}</strong><span className="shrink-0 text-xs font-bold text-[#27614c]">{journey.progressDay} / 22 يومًا</span></div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e3d9c9]" aria-label={`التقدّم ${journey.progressDay} من 22 يومًا`}><div className="h-full rounded-full bg-[#468065]" style={{ width: `${Math.max(0, Math.min(100, journey.progressDay / 22 * 100))}%` }} /></div>
                  <p className="muted mb-0 mt-2 text-xs">{journey.successfulDayCount} أيام نجاح من الأيام المنقضية{journey.completed ? ' · اكتملت الرحلة' : ''}</p>
                </div>)}</div> : <p className="muted mb-0 mt-3 border-t border-[#eee4d4] pt-3 text-xs">لم يشارك هذا العضو رحلة مع المجموعة.</p>}
              </div>
            ))}</div> : <p className="muted">لا يوجد أعضاء لعرضهم.</p>}
          </section>

          <section className="paper rounded-[24px] p-5 sm:p-7">
            <SectionTitle label="الخطوات الإيجابية فقط" title="أخبار المجموعة" />
            {activity.data && <div className="mb-4 rounded-xl bg-[#e8efe4] p-3 text-sm" data-testid="group-today-summary">
              <strong>النشاط المشترك اليوم: </strong>
              {new Set(activity.data.filter(item => item.eventType !== 'member_joined' && item.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).map(item => item.actor.id)).size} أعضاء لديهم خطوات إيجابية ضمن آخر النشاطات.
              <span className="mt-1 block text-xs muted">بحسب تاريخ النشاط بتوقيت UTC، وللرحلات التي اختار أصحابها مشاركتها فقط.</span>
            </div>}
            {activity.isLoading ? <div className="skeleton h-20" /> : activity.isError ? <div role="alert" className="text-sm">تعذّر تحميل النشاط. <button type="button" className="min-h-11 underline" onClick={() => activity.refetch()}>أعد المحاولة</button></div> : activity.data?.length ? <div className="space-y-2">{activity.data.map(item => <div key={item.id} className="flex gap-3 rounded-xl bg-[#f6f1e7] p-3 text-sm leading-6"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-lg">{item.actor.avatarEmoji}</span><div><strong>{item.actor.displayName}</strong><span>{item.eventType === 'member_joined' ? ' انضم إلى المجموعة' : item.eventType === 'journey_completed' ? ' أكمل رحلة' : item.eventType === 'milestone' ? ' وصل إلى محطة في' : ' أتمّ يومًا ناجحًا في'}{item.journey ? ` «${item.journey.title}»` : ''}</span>{item.progressDay != null && item.eventType !== 'member_joined' && <span className="block text-xs muted">اليوم {item.progressDay} من 22</span>}</div></div>)}</div> : <p className="muted text-sm">ستظهر هنا الخطوات الإيجابية للرحلات التي اختار أصحابها مشاركتها.</p>}
          </section>
        </main>

        <aside className="space-y-5">
          <section className="rounded-[22px] bg-[#214e43] p-5 text-[#fff9e9] sm:p-6">
            <div className="flex items-center gap-2 text-lg font-extrabold"><MessageCircle size={20} /> كلمة طيبة</div>
            <p className="mt-2 text-sm leading-6 text-[#d8e5d8]">اختر عبارة قصيرة للمجموعة أو لعضو. قد يحدّ النظام من التكرار لحماية راحة الجميع.</p>
            <form onSubmit={sendCheer} className="mt-4 space-y-3">
              <label className="block"><span className="mb-1 block text-xs font-bold text-[#d8e5d8]">إلى</span><select className="field" value={recipient} onChange={event => setRecipient(event.target.value)}><option value="">كل المجموعة</option>{current.members.map(member => <option key={member.user.id} value={member.user.id}>{member.user.displayName}</option>)}</select></label>
              <label className="block"><span className="mb-1 block text-xs font-bold text-[#d8e5d8]">عبارة التشجيع</span><select className="field" value={template} onChange={event => setTemplate(event.target.value as typeof template)}>{templates.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="block"><span className="mb-1 block text-xs font-bold text-[#d8e5d8]">رسالة قصيرة اختيارية</span><textarea className="field min-h-20" maxLength={120} value={message} onChange={event => setMessage(event.target.value)} placeholder="خطواتك الصغيرة تستحق التقدير." /><span className="mt-1 block text-left text-xs text-[#d8e5d8]" dir="ltr">{message.length}/120</span></label>
              <button type="submit" className="btn w-full !min-h-11 !bg-[#e5b37b] !border-[#e5b37b] !text-[#214e43]" disabled={cheer.isPending}>{cheer.isPending ? 'جارٍ الإرسال…' : 'أرسل التشجيع'}</button>
            </form>
          </section>
          <section className="paper rounded-[22px] p-5 sm:p-6">
            <SectionTitle label="كلمات بين الأصدقاء" title="التشجيع الأخير" />
            {encouragements.isLoading ? <div className="skeleton h-20" /> : encouragements.isError ? <div role="alert" className="text-sm">تعذّر تحميل التشجيع. <button type="button" className="min-h-11 underline" onClick={() => encouragements.refetch()}>أعد المحاولة</button></div> : encouragements.data?.length ? <div className="space-y-3">{encouragements.data.slice(-8).reverse().map(item => <div key={item.id} className="border-b border-[#eee6d9] pb-3 text-sm last:border-0"><strong>{item.sender.displayName}</strong><span> إلى {item.receiver?.displayName || 'المجموعة'}: {templates.find(([key]) => key === item.template)?.[1] || 'تشجيع'}</span>{item.message && <p className="mb-0 mt-1 leading-6 muted">{item.message}</p>}</div>)}</div> : <p className="muted text-sm">كن أول من يرسل كلمة تشجيع.</p>}
          </section>
          <div className="rounded-2xl border border-[#e2dacb] bg-[#f8f3e9] p-4 text-xs leading-6 muted">المجموعات بدعوة فقط. لا توجد رموز انضمام أو لوحة متصدرين، ولا يتحول التشجيع إلى نقاط أو مكافآت.</div>
        </aside>
      </div>

      {inviteOpen && <SocialModal title="ادعُ أصدقاء مقبولين" onClose={() => { setInviteOpen(false); setSelectedFriends([]); }}>
        <form onSubmit={submitInvitations} className="space-y-4">
          <p className="rounded-xl bg-[#e6eee2] p-3 text-sm leading-6 text-[#245448]">ستُرسل الدعوة إلى أصدقائك المقبولين فقط. العدد المتاح للمجموعة {Math.max(0, current.maxMembers - current.memberCount)} من أصل {current.maxMembers}.</p>
          <FriendCheckboxList friends={friends.data} selected={selectedFriends} onChange={setSelectedFriends} isLoading={friends.isLoading} isError={friends.isError} onRetry={() => friends.refetch()} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><button type="button" className="btn btn-light !min-h-11" onClick={() => { setInviteOpen(false); setSelectedFriends([]); }}>إلغاء</button><button type="submit" className="btn !min-h-11" disabled={invite.isPending || friends.isLoading || friends.isError || !friends.data?.length || current.memberCount >= current.maxMembers}>{invite.isPending ? 'جارٍ الإرسال…' : 'إرسال الدعوات'}</button></div>
        </form>
      </SocialModal>}
    </div>
  );
}