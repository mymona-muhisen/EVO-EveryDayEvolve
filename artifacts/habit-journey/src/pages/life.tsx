import { useState } from 'react';
import { Link } from 'wouter';
import { useListMemories, getListMemoriesQueryKey, type Memory } from '@workspace/api-client-react';
import { PageHead, Empty, Loading, ErrorBlock, arDate } from '@/components/journey-ui';
import { MemoryImage, MemoryDetailDialog, memoryText } from '@/components/memory/memory';
import { memoryDayHref } from '@/lib/memory-navigation';

export { TimePage } from './time-awareness';

export function MemoriesPage(){
  const q=useListMemories({},{query:{queryKey:getListMemoriesQueryKey({}),refetchOnMount:'always',refetchOnWindowFocus:true}});
  const [sel,setSel]=useState<Memory|null>(null);
  const current=sel?q.data?.find(m=>m.id===sel.id)??null:null;
  return <><PageHead overline="سجل ثانوي" title="ذكريات من رحلاتي" desc="افتح أي ذكرى للعودة إلى يومها على الخريطة. تُضاف الذكرى من يوم أنجزته، لا من معرض مستقل." action={<Link href="/journey" className="btn btn-light min-h-11">إلى خريطة الرحلة</Link>}/>
    {q.isLoading?<Loading/>:q.isError?<ErrorBlock retry={()=>q.refetch()}/>:!q.data?.length?<Empty title="لا ذكريات محفوظة بعد" desc="أكمل يومًا في رحلتك، ثم أضف ذكرى اختيارية من تفاصيل ذلك اليوم." action={<Link href="/journey" className="btn min-h-11">افتح الرحلة</Link>}/>
    :<div className="columns-1 md:columns-2 xl:columns-3 gap-5">{q.data.map((m,i)=>{
      const href=memoryDayHref(m);
      const content=<>{m.photoUrl&&<MemoryImage photoUrl={m.photoUrl} retryable={false} className="w-full h-[240px]"/>}
        <div className="p-5"><span className="eyebrow">{href?`اليوم ${m.dayNumber} · `:''}{arDate(m.date.slice(0,10))}</span>
          {memoryText(m)&&<p className="text-lg leading-8 mt-2 whitespace-pre-wrap break-words">{memoryText(m)}</p>}
          <span className="badge mt-3">{href?m.habitTitle||'يوم من رحلتك':'ذكرى قديمة غير مرتبطة بيوم محدد'}</span>
          {href&&<span className="block text-sm underline mt-3">افتح يوم الذكرى في الرحلة</span>}</div></>;
      return <article key={m.id} data-testid={`card-memory-${m.id}`} className="paper rounded-[22px] overflow-hidden mb-5 break-inside-avoid rise" style={{animationDelay:`${i*65}ms`}}>
        {href?<Link href={href} className="block w-full text-start min-h-11">{content}</Link>:<button type="button" className="block w-full text-start" onClick={()=>setSel(m)} aria-label="فتح الذكرى القديمة">{content}</button>}
      </article>;
    })}</div>}
    {current&&<MemoryDetailDialog key={current.id} memory={current} onClose={()=>setSel(null)}/>}
  </>;
}
