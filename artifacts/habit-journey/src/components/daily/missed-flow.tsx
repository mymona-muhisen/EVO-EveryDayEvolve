import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useGetHabitAdaptation, useUpdateHabit, getGetHabitQueryKey, getGetHabitAdaptationQueryKey, type DailyHabitState, type Habit } from '@workspace/api-client-react';
import { reasonLabels, arUnit } from '@/lib/daily';
import { useDailyReflection, useAdaptationDecision, useRefreshAfterDaily } from '@/hooks/use-daily';
import { arDate } from '@/components/journey-ui';

export function MissedReasonForm({ state }: { state: DailyHabitState }) {
  const [reason, setReason] = useState<string | null>(state.missedReason ?? null);
  const [note, setNote] = useState('');
  const { save, pending } = useDailyReflection(state.habitId);
  const needNote = reason === 'other' && !note.trim();
  return <div className="rounded-2xl bg-[#f6e9df] p-4 mt-4" data-testid="block-missed">
    <h3 className="font-bold">ما الذي حدث في {arDate(state.date)}؟</h3>
    <p className="muted text-sm mt-1">لن نغيّر هدفك دون إذنك، ولن نسجّل هذا اليوم كإنجاز.</p>
    <div className="grid sm:grid-cols-2 gap-2 my-3">{reasonLabels.map(([v, t]) => <button key={v} type="button" data-testid={`button-reason-${v}`} onClick={() => setReason(v)} className={`rounded-xl border min-h-12 px-3 text-sm font-semibold text-start ${reason === v ? 'bg-[#245448] text-white border-[#245448]' : 'bg-[#fff9ed] border-[#d7cbb8]'}`}>{t}</button>)}</div>
    <textarea className="field" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={reason === 'other' ? 'اكتب ما حدث بكلماتك' : 'ملاحظة (اختيارية)'} />
    <button type="button" disabled={!reason || needNote || pending} data-testid="button-save-missed" className="btn w-full sm:w-auto mt-3" onClick={() => save(state.date, { missedReason: reason, note: note.trim() || null })}>{pending ? 'نحفظ…' : 'حفظ'}</button>
  </div>;
}

