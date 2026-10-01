import { useState } from 'react';
import { useListHabits, useListMemories, type Habit, type Memory } from '@workspace/api-client-react';
import { PageHead, Empty, Loading, ErrorBlock, AddButton, arDate } from '@/components/journey-ui';
import { MemoryImage, MemoryDetailDialog, MemoryDayChooser, memoryText } from '@/components/memory/memory';

export { TimePage } from './time-awareness';

export function MemoriesPage(){
  const q=useListMemories(),habits=useListHabits();
  const [choose,setChoose]=useState(false),[sel,setSel]=useState<Memory|null>(null);
  const current=sel?q.data?.find(m=>m.id===sel.id)??null:null;
  return <><PageHead overline="دفتر الطريق" title="ذكرياتي" desc="بعض الأيام تستحق أكثر من علامة صح. صور خاصة بك وحدك، من أيام أنجزتها." action={<AddButton onClick={()=>setChoose(true)} label="ذكرى جديدة"/>}/>
    {q.isLoading?<Loading/>:q.isError?<ErrorBlock retry={()=>q.refetch()}/>:!q.data?.length?<Empty title="دفترك ينتظر أول حكاية" desc="بعد يوم تنجزه، التقط لحظة صغيرة وستبقى هنا." action={<AddButton onClick={()=>setChoose(true)} label="أضف ذكرى"/>}/>
    :<div className="columns-1 md:columns-2 xl:columns-3 gap-5">{q.data.map((m,i)=><article key={m.id} data-testid={`card-memory-${m.id}`} className="paper rounded-[22px] overflow-hidden mb-5 break-inside-avoid rise" style={{animationDelay:`${i*65}ms`}}>
      <button type="button" className="block w-full text-start" onClick={()=>setSel(m)} aria-label="فتح الذكرى">
        {m.photoUrl&&<MemoryImage photoUrl={m.photoUrl} className="w-full h-[240px]"/>}
        <div className="p-5"><span className="eyebrow">{m.dayNumber?`اليوم ${m.dayNumber} · `:''}{arDate(m.date.slice(0,10))}</span>
          {memoryText(m)&&<p className="text-lg leading-8 mt-2 whitespace-pre-wrap break-words">{memoryText(m)}</p>}
          <span className="badge mt-3">{m.habitTitle||habits.data?.find((h:Habit)=>h.id===m.habitId)?.title||(m.habitDayId?'عادة من رحلتك':'ذكرى سابقة')}</span></div>
      </button></article>)}</div>}
    {choose&&<MemoryDayChooser onClose={()=>setChoose(false)}/>}
    {current&&<MemoryDetailDialog key={current.id} memory={current} onClose={()=>setSel(null)}/>}
  </>;
}
