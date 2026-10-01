import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetSocialChallengeQueryKey,
  getListSocialChallengesQueryKey,
  getListSocialFriendsQueryKey,
  getListSocialNotificationsQueryKey,
  getListHabitsQueryKey,
  getGetSocialMeQueryKey,
  useCreateSocialChallenge,
  useGetSocialMe,
  useGetSocialChallenge,
  useInviteUsersToSocialChallenge,
  useLeaveSocialChallenge,
  useListHabits,
  useListSocialChallenges,
  useListSocialFriends,
  useRespondToSocialChallenge,
} from '@workspace/api-client-react';
import type { SocialChallengeDetail, SocialChallengeResponseDifficulty } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowLeft, Check, ShieldCheck, Users } from 'lucide-react';
import { CharacterAvatar } from '@/components/character/character-avatar';
import { AddButton, Empty, ErrorBlock, Field, Loading, PageHead, SectionTitle } from '@/components/journey-ui';
import { FriendCheckboxList, SocialModal } from '@/components/social/circles';

const challengeStatus: Record<string, string> = { invited: 'بانتظار قرارك', accepted: 'انضممت', declined: 'لم تنضم', left: 'غادرت' };
const unitName: Record<string, string> = { minutes: 'دقيقة', pages: 'صفحة', count: 'مرة', custom: 'وحدة' };

function initialTarget(challenge: SocialChallengeDetail) {
  return challenge.template.suggestedTargetValue;
}

function initialMinimum(challenge: SocialChallengeDetail) {
  return challenge.template.suggestedMinimumValue;
}

