import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetTrackingSession, useChangeTrackingSession, useCreateTrackingCheckin,
  useGetTrackedDay, useGetTrackedDayAnalysis, useUpdateTimeEntry,
  useListTimeEntries, useGetTimeEntriesSummary, useCreateTimeEntry, useDeleteTimeEntry,
  useListHabits, useCreateHabit, useGetDashboardToday,
  getGetTrackingSessionQueryKey, getGetTrackedDayQueryKey, getGetTrackedDayAnalysisQueryKey,
  getListTimeEntriesQueryKey, getGetTimeEntriesSummaryQueryKey, getListHabitsQueryKey,
  getGetDashboardTodayQueryKey,
  type TimeCategory, type TimeEntry, type HabitInput, type ReplacementActivity,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { ArrowLeft, Clock3, Pause, Play, Check, Pencil, Trash2, Settings2, Flag, RotateCcw } from 'lucide-react';
import { PageHead, SectionTitle, Field, Modal, Empty, Loading, ErrorBlock, AddButton, dateToday as localDateToday, arDate } from '@/components/journey-ui';
import { HabitPlanForm } from '@/components/habit-plan-form';

const activities: {key:TimeCategory; name:string; icon:string; color:string}[] = [
  {key:'study',name:'دراسة',icon:'📚',color:'#608a79'}, {key:'work',name:'عمل',icon:'💻',color:'#447364'},
  {key:'social_media',name:'تواصل رقمي',icon:'📱',color:'#ca866a'}, {key:'gaming',name:'ألعاب',icon:'🎮',color:'#a57883'},
  {key:'entertainment',name:'ترفيه',icon:'🎬',color:'#b39569'}, {key:'exercise',name:'رياضة',icon:'🏃',color:'#789365'},
  {key:'eating',name:'طعام',icon:'🍽',color:'#c3a268'}, {key:'rest',name:'راحة',icon:'😴',color:'#8b9aa4'},
  {key:'travel',name:'تنقّل',icon:'🚗',color:'#859c91'}, {key:'socializing',name:'لقاءات',icon:'💬',color:'#b38a9b'},
  {key:'personal',name:'وقت شخصي',icon:'✨',color:'#aa9367'}, {key:'other',name:'شيء آخر',icon:'＋',color:'#918b7b'},
  {key:'unknown',name:'لا أتذكر',icon:'🤷',color:'#a7a69a'},
];
const activity = (key:TimeCategory) => activities.find(a=>a.key===key) || activities[11];
const suggestions=['قراءة','طبخ','ترتيب','تسوّق','مشي'];
const duration=(n:number)=> n>=60?`${Math.floor(n/60)} ساعة${n%60?` و${n%60} دقيقة`:''}`:`${n} دقيقة`;
const clock=(value:string|null)=> value?new Date(value).toLocaleTimeString('ar-EG-u-nu-latn',{hour:'numeric',minute:'2-digit'}):'—';
const choices=(selected:TimeCategory,onChoose:(key:TimeCategory)=>void)=> <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
  {activities.map(a=><button data-testid={`button-category-${a.key}`} type="button" key={a.key} onClick={()=>onChoose(a.key)} className={`rounded-2xl border p-3 sm:p-4 text-right transition-colors ${selected===a.key?'bg-[#dce9dc] border-[#3f775e]':'bg-[#faf7ee] border-[#e7decd] hover:border-[#76a08a]'}`}><span className="text-xl ml-2">{a.icon}</span><span className="font-bold text-sm">{a.name}</span></button>)}
</div>;

