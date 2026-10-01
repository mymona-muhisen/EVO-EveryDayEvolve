import { invalidateDailyAll } from '@/hooks/use-daily';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAiHabitBuilder, useCreateHabit, useGetDashboardToday, useListRewards, getListRewardsQueryKey, getListHabitsQueryKey, getGetDashboardTodayQueryKey, type HabitInput } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import { Field } from '@/components/journey-ui';
import { refreshRewards, RewardEditor, emptyDraft, draftError, buildRewardInput, type RewardDraft } from '@/components/reward/real-reward';
import { usePhotoUpload } from '@/hooks/use-photo-upload';

type Unit = HabitInput['unit'];
type Cat = HabitInput['category'];
const unitAr = (u: Unit) => (u === 'minutes' ? 'دقيقة' : u === 'pages' ? 'صفحة' : u === 'count' ? 'مرة' : 'وحدة');
const quick: { label: string; intent: string; unit: Unit; amount: number; category: Cat; goal: 'build' | 'quit'; emoji: string }[] = [
  { label: 'القراءة', intent: 'أريد القراءة كل يوم', unit: 'pages', amount: 20, category: 'learning', goal: 'build', emoji: '📖' },
  { label: 'المشي', intent: 'أريد المشي كل يوم', unit: 'minutes', amount: 30, category: 'health', goal: 'build', emoji: '🏃' },
  { label: 'التأمل', intent: 'أريد لحظات هدوء يوميًا', unit: 'minutes', amount: 10, category: 'mindfulness', goal: 'build', emoji: '🧘' },
  { label: 'شرب الماء', intent: 'أريد شرب ماء أكثر', unit: 'count', amount: 8, category: 'health', goal: 'build', emoji: '💧' },
  { label: 'تقليل الشاشة', intent: 'أريد تقليل تصفّح الهاتف', unit: 'minutes', amount: 60, category: 'productivity', goal: 'quit', emoji: '🌱' },
];
const frictions: [string, string, string][] = [
  ['النسيان', 'اربطها بإشارة ثابتة', 'ضع شيئًا يذكّرك في طريقك، ثم ابدأ فورًا بعد الإشارة.'],
  ['ضيق الوقت', 'ابدأ بنسخة صغيرة جدًا', 'اجعل أول مرة بحجم يوم مزدحم؛ الاستمرار أهم من الحجم.'],
  ['قلة الحماس', 'قلّل الجهد عند البداية', 'جهّز ما تحتاجه مسبقًا حتى تبدأ دون قرار كبير.'],
  ['مشتتات حولي', 'غيّر المكان لا نفسك', 'ابعد مصدر التشتت عن مكان البدء قبل أن تبدأ.'],
  ['لا أعرف من أين أبدأ', 'حدّد أول حركة واضحة', 'اكتب حركة تستغرق دقيقتين وتبدو سخيفة في سهولتها.'],
];
const steps = ['النية', 'الاقتراح', 'الإشارة', 'العائق', 'الرحلة', 'الملخص'];
const num = (v: string) => (v === '' ? 0 : Number(v));