/** Per-reason adaptation offer, shown after a reason (or a hard day) is saved and before a decision exists. */
export function AdaptationOffer({ state, habit }: { state: DailyHabitState; habit: Habit }) {
  const qc = useQueryClient(); const refresh = useRefreshAfterDaily(habit.id);
  const reason = state.missedReason ?? (state.difficulty === 'hard' || state.difficulty === 'very_hard' ? 'too_difficult' : null);
  const adapt = useGetHabitAdaptation(habit.id, { query: { enabled: reason === 'too_difficult', queryKey: getGetHabitAdaptationQueryKey(habit.id) } });
  const update = useUpdateHabit();
  const [patched, setPatched] = useState(false);
  const { decide, pending } = useAdaptationDecision(habit.id);
  const [cue, setCue] = useState(state.cue ?? ''); const [cueType, setCueType] = useState<'time' | 'routine' | 'custom'>((state.cueType as 'time' | 'routine' | 'custom' | null) ?? 'routine'); const [cueTime, setCueTime] = useState(state.cueTime ?? '08:00');
  const [starter, setStarter] = useState(state.startAction ?? '');
  if (!reason) return null;
  if (state.adaptationDecision) return <p className="text-sm rounded-xl bg-[#e7efe3] p-3 mt-4" data-testid="text-decision">{state.adaptationDecision === 'accepted' ? 'اعتمدت التعديل، وهو محفوظ.' : 'أبقيت خطتك كما هي، وهذا قرارك.'}</p>;
  const keep = (msg: string) => <div className="rounded-xl bg-[#eef0e2] p-4 mt-4" data-testid="block-adaptation"><p className="text-sm leading-7">{msg}</p><button className="btn btn-light mt-3 w-full sm:w-auto" disabled={pending} onClick={() => decide(state.date, 'rejected')}>حسنًا، أكمل بخطتي</button></div>;
  const patchAccept = (data: Record<string, unknown>) => {
    const finish = () => decide(state.date, 'accepted', () => toast.success('حفظنا اختيارك'));
    if (patched) { finish(); return; }
    update.mutate({ habitId: habit.id, data: data as never }, { onSuccess: r => { qc.setQueryData(getGetHabitQueryKey(habit.id), r); setPatched(true); refresh(); finish(); }, onError: () => toast.error('تعذّر حفظ التغيير؛ خطتك كما هي') });
  };
  const box = (children: React.ReactNode, title: string) => <div className="rounded-xl bg-[#eef0e2] p-4 mt-4" data-testid="block-adaptation"><h4 className="font-bold mb-2">{title}</h4>{children}<button className="block text-sm underline mt-3" disabled={pending} onClick={() => decide(state.date, 'rejected')}>أبقِ خطتي كما هي</button></div>;
  if (reason === 'no_time') return keep(`لا بأس. الخطة الرئيسية تبقى كما هي${state.busyDayValue ? `، ويمكنك في الأيام المزدحمة الاكتفاء بـ ${state.busyDayValue} ${arUnit(habit.unit)}` : ''}.`);
  if (reason === 'unexpected') return keep('أمور تحدث. خطتك باقية كما هي، ولا شيء يتغير.');
  if (reason === 'forgot') return box(<><p className="text-sm mb-3">اختر إشارة تذكّرك. هي من اختيارك.</p><div className="flex gap-2 mb-3">{([['time', 'وقت'], ['routine', 'روتين'], ['custom', 'مخصّص']] as const).map(([v, t]) => <button key={v} type="button" onClick={() => setCueType(v)} className={`flex-1 min-h-11 rounded-xl text-sm font-semibold ${cueType === v ? 'bg-[#245448] text-white' : 'bg-[#fff9ed] border border-[#d7cbb8]'}`}>{t}</button>)}</div>{cueType === 'time' ? <input type="time" className="field" value={cueTime} onChange={e => setCueTime(e.target.value)} /> : <input className="field" value={cue} onChange={e => setCue(e.target.value)} placeholder={cueType === 'routine' ? 'بعد أن...' : 'إشارتك الخاصة'} />}<button className="btn w-full sm:w-auto" disabled={update.isPending || pending || (cueType !== 'time' && !cue.trim())} onClick={() => patchAccept(cueType === 'time' ? { cueType, cueTime } : { cueType, cue: cue.trim() })}>حفظ الإشارة</button></>, 'ما الذي يذكّرك؟');
  if (reason === 'lost_motivation') return box(<><p className="text-sm mb-3">حين يغيب الحماس، تكفي حركة أولى صغيرة جدًا.</p><input className="field" value={starter} onChange={e => setStarter(e.target.value)} placeholder="مثال: أفتح الدفتر فقط" /><button className="btn w-full sm:w-auto" disabled={update.isPending || pending || !starter.trim()} onClick={() => patchAccept({ startAction: starter.trim() })}>اعتمد حركة البداية</button></>, 'حركة بداية صغيرة');
  if (reason === 'too_difficult' || reason === 'other') {
    const a = adapt.data;
    if (reason === 'other') return keep('شكرًا لأنك كتبت ذلك. لن نغيّر شيئًا دون إذنك.');
    if (adapt.isLoading) return <div className="skeleton h-20 mt-4" />;
    if (adapt.isError) return keep('المدرّب يستريح قليلًا. خطتك كما هي ويمكنك المتابعة.');
    if (!a || !a.suggestion) return keep('هذا اليوم صعب أحيانًا، وهذا طبيعي. لا اقتراح جديد الآن، وخطتك باقية.');
    const isQuit = habit.goalType === 'quit';
    return box(<><p className="text-sm leading-7">{a.coachMessage}</p><p className="text-sm font-bold mt-2">{isQuit ? `المقترح: هدف ${a.targetValue}، وحد نجاح ${a.newSuccessLimitValue ?? habit.successLimitValue}` : `المقترح: هدف ${a.targetValue} ${arUnit(habit.unit)}، وحد أدنى ${a.minimumValue}`}. الأيام المسجّلة لا تتغير.</p><button className="btn w-full sm:w-auto mt-3" disabled={update.isPending || pending} data-testid="button-accept-adaptation" onClick={() => patchAccept({ targetValue: a.targetValue, minimumValue: a.minimumValue, ...(isQuit ? { successLimitValue: a.newSuccessLimitValue } : {}), expectedTargetValue: a.expectedTargetValue, expectedMinimumValue: a.expectedMinimumValue, expectedSuccessLimitValue: a.expectedSuccessLimitValue })}>اقبل الاقتراح</button></>, 'اقتراح بإذنك');
  }
  return null;
}