export function TimePage({user}: {user: {timezone:string}}){
   const dashboard=useGetDashboardToday();
   const dateToday=()=>dashboard.data?.date?.slice(0,10)??localDateToday(user.timezone);
   const [date,setDate]=useState(localDateToday(user.timezone)),[interval,setInterval]=useState<15|30>(15),[openIntro,setOpenIntro]=useState(()=>window.location.hash==='#how'),[openManual,setOpenManual]=useState(false);
   useEffect(()=>{if(dashboard.data?.date)setDate(current=>current===localDateToday(user.timezone)?dashboard.data!.date!.slice(0,10):current)},[dashboard.data?.date,user.timezone]);
  const [label,setLabel]=useState(''),[minutes,setMinutes]=useState(25),[habitId,setHabitId]=useState(''),[note,setNote]=useState('');
  const [selected,setSelected]=useState<TimeCategory>('study'),[other,setOther]=useState(''),[edit,setEdit]=useState<TimeEntry|null>(null),[editMinutes,setEditMinutes]=useState(15),[editNote,setEditNote]=useState('');
  const [confirmed,setConfirmed]=useState<TimeEntry|null>(null),[confirmPause,setConfirmPause]=useState(false),[confirmFinish,setConfirmFinish]=useState(false),[settings,setSettings]=useState(false);
   const [decision,setDecision]=useState<'unanswered'|'accepted'|'declined'>('unanswered'),[replacement,setReplacement]=useState<ReplacementActivity|null>(null),[custom,setCustom]=useState(false),[customTitle,setCustomTitle]=useState(''),[createdId,setCreatedId]=useState<number|null>(null),[planOpen,setPlanOpen]=useState(false);
  const [now,setNow]=useState(Date.now()),[notificationPermission,setNotificationPermission]=useState<NotificationPermission>(typeof Notification==='undefined'?'denied':Notification.permission);
  const notifiedAt=useRef<string|null>(null);
  const qc=useQueryClient();
  const today=date===dateToday();
  const session=useGetTrackingSession({date},{query:{queryKey:getGetTrackingSessionQueryKey({date}),refetchInterval:15000}});
  const day=useGetTrackedDay({date},{query:{queryKey:getGetTrackedDayQueryKey({date})}});
  const entries=useListTimeEntries({date});
  const summary=useGetTimeEntriesSummary({date});
  const habits=useListHabits();
  const change=useChangeTrackingSession(),checkin=useCreateTrackingCheckin(),create=useCreateTimeEntry(),update=useUpdateTimeEntry(),remove=useDeleteTimeEntry(),createHabit=useCreateHabit();
  const current=session.data?.session;
  const analysis=useGetTrackedDayAnalysis({date},{query:{enabled:current?.status==='finished' && (day.data?.totalMinutes??0)>0,queryKey:getGetTrackedDayAnalysisQueryKey({date}),retry:1}});
  const remaining=current?.status==='active' && current.nextCheckinAt ? Math.max(0,Math.ceil((new Date(current.nextCheckinAt).getTime()-now)/1000)):null;
  const due=remaining===0;
  const resetView=()=>{setConfirmed(null);setDecision('unanswered');setReplacement(null);setCustom(false);setCreatedId(null);setEdit(null);};
  useEffect(()=>{const t=window.setInterval(()=>setNow(Date.now()),1000);return ()=>window.clearInterval(t)},[]);
  useEffect(()=>{
     if(!today || !due || !current?.nextCheckinAt || notifiedAt.current===current.nextCheckinAt)return;
    notifiedAt.current=current.nextCheckinAt;
    if(typeof Notification!=='undefined' && Notification.permission==='granted')new Notification('حان وقت الاطمئنان على يومك',{body:'اختر النشاط الأقرب لما فعلته. لا حاجة للتفاصيل.'});
  },[due,today,current?.nextCheckinAt]);
  const refresh=async()=>{
    await qc.cancelQueries({queryKey:getGetTrackedDayAnalysisQueryKey({date})});
    qc.removeQueries({queryKey:getGetTrackedDayAnalysisQueryKey({date})});
    await Promise.all([
      qc.invalidateQueries({queryKey:getGetTrackingSessionQueryKey({date})}),
      qc.invalidateQueries({queryKey:getGetTrackedDayQueryKey({date})}),
      qc.invalidateQueries({queryKey:getListTimeEntriesQueryKey({date})}),
      qc.invalidateQueries({queryKey:getGetTimeEntriesSummaryQueryKey({date})}),
      qc.invalidateQueries({queryKey:getGetDashboardTodayQueryKey()}),
    ]);
  };
  const action=async(name:'start'|'pause'|'resume'|'finish'|'interval',value?:15|30)=>{
    try{
      await change.mutateAsync({data:{date,action:name,intervalMinutes:value}});
      if(name==='finish'){setConfirmFinish(false);toast.success('صار يومك جاهزًا للنظر إليه');}
      if(name==='pause')setConfirmPause(false);
      if(name==='interval'){setSettings(false);toast.success('سيُطبّق التغيير على التسجيلات القادمة فقط');}
      await refresh();
    }catch{toast.error('تعذّر تحديث التتبع. حاول مجددًا.')}
  };
  const saveCheckin=async(key:TimeCategory,optionalLabel?:string)=>{
    if(checkin.isPending)return;
    try{
      const result=await checkin.mutateAsync({data:{date,category:key,label:key==='other'?optionalLabel?.trim()||undefined:undefined}});
      setConfirmed(result);setOther('');setSelected('study');await refresh();
      toast.success(`سُجّلت ${duration(result.durationMinutes)} من ${activity(key).name}`);
    }catch{toast.error('تعذّر حفظ النشاط. حاول مجددًا.')}
  };
  const openEdit=(entry:TimeEntry)=>{setEdit(entry);setSelected(entry.category);setOther(entry.category==='other'?entry.label:'');setEditMinutes(entry.durationMinutes);setEditNote(entry.note||'')};
  const saveEdit=async(e:React.FormEvent)=>{
    e.preventDefault();if(!edit || editMinutes<1 || editMinutes>1440)return;
    try{
       const changed=await update.mutateAsync({timeEntryId:edit.id,data:{category:selected,label:selected==='other'?other.trim()||'شيء آخر':activity(selected).name,...(edit.source==='manual'?{durationMinutes:editMinutes}:{}),note:editNote}});
      if(confirmed?.id===edit.id)setConfirmed(changed);
      setEdit(null);await refresh();toast.success('تم تعديل النشاط');
    }catch{toast.error('تعذّر تعديل النشاط')}
  };
  const fallbackReplacements:ReplacementActivity[]=[{title:'القراءة',minutes:10,category:'study'},{title:'المشي',minutes:10,category:'exercise'},{title:'كتابة خاطرة',minutes:10,category:'personal'}];
  const enough=(day.data?.totalMinutes??0)>=60 && (day.data?.entries.length??0)>=3;
  const ready=enough && analysis.data?.status==='ready';
   const proposal=ready?analysis.data?.suggestedChange:null;
  const replacements=ready && analysis.data?.replacements.length?analysis.data.replacements:fallbackReplacements;
   const makeHabit=async()=>{
    const title=(custom?customTitle:replacement?.title||'').trim();
    if(!title){toast.error('اكتب اسمًا للعادة');return}
     setPlanOpen(true);
  };
  const minuteDisplay=remaining===null?'—':`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;
  return <div dir="rtl">
    <PageHead overline="مساحة لملاحظة اليوم" title="وقتي" desc="ليس سباقًا مع الساعة. مجرّد مرآة صغيرة لما عشته اليوم." action={<AddButton onClick={()=>setOpenManual(true)} label="سجّل وقتًا يدويًا"/>}/>
    <div className="mb-7 max-w-xs"><Field label="اليوم الذي تريد رؤيته"><input data-testid="input-time-date" className="field" type="date" max={dateToday()} value={date} onChange={e=>{setDate(e.target.value);resetView()}}/></Field></div>
    {session.isLoading || day.isLoading?<Loading/>:session.isError || day.isError?<ErrorBlock retry={()=>{session.refetch();day.refetch()}}/>:<>
      {!current && today && <section className="rounded-[28px] overflow-hidden bg-[#214e43] text-[#fff9e9] grid lg:grid-cols-[1.1fr_.9fr] mb-9">
        <div className="p-7 md:p-10"><span className="eyebrow !text-[#e6b77b]">بداية خفيفة</span><h2 className="text-3xl md:text-4xl font-black mt-3 leading-[1.45]">وين راح يومك؟</h2><p className="text-[#c9dbcf] leading-8 mt-3 max-w-lg">سجّل يومك لفترة قصيرة، وسنساعدك على رؤية الأنماط التي قد لا تلاحظها بنفسك. لا حكم على أي دقيقة.</p><div className="flex flex-wrap gap-3 mt-7"><button data-testid="button-open-time-intro" className="btn !bg-[#e8b77f] !text-[#20483e] !border-[#e8b77f]" onClick={()=>setOpenIntro(true)}>ابدأ تتبع يومي <ArrowLeft size={17}/></button><button data-testid="button-how-time-works" className="text-sm underline underline-offset-4" onClick={()=>setOpenIntro(true)}>كيف يعمل؟</button></div></div>
        <div className="relative min-h-52 bg-[#346253] flex items-center justify-center overflow-hidden"><div className="absolute w-64 h-64 rounded-full border border-[#a9c3a350]"/><div className="absolute w-44 h-44 rounded-full border border-[#a9c3a360]"/><div className="absolute w-24 h-24 rounded-full bg-[#e6b77b] opacity-80"/><span className="relative font-black text-5xl text-[#214e43]">يومي</span></div>
      </section>}
      {current && <section className={`rounded-[28px] p-6 md:p-9 mb-9 ${current.status==='finished'?'bg-[#e7ead7]':'bg-[#214e43] text-[#fff9e9]'}`}>
        <div className="flex flex-wrap justify-between items-start gap-5"><div><span className={`text-sm font-bold ${current.status==='finished'?'text-[#9d6849]':'text-[#e8ba83]'}`}>{current.status==='active'?'● يومك جارٍ':current.status==='paused'?'يومك في استراحة':'يومك جاهز'}</span><h2 className="text-3xl font-black mt-3">{current.status==='finished'?'دعنا نرى أين ذهب وقتك':current.status==='paused'?'خذ وقتك، عُد حين تشاء':'انظر إلى يومك كما هو'}</h2><p className={`mt-3 ${current.status==='finished'?'muted':'text-[#c9dbcf]'}`}>حتى الآن: <strong>{duration(day.data?.totalMinutes??0)}</strong> من يومك مسجّلة</p></div>
          {current.status==='active'&&<div className="rounded-2xl bg-[#ffffff18] px-7 py-5 text-center min-w-44"><span className="text-sm text-[#d8e4d5]">الاطمئنان القادم بعد</span><div data-testid="text-next-checkin" dir="ltr" className="font-black text-4xl mt-1 tabular-nums">{minuteDisplay}</div></div>}
        </div>
        {current.status==='active' && notificationPermission==='default' && <button data-testid="button-enable-time-notifications" className="text-xs underline underline-offset-4 mt-4 text-[#c9dbcf]" onClick={async()=>{const permission=await Notification.requestPermission();setNotificationPermission(permission)}}>اسمح بتذكير المتصفح أثناء فتح الصفحة</button>}
         {current.status==='finished'&&today&&<button className="btn mt-5" disabled={change.isPending} onClick={()=>action('start',current.intervalMinutes)}>واصل تتبّع يومك</button>}
         {current.status!=='finished'&&<div className="flex flex-wrap gap-2 mt-7 pt-6 border-t border-[#ffffff30]">
          {current.status==='active'?<button data-testid="button-pause-tracking" className="btn !bg-[#e7b77c] !text-[#214e43] !border-[#e7b77c]" onClick={()=>setConfirmPause(true)}><Pause size={16}/> إيقاف مؤقت</button>:<button data-testid="button-resume-tracking" className="btn !bg-[#e7b77c] !text-[#214e43] !border-[#e7b77c]" disabled={change.isPending} onClick={()=>action('resume')}><Play size={16}/> متابعة التتبع</button>}
          <button data-testid="button-tracking-settings" className="btn btn-ghost !text-[#fff9e9] !border-[#ffffff50]" onClick={()=>{setInterval(current.intervalMinutes);setSettings(true)}}><Settings2 size={16}/> مدة التذكير</button>
          <button data-testid="button-finish-tracking" className="btn btn-ghost !text-[#fff9e9] !border-[#ffffff50]" onClick={()=>setConfirmFinish(true)}><Flag size={16}/> أنهِ يومي</button>
        </div>}
      </section>}
      {current?.status==='active' && <section className="paper rounded-[24px] p-5 md:p-8 mb-9">
        <div className="flex items-center justify-between gap-3 mb-4"><div><div className="eyebrow mb-1">{due?'حان وقت الاطمئنان':'تسجيل سريع'}</div><h2 className="text-2xl font-black">{due?'ماذا كنت تفعل؟':'كيف مضت الفترة الأخيرة؟'}</h2></div><span className="badge">{current.intervalMinutes} دقيقة</span></div>
        <p className="muted text-sm mb-5">{due?'اختر الأقرب لما فعلته. يمكنك التعديل لاحقًا.':'يمكنك التسجيل الآن، أو الانتظار حتى يحين التذكير القادم.'}</p>
        {choices(selected,key=>{setSelected(key);if(key!=='other')saveCheckin(key)})}
        {selected==='other'&&<div className="mt-5 panel rounded-2xl p-5"><Field label="ماذا كنت تفعل؟"><input data-testid="input-other-activity" className="field" maxLength={100} value={other} onChange={e=>setOther(e.target.value)} placeholder="اختياري، مثل القراءة"/></Field><div className="flex flex-wrap gap-2 mb-4">{suggestions.map(s=><button data-testid={`button-suggestion-${s}`} key={s} onClick={()=>setOther(s)} className="badge hover:bg-[#dce9dc]">{s}</button>)}</div><button data-testid="button-save-other-checkin" disabled={checkin.isPending} className="btn" onClick={()=>saveCheckin('other',other)}>حفظ النشاط</button></div>}
        {checkin.isPending&&<p role="status" className="muted text-sm mt-4">نحفظ هذه اللحظة...</p>}
        {confirmed&&<div data-testid="status-checkin-confirmed" className="mt-5 rounded-xl bg-[#e3eee0] p-4 flex flex-wrap items-center justify-between gap-3"><span><Check size={17} className="inline ml-2"/> سُجّلت {duration(confirmed.durationMinutes)} من {activity(confirmed.category).name}</span><button data-testid="button-edit-last-checkin" className="font-bold underline" onClick={()=>openEdit(confirmed)}>تعديل</button></div>}
      </section>}
      <div className="grid lg:grid-cols-[1.25fr_.75fr] gap-6 mb-9">
        <section className="paper rounded-[24px] p-5 md:p-7"><SectionTitle label="خريطة ساعاتك" title="أثر اليوم"/>{!day.data?.entries.length?<Empty title="لم تبدأ حكاية هذا اليوم بعد" desc="ابدأ التتبع أو أضف نشاطًا يدويًا، وستظهر الفترات هنا."/>:<div className="space-y-1">{[...day.data.entries].sort((a,b)=>(a.startTime||a.createdAt).localeCompare(b.startTime||b.createdAt)).map(t=><div data-testid={`row-time-entry-${t.id}`} key={t.id} className="flex items-center gap-3 py-3 border-b border-[#eae1d3] last:border-0"><div className="w-1 self-stretch rounded-full" style={{background:activity(t.category).color}}/><span className="text-xl">{activity(t.category).icon}</span><div className="flex-1 min-w-0"><strong className="block truncate">{t.source==='manual'||t.category==='other'?t.label:activity(t.category).name}</strong><span className="text-xs muted" dir="auto">{t.startTime?`${clock(t.startTime)} – ${clock(t.endTime)}`:t.source==='manual'?'إضافة يدوية':'وقت مسجّل'}{t.note?` · ${t.note}`:''}</span></div><span className="text-sm font-bold whitespace-nowrap">{duration(t.durationMinutes)}</span><button data-testid={`button-edit-entry-${t.id}`} aria-label="تعديل النشاط" onClick={()=>openEdit(t)} className="p-2 text-[#426a56]"><Pencil size={16}/></button><button data-testid={`button-delete-entry-${t.id}`} aria-label="حذف النشاط" onClick={()=>{if(confirm('هل تريد حذف هذا النشاط؟'))remove.mutate({timeEntryId:t.id},{onSuccess:()=>{setConfirmed(null);refresh();toast.success('حُذف النشاط')},onError:()=>toast.error('تعذّر الحذف')})}} className="p-2 text-[#ac6e59]"><Trash2 size={16}/></button></div>)}</div>}</section>
        <section className="rounded-[24px] bg-[#eddbc0] p-6 md:p-8"><Clock3 size={25} className="text-[#9b6b4d] mb-6"/><div data-testid="text-tracked-total" className="text-4xl font-black">{duration(day.data?.totalMinutes??0)}</div><p className="text-[#6b7667] mt-2">من الوقت الذي اخترت تسجيله</p>{(day.data?.totalMinutes??0)>0 && <><div className="h-3 flex rounded-full overflow-hidden mt-7 bg-[#dacbad]">{day.data?.categories.map(c=><div key={c.category} style={{width:`${c.percentage}%`,background:activity(c.category).color}} title={`${activity(c.category).name}: ${c.percentage}%`}/>)}</div><div className="space-y-3 mt-6">{day.data?.categories.map(c=><div key={c.category} className="flex items-center gap-2 text-sm"><span>{activity(c.category).icon}</span><span className="flex-1">{activity(c.category).name}</span><strong>{duration(c.minutes)}</strong><span className="text-[#7e8374] w-12 text-left">{Math.round(c.percentage)}%</span></div>)}</div><div className="border-t border-[#cbb996] mt-6 pt-4"><strong className="text-sm">أكثر ثلاث فئات حضورًا</strong><p className="text-sm mt-2 leading-7">{day.data?.topCategories.slice(0,3).map(x=>activity(x.category).name).join(' · ')}</p></div></>}{(day.data?.totalMinutes??0)>0 && current?.status!=='finished'&&<p className="text-xs mt-5 text-[#7b715c]">هذه صورة جزئية لليوم، وليست اليوم كله.</p>}</section>
      </div>
      {current?.status==='finished' && <section className="paper rounded-[24px] p-6 md:p-8 mb-9">
        <SectionTitle label="قراءة لطيفة ليومك" title="ما الذي لاحظناه؟"/>
        {!day.data?.totalMinutes?<p className="muted">لم تُسجّل أنشطة كافية بعد. يمكنك إضافة وقت يدويًا إن أردت.</p>:analysis.isLoading?<div role="status"><p className="mb-4">ننظر إلى يومك...</p><Loading/></div>:!enough || analysis.data?.status==='insufficient'?<div className="panel rounded-2xl p-6"><h3 className="text-xl font-bold">ما زلنا نتعرّف على إيقاع يومك</h3><p className="muted mt-2">التسجيلات الحالية لا تكفي لاستخلاص نمط مفيد. لا حاجة لاستكمال يوم كامل؛ يمكنك العودة للتتبع في يوم آخر.</p></div>:<>
          {analysis.isError&&<div className="panel rounded-2xl p-4 mb-5"><p className="text-sm">تعذّرت قراءة المدرّب ليومك، لذا نعرض ملاحظة بسيطة من الأرقام المسجّلة فقط.</p><button data-testid="button-retry-time-analysis" onClick={()=>analysis.refetch()} className="underline text-sm font-bold mt-2 flex items-center gap-1"><RotateCcw size={14}/> إعادة المحاولة</button></div>}
          {ready?<><h3 className="text-2xl font-black">{analysis.data?.headline}</h3><p className="leading-8 mt-3">{analysis.data?.observation}</p><p className="muted leading-8 mt-2">{analysis.data?.pattern}</p><p className="mt-3 font-semibold">{analysis.data?.opportunity}</p></>:<><h3 className="text-xl font-black">هنا صورة ما سجّلته</h3><p className="leading-8 mt-3">{proposal?'أخذ التواصل الرقمي وقتًا ملحوظًا اليوم. قد تكون تجربة تغيير ٢٠ دقيقة فقط نقطة بداية مريحة، إن أحببت.':'هذه حصيلة وقتك المسجّل، لكن لا يمكننا استنتاج نمط محدد منها الآن. يمكنك العودة إليها متى شئت.'}</p></>}
          {proposal&&<div className="rounded-2xl bg-[#e8eee2] p-5 mt-7"><span className="eyebrow">تجربة صغيرة، لا قاعدة</span><h3 className="text-xl font-bold mt-2">هل تريد تجربة تقليل {duration(proposal.minutes)} من {activity(proposal.category).name}؟</h3><p className="muted text-sm mt-2">لا تحتاج إلى إلغاء النشاط كله. القرار لك.</p>{decision==='unanswered'?<div className="flex flex-wrap gap-2 mt-5"><button data-testid="button-accept-reduction" className="btn" onClick={()=>setDecision('accepted')}>نعم، لنجرّب</button><button data-testid="button-decline-reduction" className="btn btn-light" onClick={()=>setDecision('declined')}>ليس الآن</button></div>:decision==='declined'?<p role="status" className="mt-4 text-sm">لا بأس. الملاحظة وحدها خطوة جميلة. <button className="underline" onClick={()=>setDecision('unanswered')}>غيّرت رأيي</button></p>:<div className="mt-6"><strong>بماذا تحب أن تستبدل بعض هذه الدقائق؟</strong><div className="grid sm:grid-cols-3 gap-2 mt-3">{replacements.map((r,i)=><button data-testid={`button-replacement-${i}`} key={`${r.title}-${i}`} className={`rounded-xl border p-4 text-right ${replacement===r && !custom?'bg-[#d2e6d6] border-[#367359]':'bg-[#faf8ef] border-[#e1dfd0]'}`} onClick={()=>{setReplacement(r);setCustom(false)}}><span className="text-xl ml-2">{activity(r.category).icon}</span><strong>{r.title}</strong><small className="block muted mt-2">{duration(r.minutes)}</small></button>)}</div><button data-testid="button-custom-replacement" className="underline font-bold text-sm mt-4" onClick={()=>{setCustom(true);setReplacement(null)}}>أريد اختيار شيء آخر</button>{custom&&<Field label="ما العادة التي تريد تجربتها؟"><input data-testid="input-custom-habit" className="field mt-3" value={customTitle} maxLength={100} onChange={e=>setCustomTitle(e.target.value)} placeholder="مثلاً: أقرأ بضع صفحات"/></Field>}{(replacement||custom)&&<div className="mt-5 panel rounded-xl p-4"><p className="text-sm">بداية صغيرة: <strong>{custom?customTitle||'عادتك الجديدة':replacement?.title}</strong> · {Math.min(10,Math.max(5,replacement?.minutes||10))} دقائق يوميًا. يمكنك تعديلها لاحقًا من صفحة العادة.</p>{createdId?<Link data-testid="link-created-habit" href={`/habits/${createdId}`} className="btn mt-4">اذهب إلى عادتك <ArrowLeft size={16}/></Link>:<button data-testid="button-create-replacement-habit" disabled={createHabit.isPending || (custom && !customTitle.trim())} className="btn mt-4" onClick={makeHabit}>{createHabit.isPending?'نضيف خطوتك...':'ابدأ عادة صغيرة'} <ArrowLeft size={16}/></button>}</div>}</div>}</div>}
        </>}
      </section>}
      <section className="mt-9"><SectionTitle label="مكان لكل التفاصيل" title="سجلاتك اليدوية" action={<AddButton onClick={()=>setOpenManual(true)} label="إضافة وقت"/>}/>{entries.isLoading||summary.isLoading?<Loading/>:entries.isError||summary.isError?<ErrorBlock retry={()=>{entries.refetch();summary.refetch()}}/>:<div className="panel rounded-2xl p-5"><strong>إجمالي السجلات: {duration(summary.data?.totalMinutes??0)}</strong><p className="muted text-sm mt-2">{entries.data?.filter(x=>x.source==='manual').length||0} أنشطة أُضيفت يدويًا · يمكنك تعديلها أو حذفها من خريطة اليوم أعلاه.</p>{summary.data?.byHabit.length? <div className="border-t border-[#ded6c7] mt-4 pt-3 space-y-2">{summary.data.byHabit.map((x,i)=><div key={i} className="flex justify-between text-sm"><span>{x.label}</span><b>{duration(x.minutes)}</b></div>)}</div>:null}</div>}</section>
    </>}
    {planOpen&&<Modal title="اختر بداية عادتك" onClose={()=>setPlanOpen(false)}><HabitPlanForm seed={{title:(custom?customTitle:replacement?.title)||'',minutes:replacement?.minutes||10,emoji:activity(custom?'personal':replacement?.category||'personal').icon,category:(custom?'mindfulness':replacement?.category==='study'?'learning':replacement?.category==='exercise'?'health':replacement?.category==='work'?'productivity':'custom') as HabitInput['category']}} onSaved={id=>{setCreatedId(id);setPlanOpen(false);qc.invalidateQueries({queryKey:getListHabitsQueryKey()});qc.invalidateQueries({queryKey:getGetDashboardTodayQueryKey()})}}/></Modal>}
    {openIntro&&<Modal title="لنتعرّف على يومك" onClose={()=>setOpenIntro(false)}><div className="text-center py-3"><div className="text-5xl mb-4">🕐</div><h3 className="text-2xl font-black">15 دقيقة تكفي</h3><p className="muted leading-8 mt-3">كل فترة قصيرة نسألك ماذا كنت تفعل. لا تحتاج إلى كتابة شيء؛ اختر النشاط الأقرب فقط. يمكنك الإيقاف أو تغيير المدة متى شئت.</p><div className="text-[#be8e5b] text-2xl tracking-widest my-5">● ● ● ● ●</div></div><div className="flex gap-3"><button data-testid="button-intro-next" className="btn flex-1" onClick={()=>{setOpenIntro(false);setSettings(true)}}>ابدأ الآن</button><button data-testid="button-intro-later" className="btn btn-light" onClick={()=>setOpenIntro(false)}>لاحقًا</button></div></Modal>}
    {settings&&<Modal title={current?'مدة الاطمئنان':'كيف تريد تتبّع يومك؟'} onClose={()=>setSettings(false)}><p className="muted mb-5">اختر الإيقاع الذي يناسبك. لا نغيّر شيئًا مما سجّلته سابقًا.</p><div className="space-y-3 mb-6">{([15,30] as const).map(n=><button data-testid={`button-interval-${n}`} key={n} onClick={()=>setInterval(n)} className={`w-full text-right rounded-2xl border p-5 ${interval===n?'bg-[#e1eddf] border-[#327259]':'bg-[#faf7ef] border-[#e7dfcd]'}`}><strong>كل {n} دقيقة</strong><p className="muted text-sm mt-1">{n===15?'صورة أدق عن يومك.':'تتبّع أخف وأقل إزعاجًا.'}</p></button>)}</div><button data-testid="button-save-interval" disabled={change.isPending} className="btn w-full" onClick={()=>action(current?'interval':'start',interval)}>{change.isPending?'لحظة واحدة...':current?'حفظ المدة القادمة':'ابدأ يومي'}</button><p className="muted text-xs mt-4">تذكيرات المتصفح تظهر فقط إذا منحتها الإذن وكانت الصفحة مفتوحة؛ لا نعتمد عليها في الخلفية.</p></Modal>}
    {confirmPause&&<Modal title="استراحة قصيرة؟" onClose={()=>setConfirmPause(false)}><p className="muted mb-6">هل تريد إيقاف التتبّع مؤقتًا؟ يمكنك العودة من حيث توقفت.</p><div className="flex gap-2"><button data-testid="button-confirm-pause" disabled={change.isPending} className="btn" onClick={()=>action('pause')}>إيقاف مؤقت</button><button className="btn btn-light" onClick={()=>setConfirmPause(false)}>إلغاء</button></div></Modal>}
    {confirmFinish&&<Modal title="هل نطوي صفحة اليوم؟" onClose={()=>setConfirmFinish(false)}><p className="muted mb-6">سنرتّب ما سجّلته لنرى صورة اليوم، كما هي. لن يُضاف وقت لم تسجّله.</p><div className="flex gap-2"><button data-testid="button-confirm-finish" disabled={change.isPending} className="btn" onClick={()=>action('finish')}>اعرض يومي</button><button className="btn btn-light" onClick={()=>setConfirmFinish(false)}>العودة</button></div></Modal>}
     {edit&&<Modal title="تعديل النشاط" onClose={()=>setEdit(null)}><form onSubmit={saveEdit}>{choices(selected,setSelected)}{selected==='other'&&<Field label="اسم النشاط"><input data-testid="input-edit-other" className="field mt-4" maxLength={100} value={other} onChange={e=>setOther(e.target.value)}/></Field>}<div className="mt-5">{edit.source==='manual'?<Field label="المدة بالدقائق"><input data-testid="input-edit-duration" className="field" type="number" min="1" max="1440" required value={editMinutes} onChange={e=>setEditMinutes(Number(e.target.value))}/></Field>:<p className="muted text-sm mb-4">مدة التسجيل محفوظة كما رُصدت؛ يمكنك تصحيح النشاط والملاحظة.</p>}<Field label="ملاحظة (اختياري)"><textarea data-testid="input-edit-note" className="field" value={editNote} onChange={e=>setEditNote(e.target.value)}/></Field></div><button data-testid="button-save-edited-time" disabled={update.isPending} className="btn w-full">حفظ التعديل</button></form></Modal>}
    {openManual&&<Modal title="وقت يستحق أن يُحفظ" onClose={()=>setOpenManual(false)}><form onSubmit={async e=>{e.preventDefault();try{await create.mutateAsync({data:{label,durationMinutes:minutes,date,habitId:habitId?Number(habitId):undefined,note}});await refresh();setOpenManual(false);setLabel('');setNote('');toast.success('حُفظ وقتك')}catch{toast.error('تعذّر حفظ الوقت')}}}><Field label="بماذا قضيت وقتك؟"><input data-testid="input-manual-label" className="field" required value={label} onChange={e=>setLabel(e.target.value)} placeholder="قراءة، مشي، تعلّم..."/></Field><Field label="المدة بالدقائق"><input data-testid="input-manual-minutes" type="number" min="1" max="1440" className="field" value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></Field><Field label="عادة مرتبطة (اختياري)"><select data-testid="select-manual-habit" className="field" value={habitId} onChange={e=>setHabitId(e.target.value)}><option value="">بلا عادة محددة</option>{habits.data?.map(h=><option key={h.id} value={h.id}>{h.title}</option>)}</select></Field><Field label="ملاحظة (اختياري)"><textarea data-testid="input-manual-note" className="field" value={note} onChange={e=>setNote(e.target.value)}/></Field><button data-testid="button-save-manual-time" className="btn" disabled={create.isPending}>حفظ الوقت</button></form></Modal>}
  </div>;
}