export function ChallengesPage() {
  const challenges = useListSocialChallenges();
  const habits = useListHabits();
  const friends = useListSocialFriends();
  const create = useCreateSocialChallenge();
  const invite = useInviteUsersToSocialChallenge();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [sourceHabitId, setSourceHabitId] = useState<number | ''>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedFriends, setSelectedFriends] = useState<string[]>([]);

  const reset = () => { setCreating(false); setSourceHabitId(''); setTitle(''); setDescription(''); setSelectedFriends([]); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceHabitId) { toast.info('اختر إحدى عاداتك الحالية لتكون أساس التحدي'); return; }
    try {
      const challenge = await create.mutateAsync({ data: {
        sourceHabitId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      } });
      void qc.invalidateQueries({ queryKey: getListSocialChallengesQueryKey() });
      void qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
      let inviteFailed = false;
      if (selectedFriends.length) {
        try {
          await invite.mutateAsync({ challengeId: challenge.id, data: { inviteeUserIds: selectedFriends } });
          void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
        } catch {
          inviteFailed = true;
        }
      }
      void qc.invalidateQueries({ queryKey: getGetSocialChallengeQueryKey(challenge.id) });
      void qc.invalidateQueries({ queryKey: getListSocialFriendsQueryKey() });
      reset();
      if (inviteFailed) toast.error('أُنشئ التحدي، لكن تعذّر إرسال بعض الدعوات. يمكنك المحاولة من صفحة التحدي.');
      else toast.success(selectedFriends.length ? 'أُنشئ التحدي وأُرسلت الدعوات' : 'أُنشئ التحدي الخاص بك');
      navigate(`/challenges/${challenge.id}`);
    } catch {
      toast.error('تعذّر إنشاء التحدي من هذه العادة. لم تُرسل أي دعوة.');
    }
  };

  return (
    <div dir="rtl">
      <PageHead
        overline="رحلتك أنت، على طريقتك"
        title="التحديات مع الأصدقاء"
        desc="تحدٍ خاص بدعوة. لكل شخص رحلة مستقلة، ولا تُشارك تفاصيل العادة أو خطتها الخاصة."
        action={<AddButton onClick={() => setCreating(true)} label="أنشئ تحديًا" />}
      />
      {challenges.isLoading ? <Loading /> : challenges.isError ? <ErrorBlock retry={() => challenges.refetch()} /> : !challenges.data?.length ? (
        <Empty title="لا توجد تحديات بعد" desc="أنشئ تحديًا من عادة تملكها، ثم اختر الأصدقاء الذين تريد دعوتهم." action={<AddButton onClick={() => setCreating(true)} label="أنشئ أول تحدٍ" />} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {challenges.data.map((challenge, index) => (
            <Link key={challenge.id} href={`/challenges/${challenge.id}`} className="paper rise rounded-[22px] p-5 transition-transform hover:-translate-y-1 sm:p-6" style={{ animationDelay: `${index * 45}ms` }}>
              <div className="mb-4 flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#e5ece0] text-[#285b48]"><Users size={23} /></span>
                <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${challenge.myStatus === 'invited' ? 'bg-[#f4e6cd] text-[#73552d]' : 'bg-[#e6eee2] text-[#245448]'}`}>{challengeStatus[challenge.myStatus] ?? 'تحدٍ خاص'}</span>
              </div>
              <h2 className="m-0 text-xl font-extrabold">{challenge.title}</h2>
              <p className="muted mt-2 min-h-12 text-sm leading-7">{challenge.description || `رحلة ${challenge.durationDays} يومًا مع ${challenge.creator.displayName}`}</p>
              <div className="mt-4 flex items-center justify-between border-t border-[#eee4d4] pt-4 text-sm"><span>{challenge.memberCount} مشاركين</span><span className="flex items-center gap-1 font-bold text-[#27614c]">عرض التحدي <ArrowLeft size={15} /></span></div>
            </Link>
          ))}
        </div>
      )}

      {creating && <SocialModal title="أنشئ تحديًا خاصًا" onClose={reset}>
        <form onSubmit={submit} className="space-y-1">
          <div className="mb-4 rounded-2xl border border-[#cfdfce] bg-[#e6eee2] p-4 text-sm leading-6 text-[#245448]"><div className="mb-1 flex items-center gap-2 font-bold"><ShieldCheck size={17} /> كل مشارك يبدأ عادته الخاصة</div>نستخدم من عادتك عنوانًا ومقترحًا آمنًا فقط. لا تُنسخ الإشارات أو العوائق أو المكافآت، ولا يبدأ أصدقاؤك رحلاتهم إلا بعد قبول الدعوة.</div>
          {habits.isLoading ? <div className="skeleton h-14" /> : habits.isError ? <div role="alert" className="mb-4 rounded-xl bg-[#fff7f2] p-3 text-sm">تعذّر تحميل عاداتك. <button type="button" className="min-h-11 underline" onClick={() => habits.refetch()}>أعد المحاولة</button></div> : !habits.data?.length ? <div className="mb-4 rounded-xl bg-[#f6f1e7] p-3 text-sm leading-6">لا توجد عادة حالية لتكون أساسًا للتحدي. أنشئ عادة أولًا ثم عُد إلى هنا.</div> : <>
            <Field label="عادة تملكها"><select className="field" required value={sourceHabitId} onChange={event => setSourceHabitId(event.target.value ? Number(event.target.value) : '')}><option value="">اختر عادة…</option>{habits.data.map(habit => <option key={habit.id} value={habit.id}>{habit.emoji} {habit.title}</option>)}</select></Field>
            <Field label="عنوان التحدي (اختياري)"><input className="field" maxLength={80} value={title} onChange={event => setTitle(event.target.value)} placeholder="تحدٍ لطيف لمدة 22 يومًا" /></Field>
            <Field label="وصف (اختياري)"><textarea className="field min-h-20" maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="كل شخص يختار بدايته المناسبة." /></Field>
          </>}
          <div className="mb-4"><div className="mb-2 text-sm font-bold">اختر أصدقاء لدعوتهم (اختياري)</div><FriendCheckboxList friends={friends.data} selected={selectedFriends} onChange={setSelectedFriends} isLoading={friends.isLoading} isError={friends.isError} onRetry={() => friends.refetch()} /></div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><button type="button" className="btn btn-light !min-h-11" onClick={reset}>إلغاء</button><button type="submit" className="btn !min-h-11" disabled={create.isPending || invite.isPending || habits.isLoading || habits.isError || !habits.data?.length || friends.isLoading || friends.isError}>{create.isPending || invite.isPending ? 'ننظّم التحدي…' : 'إنشاء التحدي وإرسال الدعوات'} <ArrowLeft size={16} /></button></div>
        </form>
      </SocialModal>}
    </div>
  );
}

export function ChallengeDetailPage() {
  const { challengeId } = useParams<{ challengeId: string }>();
  const id = Number(challengeId);
  const challenge = useGetSocialChallenge(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getGetSocialChallengeQueryKey(id) } });
  const respond = useRespondToSocialChallenge();
  const leave = useLeaveSocialChallenge();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [target, setTarget] = useState(0);
  const [minimum, setMinimum] = useState(0);
  const [cadence, setCadence] = useState<'daily' | 'weekdays' | 'weekly' | 'custom_days'>('daily');
  const [customDays, setCustomDays] = useState<number[]>([]);
  const [difficulty, setDifficulty] = useState<SocialChallengeResponseDifficulty>('easy');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedFriends, setSelectedFriends] = useState<string[]>([]);
  const friends = useListSocialFriends({ query: { enabled: inviteOpen, queryKey: getListSocialFriendsQueryKey() } });
  const me = useGetSocialMe({ query: { queryKey: getGetSocialMeQueryKey() } });
  const invite = useInviteUsersToSocialChallenge();
  const initializedInvitationId = useRef<number | null>(null);

  useEffect(() => {
    if (!challenge.data) return;
    if (challenge.data.myStatus !== 'invited') {
      initializedInvitationId.current = null;
      return;
    }
    if (initializedInvitationId.current === challenge.data.id) return;
    initializedInvitationId.current = challenge.data.id;
    setTarget(initialTarget(challenge.data));
    setMinimum(initialMinimum(challenge.data));
    setCadence(challenge.data.template.cadence);
    setCustomDays(challenge.data.template.customDays || []);
    setDifficulty(challenge.data.template.difficulty || 'easy');
  }, [challenge.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getGetSocialChallengeQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListSocialChallengesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
  };
  const refreshNotifications = () => {
    void qc.invalidateQueries({ queryKey: getListSocialNotificationsQueryKey() });
  };

  if (!Number.isInteger(id) || id <= 0) return <div dir="rtl"><ErrorBlock retry={() => navigate('/challenges')} /></div>;
  if (challenge.isLoading) return <div dir="rtl"><Loading /></div>;
  if (challenge.isError || !challenge.data) return <div dir="rtl"><ErrorBlock retry={() => challenge.refetch()} /></div>;
  const current = challenge.data;
  const invited = current.myStatus === 'invited';
  const accepted = current.myStatus === 'accepted';
  const template = current.template;
  const isCreator = me.data?.id === current.creator.id;
  const canInvite = isCreator && accepted;
  const submitResponse = (decision: 'accept' | 'decline') => {
    if (decision === 'accept') {
      if (!Number.isFinite(target) || !Number.isFinite(minimum) || target < 0 || minimum < 0 || (template.goalType === 'build' && (target <= 0 || minimum <= 0 || minimum > target))) {
        toast.error(template.goalType === 'build' ? 'اجعل الحد الأدنى موجبًا ولا يتجاوز هدفك.' : 'أدخل هدفًا وحدًا أدنى صالحين.');
        return;
      }
      if (cadence === 'custom_days' && !customDays.length) { toast.error('اختر يومًا واحدًا على الأقل'); return; }
    }
    respond.mutate({ challengeId: id, data: decision === 'accept' ? {
      decision,
      targetValue: target,
      minimumValue: minimum,
      difficulty,
      cadence,
      ...(cadence === 'custom_days' ? { customDays } : {}),
    } : { decision } }, {
      onSuccess: () => { refresh(); refreshNotifications(); toast.success(decision === 'accept' ? 'بدأت رحلتك الشخصية ضمن التحدي' : 'رفضت الدعوة'); },
      onError: error => toast.error(error instanceof Error ? error.message : 'تعذّر تحديث الدعوة. أعد المحاولة.'),
    });
  };
  const submitInvitations = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedFriends.length) { toast.info('اختر صديقًا واحدًا على الأقل'); return; }
    invite.mutate({ challengeId: id, data: { inviteeUserIds: selectedFriends } }, {
      onSuccess: () => {
        refresh();
        refreshNotifications();
        setInviteOpen(false);
        setSelectedFriends([]);
        toast.success('أُرسلت دعوات التحدي');
      },
      onError: error => toast.error(error instanceof Error && error.message !== 'Unknown error' ? error.message : 'تعذّر إرسال الدعوات. احتفظنا باختياراتك لتتمكن من المحاولة مجددًا.'),
    });
  };

  return (
    <div dir="rtl">
      <Link href="/challenges" className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm muted"><ArrowLeft size={16} /> العودة إلى التحديات</Link>
      <PageHead overline={invited ? 'دعوة خاصة وصلت إليك' : 'تحدٍ خاص لمدة 22 يومًا'} title={current.title} desc={current.description || `تحدٍ أنشأه ${current.creator.displayName}`} action={canInvite ? <button type="button" className="btn btn-light !min-h-11" onClick={() => setInviteOpen(true)}><Users size={17} /> دعوة أصدقاء</button> : undefined} />
      <div className="mb-6 rounded-2xl border border-[#d9e3d3] bg-[#e8efe4] p-4 text-sm leading-6 text-[#245448]"><div className="flex items-center gap-2 font-bold"><ShieldCheck size={18} /> رحلتك منفصلة وشخصية</div><p className="mb-0 mt-1">قبول الدعوة ينشئ عادة مملوكة لك وحدك. يمكنك تخصيص هدفك وإيقاعك؛ لن يرى المشاركون تفاصيل عادتك، بل تقدّمًا آمنًا ضمن التحدي فقط.</p></div>

      {invited && <section className="paper mb-6 rounded-[24px] p-5 sm:p-7">
        <SectionTitle label="لا يبدأ شيء دون موافقتك" title="اختر بدايتك الشخصية" />
        <p className="muted mb-5 text-sm leading-7">اقتراح مستوحى من عنوان العادة فقط: <strong>{template.title}</strong>. عدّل الأرقام والتكرار بما يناسبك قبل القبول.</p>
        <div className="grid gap-3 sm:grid-cols-2"><Field label={`هدفي (${unitName[template.unit] || template.unit})`}><input className="field" type="number" min={template.goalType === 'build' ? 1 : 0} value={Number.isFinite(target) ? target : ''} onChange={event => setTarget(Number(event.target.value))} /></Field><Field label={`الحد الأدنى (${unitName[template.unit] || template.unit})`}><input className="field" type="number" min={template.goalType === 'build' ? 1 : 0} value={Number.isFinite(minimum) ? minimum : ''} onChange={event => setMinimum(Number(event.target.value))} /></Field></div>
        <Field label="مستوى الصعوبة الذي تختاره لنفسك"><select className="field" value={difficulty} onChange={event => setDifficulty(event.target.value as SocialChallengeResponseDifficulty)}><option value="easy">سهلة</option><option value="medium">متوسطة</option><option value="hard">تحدٍ كبير</option></select></Field>
        <Field label="إيقاعك"><select className="field" value={cadence} onChange={event => setCadence(event.target.value as typeof cadence)}><option value="daily">كل يوم</option><option value="weekdays">أيام العمل</option><option value="weekly">مرة في الأسبوع</option><option value="custom_days">أيام أختارها</option></select></Field>
        {cadence === 'custom_days' && <div className="mb-4 flex flex-wrap gap-2">{['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'].map((day, index) => <button type="button" key={day} aria-pressed={customDays.includes(index)} className={`min-h-11 rounded-full border px-3 text-sm ${customDays.includes(index) ? 'border-[#3b765c] bg-[#245448] text-white' : 'border-[#e3d9c9] bg-[#f7f1e7]'}`} onClick={() => setCustomDays(days => days.includes(index) ? days.filter(item => item !== index) : [...days, index])}>{day}</button>)}</div>}
        <div className="flex flex-col-reverse gap-2 border-t border-[#eee4d4] pt-4 sm:flex-row sm:justify-between">
          <button type="button" className="btn btn-light !min-h-11" disabled={respond.isPending} onClick={() => submitResponse('decline')}>رفض الدعوة</button>
          <button type="button" className="btn !min-h-11" disabled={respond.isPending} onClick={() => submitResponse('accept')}>{respond.isPending ? 'نجهّز رحلتك…' : 'اقبل وابدأ رحلتي الشخصية'} <Check size={17} /></button>
        </div>
      </section>}

      {accepted && <section className="paper mb-6 rounded-[24px] p-5 sm:p-7">
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><SectionTitle label="كل شخص يتقدم بطريقته" title="تقدّم المشاركين" /><button type="button" className="btn btn-light !min-h-11" disabled={leave.isPending} onClick={() => {
          if (!window.confirm('هل تريد مغادرة التحدي؟ ستبقى عادتك الشخصية ورحلتك كما هما.')) return;
          leave.mutate({ challengeId: id }, { onSuccess: () => { refresh(); toast.success('غادرت التحدي؛ عادتك الشخصية لم تتغير'); navigate('/challenges'); }, onError: () => toast.error('تعذّر مغادرة التحدي. أعد المحاولة.') });
        }}>مغادرة التحدي</button></div>
        <div className="space-y-3">
          {current.members.filter(member => member.status === 'accepted').map(member => {
            const day = Math.max(0, Math.min(22, member.progressDay ?? 0));
            const sharedCharacter = member.character?.length ? member.character.map((item, index) => ({ ...item, id: index + 1, coinCost: 0, owned: true, equipped: true })) : null;
            return <div key={member.user.id} className="rounded-2xl border border-[#eee4d4] p-4">
              <div className="flex items-center gap-3">{sharedCharacter ? <CharacterAvatar items={sharedCharacter} height={48} className="rounded-full bg-[#e5ece0]" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e5ece0] text-lg">{member.user.avatarEmoji || <Users size={20} />}</span>}<div className="min-w-0 flex-1"><strong>{member.user.displayName}</strong><div className="muted text-xs">{member.completed ? 'أكمل رحلته' : 'رحلة شخصية مستقلة'}</div>{member.consistencyPercentage != null && <div className="muted mt-1 text-xs">الاستمرارية: {Math.round(member.consistencyPercentage)}٪ من الأيام المجدولة</div>}</div><bdi dir="ltr" className="shrink-0 text-sm font-bold text-[#27614c]">{day} / 22</bdi></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e3d9c9]" aria-label={`التقدّم ${day} من 22 يومًا`}><div className="h-full rounded-full bg-[#468065]" style={{ width: `${day / 22 * 100}%` }} /></div>
            </div>;
          })}
          {!current.members.some(member => member.status === 'accepted') && <p className="muted">سيظهر تقدّم المشاركين بعد قبولهم الدعوة.</p>}
        </div>
      </section>}

      {!accepted && current.myStatus !== 'invited' && <section className="paper mb-6 rounded-[24px] p-5 sm:p-7"><div className="mb-2 eyebrow">حالة التحدي</div><h2 className="m-0 text-xl font-extrabold">{challengeStatus[current.myStatus] || 'غير نشط'}</h2><p className="muted mb-0 mt-2 text-sm">لا تظهر بيانات التقدّم لأنك لست مشاركًا مقبولًا في هذا التحدي.</p></section>}

      <section className="paper rounded-[24px] p-5 sm:p-7">
        <SectionTitle label="المعلومات الآمنة فقط" title="عن التحدي" />
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl bg-[#f6f1e7] p-3"><span className="muted">أنشأه</span><div className="mt-1 font-bold">{current.creator.displayName}</div></div>
          <div className="rounded-xl bg-[#f6f1e7] p-3"><span className="muted">المدة</span><div className="mt-1 font-bold">22 يومًا</div></div>
        </div>
        <p className="muted mb-0 mt-4 text-xs leading-6">لا تتضمن المشاركات إشارات التذكير أو العوائق أو المكافآت أو تفاصيل الأيام غير المكتملة.</p>
      </section>

      {inviteOpen && canInvite && <SocialModal title="ادعُ أصدقاء إلى التحدي" onClose={() => { setInviteOpen(false); setSelectedFriends([]); }}>
        <form onSubmit={submitInvitations} className="space-y-4">
          <p className="rounded-xl bg-[#e6eee2] p-3 text-sm leading-6 text-[#245448]">الدعوة اختيارية، ويبدأ كل صديق رحلته الشخصية بعد القبول فقط. لن تُشارك تفاصيل عادتك.</p>
          <FriendCheckboxList friends={friends.data} selected={selectedFriends} onChange={setSelectedFriends} isLoading={friends.isLoading} isError={friends.isError} onRetry={() => friends.refetch()} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><button type="button" className="btn btn-light !min-h-11" onClick={() => { setInviteOpen(false); setSelectedFriends([]); }}>إلغاء</button><button type="submit" className="btn !min-h-11" disabled={invite.isPending || friends.isLoading || friends.isError || !friends.data?.length || !selectedFriends.length}>{invite.isPending ? 'جارٍ إرسال الدعوات…' : 'إرسال الدعوات'}</button></div>
        </form>
      </SocialModal>}
    </div>
  );
}