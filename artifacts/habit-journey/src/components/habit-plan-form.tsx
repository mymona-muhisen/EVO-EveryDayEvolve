import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAiHabitBuilder, useCreateHabit, useUpdateHabit, getListHabitsQueryKey, getGetHabitQueryKey, getGetDashboardTodayQueryKey, type Habit, type HabitInput } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { Sparkles, ArrowLeft } from 'lucide-react';
import { Field, categories } from '@/components/journey-ui';

const symbols=['📖','🌱','🏃','💧','🧘','🎨','✍️','🎵'];
const fallback=(n:number)=>({targetValue:Math.max(1,Math.round(n/6)),minimumValue:Math.max(1,Math.round(n/12)),busyDayValue:Math.max(1,Math.round(n/20))});
export function unitName(unit:HabitInput['unit']){return unit==='minutes'?'دقيقة':unit==='pages'?'صفحة':unit==='count'?'مرة':'وحدة'}
export function HabitPlanForm({habit,seed,onSaved}: {habit?:Habit;seed?:{title:string;minutes:number;category:HabitInput['category'];emoji:string};onSaved?:(id:number)=>void}){
  const [form,setForm]=useState<HabitInput>(habit?{title:habit.title,emoji:habit.emoji,category:habit.category,cadence:habit.cadence,customDays:habit.customDays||undefined,unit:habit.unit,targetValue:habit.targetValue,minimumValue:habit.minimumValue||undefined,busyDayValue:habit.busyDayValue||undefined,baselineValue:habit.baselineValue||undefined,successLimitValue:habit.successLimitValue||undefined,difficulty:habit.difficulty,goalType:habit.goalType,milestones:habit.milestones}:{title:seed?.title||'',emoji:seed?.emoji||'🌱',category:seed?.category||'health',cadence:'daily',unit:seed?'minutes':'minutes',targetValue:seed?.minutes||20,minimumValue:seed?Math.max(1,Math.round(seed.minutes*.25)):5,busyDayValue:seed?Math.max(1,Math.round(seed.minutes*.1)):2,difficulty:'easy',goalType:'build'});
  const [intent,setIntent]=useState(seed?.title||habit?.title||'');
  const [desired,setDesired]=useState(seed?.minutes||habit?.targetValue||60);
  const [message,setMessage]=useState('');
  const [planned,setPlanned]=useState(!!habit);
  const builder=useAiHabitBuilder(),create=useCreateHabit(),update=useUpdateHabit(),qc=useQueryClient();
  const set=<K extends keyof HabitInput>(k:K,v:HabitInput[K])=>setForm(f=>({...f,[k]:v}));
  const suggest=()=>{
    if(!intent.trim()||desired<=0){toast.error('اكتب نيتك والمدة التي تتمناها');return}
    builder.mutate({data:{intent:intent.trim(),requestedDuration:desired,unit:form.unit,goalType:form.goalType}},{onSuccess:r=>{setForm(f=>({...f,title:r.title,targetValue:r.targetValue,minimumValue:r.minimumValue,busyDayValue:r.busyDayValue}));setMessage(r.coachMessage||r.reason);setPlanned(true)},onError:()=>{const v=fallback(desired);setForm(f=>({...f,title:f.title||intent.trim(),...v}));setMessage('تعذّر جلب الاقتراح؛ أعددنا بداية صغيرة قابلة للتعديل بدلًا منه.');setPlanned(true)}});
  };
  const submit=(e:React.FormEvent)=>{
    e.preventDefault();
    if(!planned){toast.info('اطلب بداية صغيرة أولًا، ثم عدّلها كما تحب قبل الحفظ');return}
    const target=Number(form.targetValue),min=Number(form.minimumValue),busy=Number(form.busyDayValue);
    if(!form.title.trim()||!Number.isFinite(target)||target<=0){toast.error('اكتب اسمًا وهدفًا صالحًا');return}
    if(form.cadence==='custom_days'&&!form.customDays?.length){toast.error('اختر يومًا واحدًا على الأقل');return}
    if(form.goalType==='build'&&(!Number.isFinite(min)||!Number.isFinite(busy)||min<=0||busy<=0||min>target||busy>min)){toast.error('اجعل خطوة اليوم المزدحم أقل من أو تساوي الحد الأدنى، والحد الأدنى لا يتجاوز الهدف');return}
    if(form.goalType==='quit'&&(!form.baselineValue||!form.successLimitValue||form.successLimitValue>=form.baselineValue)){toast.error('اجعل حد النجاح أصغر من المستوى المعتاد');return}
    const data:HabitInput={...form,title:form.title.trim(),targetValue:target,...(form.goalType==='build'?{minimumValue:min,busyDayValue:busy}:{minimumValue:undefined,busyDayValue:undefined,baselineValue:Number(form.baselineValue),successLimitValue:Number(form.successLimitValue)})};
    const done=(id:number)=>{qc.invalidateQueries({queryKey:getListHabitsQueryKey()});qc.invalidateQueries({queryKey:getGetDashboardTodayQueryKey()});if(habit)qc.invalidateQueries({queryKey:getGetHabitQueryKey(id)});toast.success(habit?'حُفظت التغييرات':'أضفت خطوة جديدة إلى رحلتك');onSaved?.(id)};
    if(habit)update.mutate({habitId:habit.id,data},{onSuccess:r=>done(r.id),onError:()=>toast.error('تعذّر حفظ التغييرات')});
    else create.mutate({data},{onSuccess:r=>done(r.id),onError:()=>toast.error('تعذّر إضافة العادة')});
  };
  return <form onSubmit={submit} dir="rtl" className="space-y-4">
    {!habit&&<div className="rounded-2xl bg-[#e6eee2] p-5 border border-[#cfdfce]">
      <div className="flex items-center gap-2 text-[#245448] font-bold mb-2"><Sparkles size={17}/> من نية كبيرة إلى بداية ممكنة</div>
      <p className="muted text-sm mb-4">ما الذي تود فعله؟ أخبرنا بما تتمناه، ثم اختر بنفسك ما يناسب أيامك.</p>
      <Field label="نيّتك"><input data-testid="input-habit-intent" className="field" value={intent} onChange={e=>{setIntent(e.target.value);setPlanned(false)}} placeholder="أريد القراءة كل يوم"/></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="الكمية التي تتمناها"><input data-testid="input-desired-duration" type="number" min="1" className="field" value={desired} onChange={e=>{setDesired(Number(e.target.value));setPlanned(false)}}/></Field><Field label="القياس"><select className="field" value={form.unit} onChange={e=>{set('unit',e.target.value as HabitInput['unit']);setPlanned(false)}}><option value="minutes">دقيقة</option><option value="pages">صفحة</option><option value="count">مرة</option><option value="custom">وحدة</option></select></Field></div>
      <button type="button" data-testid="button-suggest-habit-plan" disabled={builder.isPending} className="btn btn-light" onClick={suggest}>{builder.isPending?'نجهّز بداية مناسبة…':'اقترح بداية صغيرة'}</button>
      {message&&<p role="status" className="mt-3 text-sm leading-7 text-[#245448]">{message} يمكنك تعديل كل قيمة قبل الحفظ.</p>}
    </div>}
    <Field label="اسم العادة"><input data-testid="input-habit-title" required className="field" value={form.title} onChange={e=>set('title',e.target.value)} placeholder="مثل: أقرأ قبل النوم"/></Field>
    <div><div className="text-sm font-bold mb-2">رمز العادة</div><div className="flex flex-wrap gap-2">{symbols.map(s=><button type="button" key={s} aria-label={`اختر ${s}`} onClick={()=>set('emoji',s)} className={`w-10 h-10 rounded-xl border text-xl ${form.emoji===s?'bg-[#eac48c] border-[#bd925a]':'bg-[#f7f1e7] border-[#e5dacb]'}`}>{s}</button>)}</div></div>
    {!habit&&<Field label="نوع الخطوة"><div className="grid grid-cols-2 gap-2">{([['build','أبني عادة'],['quit','أقلّل سلوكًا']] as const).map(([v,t])=><button type="button" key={v} onClick={()=>set('goalType',v)} className={`rounded-xl p-3 border ${form.goalType===v?'bg-[#dfebdd] border-[#3b765c]':'border-[#e3d9c9]'}`}>{t}</button>)}</div></Field>}
    <div className="grid grid-cols-2 gap-3"><Field label="المجال"><select className="field" value={form.category} onChange={e=>set('category',e.target.value as HabitInput['category'])}>{Object.entries(categories).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></Field><Field label="التكرار"><select data-testid="select-habit-cadence" className="field" value={form.cadence} onChange={e=>set('cadence',e.target.value as HabitInput['cadence'])}><option value="daily">كل يوم</option><option value="weekdays">أيام العمل</option><option value="weekly">مرة في الأسبوع</option><option value="custom_days">أيام أختارها</option></select></Field></div>
    {form.cadence==='custom_days'&&<div className="flex flex-wrap gap-2">{['أحد','اثن','ثلا','أرب','خمي','جمع','سبت'].map((x,i)=><button type="button" key={i} onClick={()=>set('customDays',form.customDays?.includes(i)?form.customDays.filter(v=>v!==i):[...(form.customDays||[]),i])} className={`w-10 h-10 rounded-full border text-xs ${form.customDays?.includes(i)?'bg-[#245448] text-[#fff9ed]':'bg-[#f7f1e7]'}`}>{x}</button>)}</div>}
    <div className="grid grid-cols-2 gap-3"><Field label={form.goalType==='quit'?'هدف التخفيض':'هدف اليوم'}><input data-testid="input-habit-target" type="number" min="1" className="field" value={form.targetValue} onChange={e=>set('targetValue',Number(e.target.value))}/></Field>{habit&&<Field label="القياس"><select className="field" value={form.unit} onChange={e=>set('unit',e.target.value as HabitInput['unit'])}><option value="minutes">دقيقة</option><option value="count">مرة</option><option value="pages">صفحة</option><option value="custom">وحدة</option></select></Field>}<Field label="الصعوبة"><select className="field" value={form.difficulty} onChange={e=>set('difficulty',e.target.value as HabitInput['difficulty'])}><option value="easy">سهلة</option><option value="medium">متوسطة</option><option value="hard">تحدٍ كبير</option></select></Field></div>
    {form.goalType==='build'?<div className="rounded-2xl border border-[#d7dece] p-4"><p className="text-sm muted mb-3">الحد الأدنى يُحسب نجاحًا. خطوة اليوم المزدحم يمكن أن تكون أصغر منه؛ تبقى خطوة تستحق التقدير، لكنها لا تُحسب يومًا ناجحًا إذا لم تبلغ الحد الأدنى.</p><div className="grid grid-cols-2 gap-3"><Field label="الحد الأدنى"><input data-testid="input-habit-minimum" type="number" min="1" className="field" value={form.minimumValue||''} onChange={e=>set('minimumValue',Number(e.target.value))}/></Field><Field label="خطة اليوم المزدحم"><input data-testid="input-habit-busy" type="number" min="1" className="field" value={form.busyDayValue||''} onChange={e=>set('busyDayValue',Number(e.target.value))}/></Field></div></div>:<div className="rounded-2xl border border-[#d7dece] p-4"><p className="muted text-sm mb-3">التقليل خطوة حقيقية؛ الوصول إلى الحد أو أقل منه يُحسب نجاحًا.</p><div className="grid grid-cols-2 gap-3"><Field label="المستوى المعتاد"><input type="number" min="1" className="field" value={form.baselineValue||''} onChange={e=>set('baselineValue',Number(e.target.value))}/></Field><Field label="حد النجاح (عنده أو أقل)"><input type="number" min="1" className="field" value={form.successLimitValue||''} onChange={e=>set('successLimitValue',Number(e.target.value))}/></Field></div></div>}
    <button data-testid="button-save-habit-plan" className="btn w-full" disabled={create.isPending||update.isPending||builder.isPending||!planned}>{create.isPending||update.isPending?'نحفظ خطوتك…':!planned?'اقترح بداية أولًا':habit?'حفظ التغييرات':'أضف هذه العادة'} <ArrowLeft size={16}/></button>
  </form>;
}