export function HabitWizard({ seed, onSaved }: { seed?: { title: string; minutes: number; category: Cat; emoji: string; intent?: string }; onSaved?: (id: number) => void }) {
  const today = useGetDashboardToday();
  const rewards = useListRewards();
  const builder = useAiHabitBuilder();
  const tipBuilder = useAiHabitBuilder();
  const [tip, setTip] = useState('');
  const create = useCreateHabit();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [execMode, setExecMode] = useState<NonNullable<HabitInput['executionType']> | null>(null);
  const [intent, setIntent] = useState(seed?.intent || seed?.title || '');
  const [goal, setGoal] = useState<'build' | 'quit'>('build');
  const [goalExplicit, setGoalExplicit] = useState(false);
  const [cadence, setCadence] = useState<HabitInput['cadence']>('daily');
  const [customDays, setCustomDays] = useState<number[]>([]);
  const [unit, setUnit] = useState<Unit>('minutes');
  const [desired, setDesired] = useState(seed?.minutes || 20);
  const [baselineAsk, setBaselineAsk] = useState(0);
  const [category, setCategory] = useState<Cat>(seed?.category || 'health');
  const [emoji, setEmoji] = useState(seed?.emoji || '🌱');
  const [understood, setUnderstood] = useState('');
  const [fallbackNote, setFallbackNote] = useState('');
  const [p, setP] = useState({ title: '', target: 10, minimum: 5, busy: 2, baseline: 0, limit: 0, floor: 1 });
  const [cueType, setCueType] = useState<'time' | 'routine' | 'custom'>('routine');
  const [cueTime, setCueTime] = useState('07:30');
  const [cue, setCue] = useState('');
  const [friction, setFriction] = useState('');
  const [startAction, setStartAction] = useState('');
  const [startWhen, setStartWhen] = useState<'today' | 'tomorrow' | null>(null);
  const [needBaseline, setNeedBaseline] = useState(false);
  const [rewardId, setRewardId] = useState<number | null>(null);
  const [rd, setRd] = useState<RewardDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const { uploadPhoto } = usePhotoUpload();

  const serverDate = today.data?.date?.slice(0, 10);
  const suggested = today.data?.suggestedJourneyStartDate?.slice(0, 10);
  const startChoice: 'today' | 'tomorrow' = startWhen ?? (suggested && serverDate && suggested > serverDate ? 'tomorrow' : 'today');
  const tomorrow = (() => { if (!serverDate) return ''; const d = new Date(`${serverDate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const owned = (rewards.data || []).filter(r => !r.isRedeemed && !r.habitId);
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP(x => ({ ...x, [k]: v }));

  const propose = () => {
    if (!intent.trim() || desired <= 0) { toast.error('اكتب نيتك والكمية التي تتمناها'); return; }
    builder.mutate({ data: { intent: intent.trim(), requestedDuration: desired, unit, ...(goalExplicit ? { goalType: goal } : {}), ...(baselineAsk > 0 ? { baselineValue: baselineAsk } : {}) } }, {
      onSuccess: r => {
        if (!goalExplicit && !r.needsBaseline) setGoal(r.goalType);
        if (r.needsBaseline) { if (!goalExplicit) setGoal('quit'); if (baselineAsk > 0) { toast.error('الرقم الذي كتبته لم يكفِ، جرّب رقمًا أدق'); return; } setNeedBaseline(true); toast.info('نحتاج أولًا أن تخبرنا كم تفعله عادةً، ثم نقترح عليك من جديد'); return; }
        setNeedBaseline(false);
        setUnit(r.unit); setCategory(r.category);
        setUnderstood(r.understoodGoal); setFallbackNote(r.source === 'deterministic' ? 'أعددنا لك بداية متحفظة؛ عدّل ما تريد.' : '');
        setP({ title: r.title, target: r.targetValue, minimum: r.minimumValue, busy: r.busyDayValue, baseline: r.baselineValue ?? baselineAsk, limit: r.successLimitValue ?? 0, floor: r.minimumFloor ?? (r.goalType === 'quit' ? 0 : 1) });
        if (r.cueType) setCueType(r.cueType); if (r.cueTime) setCueTime(r.cueTime); if (r.cue) setCue(r.cue); if (r.startAction) setStartAction(r.startAction);
        setStep(1);
      },
      onError: () => toast.error('تعذّر جلب الاقتراح. حاول مجددًا.'),
    });
  };

  const effGoal: 'build' | 'quit' = execMode === 'limit' ? 'quit' : execMode ? 'build' : goal;
  const effUnit: Unit = execMode === 'boolean' ? 'count' : execMode === 'duration' ? 'minutes' : execMode === 'count' && unit === 'minutes' ? 'count' : unit;
  const effP = execMode === 'boolean' ? { ...p, target: 1, minimum: 1, busy: 1, floor: 1 } : p;
  const chooseExec = (v: NonNullable<HabitInput['executionType']>) => {
    setExecMode(v);
    if (v === 'limit') { setGoal('quit'); setGoalExplicit(true); return; }
    setGoal('build'); setGoalExplicit(true);
    if (v === 'boolean') { setUnit('count'); setP(x => ({ ...x, target: 1, minimum: 1, busy: 1, floor: 1 })); }
    else if (v === 'duration') setUnit('minutes');
    else if (unit === 'minutes') setUnit('count');
  };
  const validProposal = () => {
    if (!effP.title.trim()) return 'اكتب اسمًا للعادة';
    if (cadence === 'custom_days' && !customDays.length) return 'اختر يومًا واحدًا على الأقل';
    if (effGoal === 'build' ? !(effP.floor > 0 && effP.floor <= effP.minimum) : !(effP.floor >= 0 && effP.floor <= effP.target)) return effGoal === 'build' ? 'أدنى حد للتخفيف يجب أن يكون موجبًا وألا يتجاوز الحد الأدنى' : 'أقل قيمة لا تكون سالبة ولا تتجاوز هدف التخفيض';
    if (effGoal === 'build') { if (effP.target <= 0 || effP.minimum <= 0 || effP.busy <= 0 || effP.minimum > effP.target || effP.busy > effP.minimum) return 'اجعل اليوم المزدحم ≤ الحد الأدنى ≤ الهدف'; }
    else if (effP.baseline <= 0 || effP.limit < effP.target || effP.limit > effP.baseline || effP.target < 0) return 'رتّب الأرقام: الهدف ≤ حد النجاح ≤ المستوى المعتاد';
    return '';
  };
  const next = () => {
    if (step === 1) { const e = validProposal(); if (e) { toast.error(e); return; } }
    if (step === 4) { const e = draftError(rd); if (e) { toast.error(e); return; } }
    if (step === 2) { if (cueType === 'time' && !cueTime) { toast.error('اختر وقتًا'); return; } if (cueType !== 'time' && !cue.trim()) { toast.error('اكتب الإشارة أو اخترها من الاقتراحات'); return; } }
    setStep(s => s + 1);
  };
  const save = async () => {
    if (!serverDate) { toast.info('لحظة، نجهّز تاريخ اليوم'); return; }
    const re = draftError(rd); if (re) { toast.error(re); setStep(4); return; }
    let journeyReward;
    setSaving(true);
    try { journeyReward = await buildRewardInput(rd, uploadPhoto); } catch { setSaving(false); toast.error('تعذّر رفع صورة المكافأة. لم يُنشأ شيء.'); return; }
    setSaving(false);
    const data: HabitInput = {
      title: p.title.trim(), emoji, category, cadence, ...(cadence === 'custom_days' ? { customDays } : {}), unit: effUnit, difficulty: 'easy', goalType: effGoal, ...(execMode ? { executionType: execMode } : {}),
      targetValue: effP.target,
      ...(effGoal === 'build' ? { minimumValue: effP.minimum, busyDayValue: effP.busy } : { baselineValue: p.baseline, successLimitValue: p.limit }),
      cueType, cueTime: cueType === 'time' ? cueTime : null, cue: cueType === 'time' ? null : cue.trim() || null,
      startAction: startAction.trim() || null, friction: friction || null, minimumFloor: effP.floor,
      journeyStartDate: startChoice === 'today' ? serverDate : tomorrow, journeyLength: 22, rewardId: rewardId ?? undefined, ...(journeyReward ? { journeyReward } : {}),
    };
    create.mutate({ data }, {
      onSuccess: r => {
        invalidateDailyAll(qc, r.id);
        qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardTodayQueryKey() });
        qc.invalidateQueries({ queryKey: getListRewardsQueryKey() });
        refreshRewards(qc, r.id);
         window.dispatchEvent(new CustomEvent('habit-journey-created', { detail: { habitId: r.id, title: r.title } }));
        toast.success('بدأت رحلتك الجديدة، اثنان وعشرون يومًا بخطوات صغيرة');
        onSaved?.(r.id);
      },
      onError: () => toast.error('تعذّر إنشاء العادة. لم يُحفظ شيء، حاول مجددًا.'),
    });
  };
  const u = unitAr(unit);

  return <div dir="rtl" className="space-y-5">
    <div className="flex gap-1" aria-label={`الخطوة ${step + 1} من ${steps.length}`}>{steps.map((s, i) => <div key={s} className="flex-1"><div className={`h-1.5 rounded-full ${i <= step ? 'bg-[#245448]' : 'bg-[#e3d9c9]'}`} /><div className={`text-[11px] mt-1 ${i === step ? 'font-bold' : 'muted'} hidden sm:block`}>{s}</div></div>)}</div>

    {step === 0 && <div className="space-y-4">
      <div className="rounded-2xl bg-[#e6eee2] border border-[#cfdfce] p-4"><div className="flex items-center gap-2 text-[#245448] font-bold mb-1"><Sparkles size={16} /> من نية كبيرة إلى بداية ممكنة</div><p className="muted text-sm">ابدأ بما تتمناه، ونقترح عليك خطوة صغيرة تعدّلها كما تشاء.</p></div>
      <div className="flex flex-wrap gap-2">{quick.map(q => <button type="button" key={q.label} data-testid={`button-quick-goal-${q.label}`} onClick={() => { setIntent(q.intent); setUnit(q.unit); setDesired(q.amount); setCategory(q.category); setGoal(q.goal); setGoalExplicit(true); setEmoji(q.emoji); }} className={`px-4 py-2 rounded-full text-sm border ${intent === q.intent ? 'bg-[#245448] text-white border-[#245448]' : 'bg-[#f7f1e7] border-[#e5dacb]'}`}>{q.label}</button>)}</div>
      <Field label="نيّتك"><input data-testid="input-habit-intent" className="field" value={intent} onChange={e => setIntent(e.target.value)} placeholder="أريد القراءة كل يوم" /></Field>
      <div className="grid grid-cols-2 gap-2">{([['build', 'أبني عادة'], ['quit', 'أقلّل سلوكًا']] as const).map(([v, t]) => <button type="button" key={v} onClick={() => { setGoal(v); setGoalExplicit(true); }} className={`rounded-xl p-3 border ${goal === v ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}>{t}</button>)}</div>
      <div className="grid grid-cols-2 gap-3"><Field label={goal === 'quit' ? 'الكمية التي تتمنى الوصول إليها' : 'الكمية التي تتمناها'}><input data-testid="input-desired-duration" type="number" min="1" className="field" value={desired || ''} onChange={e => setDesired(num(e.target.value))} /></Field><Field label="القياس"><select className="field" disabled={execMode === 'boolean' || execMode === 'duration'} value={effUnit} onChange={e => setUnit(e.target.value as Unit)}><option value="minutes">دقيقة</option><option value="pages">صفحة</option><option value="count">مرة</option><option value="custom">وحدة</option></select></Field></div>
      {(goal === 'quit' || needBaseline) && <Field label={`كم تفعله عادةً في اليوم؟ (${u})`}><input data-testid="input-baseline" type="number" min="1" className="field" value={baselineAsk || ''} onChange={e => setBaselineAsk(num(e.target.value))} placeholder="مثلًا 120" /></Field>}
    </div>}

    {step === 1 && <div className="space-y-4">
      <div className="rounded-2xl bg-[#f3ead9] p-4"><div className="eyebrow mb-1">فهمنا هدفك هكذا</div><p data-testid="text-understood-goal" className="leading-7">{understood || intent}</p>{fallbackNote && <p className="text-xs muted mt-2">{fallbackNote}</p>}</div>
      <Field label="اسم العادة"><input data-testid="input-habit-title" className="field" value={p.title} onChange={e => set('title', e.target.value)} /></Field>
      {goal === 'build' ? <div className="grid grid-cols-3 gap-2"><Field label={`الهدف (${u})`}><input data-testid="input-habit-target" type="number" min="1" className="field" value={p.target || ''} onChange={e => set('target', num(e.target.value))} /></Field><Field label="الحد الأدنى"><input data-testid="input-habit-minimum" type="number" min="1" className="field" value={p.minimum || ''} onChange={e => set('minimum', num(e.target.value))} /></Field><Field label="اليوم المزدحم"><input data-testid="input-habit-busy" type="number" min="1" className="field" value={p.busy || ''} onChange={e => set('busy', num(e.target.value))} /></Field></div>
        : <div className="grid grid-cols-3 gap-2"><Field label="المعتاد"><input type="number" min="1" className="field" value={p.baseline || ''} onChange={e => set('baseline', num(e.target.value))} /></Field><Field label="هدف التخفيض"><input data-testid="input-habit-target" type="number" min="0" className="field" value={p.target || ''} onChange={e => set('target', num(e.target.value))} /></Field><Field label="حد النجاح (الأقصى)"><input type="number" min="1" className="field" value={p.limit || ''} onChange={e => set('limit', num(e.target.value))} /></Field></div>}
      <Field label="كيف تنفّذ هذه الخطوة؟"><div className="grid grid-cols-2 gap-2" data-testid="choice-execution-type">{([['duration', 'مؤقّت زمني'], ['count', 'عدّاد'], ['boolean', 'نعم / ليس بعد'], ['limit', 'حد أقصى للتقليل']] as const).map(([v, t]) => <button type="button" key={v} data-testid={`button-exec-${v}`} onClick={() => chooseExec(v)} className={`rounded-xl min-h-12 px-3 text-sm font-semibold ${execMode === v ? 'bg-[#245448] text-white' : 'bg-[#eae4d5]'}`}>{t}</button>)}</div>{!execMode && <p className="text-xs muted mt-2">اختياري. إن لم تختر، نحدّدها من القياس.</p>}</Field>
      <div className="grid grid-cols-2 gap-3"><Field label="القياس"><select className="field" disabled={execMode === 'boolean' || execMode === 'duration'} value={effUnit} onChange={e => setUnit(e.target.value as Unit)}><option value="minutes">دقيقة</option><option value="pages">صفحة</option><option value="count">مرة</option><option value="custom">وحدة</option></select></Field><Field label="التكرار"><select data-testid="select-habit-cadence" className="field" value={cadence} onChange={e => setCadence(e.target.value as HabitInput['cadence'])}><option value="daily">كل يوم</option><option value="weekdays">أيام العمل</option><option value="custom_days">أيام أختارها</option></select></Field></div>
      {cadence === 'custom_days' && <div className="flex flex-wrap gap-2">{['أحد', 'اثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'].map((x, i) => <button type="button" key={i} onClick={() => setCustomDays(d => d.includes(i) ? d.filter(v => v !== i) : [...d, i])} className={`w-10 h-10 rounded-full border text-xs ${customDays.includes(i) ? 'bg-[#245448] text-[#fff9ed]' : 'bg-[#f7f1e7]'}`}>{x}</button>)}</div>}
      <Field label={goal === 'build' ? 'أدنى حد يمكن أن تخفّف إليه الخطة لاحقًا' : 'أقل قيمة يصل إليها حد النجاح'}><input data-testid="input-minimum-floor" type="number" min={goal === 'build' ? 1 : 0} className="field" value={p.floor} onChange={e => set('floor', num(e.target.value))} /></Field>
      <p className="muted text-xs leading-6">{goal === 'build' ? 'الحد الأدنى يُحسب يومًا ناجحًا. خطوة اليوم المزدحم أصغر، تُسجَّل بصدق ولا تُحسب نجاحًا إن لم تبلغ الحد الأدنى.' : 'هدف التخفيض هو ما نتجه إليه تدريجيًا. حد النجاح هو أقصى قيمة تُحسب اليوم ناجحًا الآن؛ ينخفض بلطف بإذنك.'}</p>
    </div>}

    {step === 2 && <div className="space-y-4">
      <p className="muted text-sm">متى تبدأ؟ الإشارة تجعل البداية أسهل من التفكير فيها.</p>
      <div className="grid grid-cols-3 gap-2">{([['time', 'وقت محدد'], ['routine', 'بعد روتين'], ['custom', 'إشارة خاصة']] as const).map(([v, t]) => <button type="button" key={v} onClick={() => setCueType(v)} className={`rounded-xl p-3 border text-sm ${cueType === v ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}>{t}</button>)}</div>
      {cueType === 'time' ? <Field label="الوقت"><input type="time" className="field" value={cueTime} onChange={e => setCueTime(e.target.value)} /></Field>
        : <><Field label={cueType === 'routine' ? 'بعد أي شيء تفعله أصلًا؟' : 'اكتب إشارتك'}><input data-testid="input-cue" className="field" value={cue} onChange={e => setCue(e.target.value)} placeholder="بعد القهوة الصباحية" /></Field>{cueType === 'routine' && <div className="flex flex-wrap gap-2">{['بعد الفطور', 'بعد صلاة المغرب', 'قبل النوم', 'بعد العودة من العمل'].map(c => <button type="button" key={c} onClick={() => setCue(c)} className="px-3 py-1.5 rounded-full text-xs bg-[#eae4d5]">{c}</button>)}</div>}</>}
    </div>}

    {step === 3 && <div className="space-y-4">
      <p className="muted text-sm">ما أكثر ما قد يعطّلك؟ اختر واحدًا.</p>
      <div className="space-y-2">{frictions.map(([f, , tip]) => <button type="button" key={f} onClick={() => { setFriction(f); setTip(''); }} className={`w-full text-right rounded-xl p-3 border ${friction === f ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}><b className="text-sm">{f}</b>{friction === f && <p className="text-xs muted mt-1 leading-6">{tip}</p>}</button>)}</div>
      {friction && <div><button type="button" data-testid="button-friction-tip" className="btn btn-light" disabled={tipBuilder.isPending} onClick={() => {
        const fallbackTip = frictions.find(x => x[0] === friction)?.[2] ?? '';
        tipBuilder.mutate({ data: { intent: intent.trim() || p.title, requestedDuration: desired > 0 ? desired : 1, unit, goalType: goal, friction, ...(goal === 'quit' && p.baseline > 0 ? { baselineValue: p.baseline } : baselineAsk > 0 ? { baselineValue: baselineAsk } : {}) } }, {
          onSuccess: r => setTip(r.frictionTip || fallbackTip),
          onError: () => setTip(fallbackTip),
        });
      }}>{tipBuilder.isPending ? 'نفكّر معك…' : 'اقترح طريقة لتسهيل البداية'}</button>{tip && <p role="status" data-testid="text-friction-tip" className="text-sm leading-7 mt-3 rounded-xl bg-[#e6eee2] p-3">{tip}</p>}</div>}
      <Field label="أول حركة صغيرة (قابلة للتعديل)"><input data-testid="input-start-action" className="field" value={startAction} onChange={e => setStartAction(e.target.value)} placeholder={friction ? frictions.find(x => x[0] === friction)?.[1] : 'أفتح الكتاب'} /></Field>
    </div>}

    {step === 4 && <div className="space-y-4">
      <div><div className="text-sm font-bold mb-2">رحلة من 22 يومًا. متى تبدأ؟</div><div className="grid grid-cols-2 gap-2">{([['today', 'اليوم'], ['tomorrow', 'غدًا']] as const).map(([v, t]) => <button type="button" key={v} onClick={() => setStartWhen(v)} className={`rounded-xl p-3 border ${startChoice === v ? 'bg-[#dfebdd] border-[#3b765c]' : 'border-[#e3d9c9]'}`}>{t}</button>)}</div>{!serverDate && <p className="text-xs muted mt-2">نجهّز تاريخ اليوم…</p>}</div>
      <div className="rounded-2xl border border-[#e3d9c9] p-4"><div className="font-bold text-sm mb-3">مكافأة حقيقية تنتظرك في نهاية الرحلة</div><RewardEditor draft={rd} onChange={setRd} disabled={saving || create.isPending} /></div>
      <Field label="مكافأة من متجر العملات (اختياري)"><select data-testid="select-reward" className="field" value={rewardId ?? ''} onChange={e => setRewardId(e.target.value ? Number(e.target.value) : null)}><option value="">بدون مكافأة مرتبطة</option>{owned.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>
      {rewards.isError && <p className="text-xs muted">تعذّر تحميل مكافآتك، يمكنك المتابعة بدونها.</p>}
      {!rewards.isLoading && !owned.length && <p className="text-xs muted">لا مكافآت متاحة للربط الآن. يمكنك إضافتها من صفحة المكافآت لاحقًا.</p>}
    </div>}

    {step === 5 && <div className="space-y-3">
      <div className="paper rounded-2xl p-5 space-y-2 text-sm leading-7"><div className="text-xl font-bold">{emoji} {p.title}</div>
        {goal === 'build' ? <p>الهدف {p.target} {u} · الحد الأدنى {p.minimum} · اليوم المزدحم {p.busy}</p> : <p>المعتاد {p.baseline} · هدف التخفيض {p.target} · النجاح عند {p.limit} {u} أو أقل</p>}
        <p>الإشارة: {cueType === 'time' ? `الساعة ${cueTime}` : cue}</p>
        {friction && <p>العائق: {friction}</p>}{startAction && <p>أول حركة: {startAction}</p>}
        <p>تبدأ {startChoice === 'today' ? 'اليوم' : 'غدًا'} · 22 يومًا{rewardId ? ` · مكافأة المتجر: ${owned.find(r => r.id === rewardId)?.title ?? ''}` : ''}</p>
        <div className="border-t border-[#e8dfce] pt-2" data-testid="summary-reward">{rd.enabled ? <p><b>مكافأتك:</b> {rd.title.trim() || '—'} · {rd.type === 'physical' ? 'شيء أملكه' : 'تجربة'}{rd.value !== '' ? ` · قيمة تقديرية ${rd.value}` : ''}{rd.description.trim() ? <span className="block muted">{rd.description.trim()}</span> : null}</p> : <p className="muted">بلا مكافأة حقيقية لهذه الرحلة.</p>}<button type="button" data-testid="button-edit-reward-summary" className="text-xs underline mt-1" onClick={() => setStep(4)}>تعديل المكافأة</button></div></div>
      <p className="muted text-xs">يمكنك العودة لتغيير أي شيء. لن يُنشأ شيء قبل الضغط على الزر.</p>
    </div>}

    <div className="flex justify-between gap-3 pt-2">
      {step > 0 ? <button type="button" className="btn btn-ghost" onClick={() => setStep(s => s - 1)}><ArrowRight size={16} /> رجوع</button> : <span />}
      {step === 0 ? <button type="button" data-testid="button-suggest-habit-plan" className="btn" disabled={builder.isPending} onClick={propose}>{builder.isPending ? 'نجهّز بداية مناسبة…' : 'اقترح بداية صغيرة'} <ArrowLeft size={16} /></button>
        : step < 5 ? <button type="button" className="btn" onClick={next}>متابعة <ArrowLeft size={16} /></button>
        : <button type="button" data-testid="button-save-habit-plan" className="btn" disabled={create.isPending || saving || !serverDate} onClick={save}>{create.isPending || saving ? 'نبدأ رحلتك…' : 'ابدأ الرحلة'} <ArrowLeft size={16} /></button>}
    </div>
  </div>;
}
