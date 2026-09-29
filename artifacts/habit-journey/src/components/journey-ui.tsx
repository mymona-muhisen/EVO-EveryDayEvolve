import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Home, ListChecks, Clock3, Images, Gift, Map, Users, Settings, Coins, ArrowLeft, Plus, Compass, Sparkles } from 'lucide-react';
import type { User } from '@workspace/api-client-react';

export const categories: Record<string,string> = { health:'الصحة', learning:'التعلّم', productivity:'الإنتاجية', mindfulness:'الصفاء الذهني', social:'العلاقات', creativity:'الإبداع', finance:'المال', custom:'شيء آخر' };
export const styles: Record<string,string> = { encouraging:'مشجّع ولطيف', tough_love:'صريح وحازم', data_driven:'يركّز على الأرقام' };
export const dateToday = () => new Date().toLocaleDateString('en-CA');
export const arDate = (date:string) => new Date(date + (date.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('ar-EG-u-nu-latn',{day:'numeric',month:'long',year:'numeric'});
export function SectionTitle({label,title,action}: {label?:string,title:string,action?:ReactNode}) { return <div className="flex items-end justify-between gap-4 mb-5"><div>{label && <div className="eyebrow mb-1">{label}</div>}<h2 className="text-[24px] md:text-[29px] font-extrabold leading-tight m-0">{title}</h2></div>{action}</div>; }
export function Empty({title,desc,action}: {title:string,desc:string,action?:ReactNode}) { return <div className="paper rounded-[22px] p-9 text-center"><div className="w-14 h-14 rounded-full bg-[#e5eadc] flex items-center justify-center mx-auto mb-4"><Compass size={26}/></div><h3 className="text-xl font-bold">{title}</h3><p className="muted mt-1 mb-5">{desc}</p>{action}</div>; }
export function Loading() { return <div className="space-y-4"><div className="skeleton h-28 w-full"/><div className="skeleton h-20 w-full"/><div className="skeleton h-20 w-4/5"/></div>; }
export function ErrorBlock({retry}: {retry:()=>void}) { return <Empty title="تعذّر تحميل هذه الصفحة" desc="حدث انقطاع بسيط. لنحاول مرة أخرى." action={<button className="btn" onClick={retry}>إعادة المحاولة</button>}/>; }
export function PageHead({overline,title,desc,action}: {overline:string,title:string,desc?:string,action?:ReactNode}) { return <header className="mb-9 flex flex-col md:flex-row md:items-end justify-between gap-4"><div><div className="eyebrow mb-2">{overline}</div><h1 className="text-[34px] md:text-[42px] font-extrabold tracking-tight leading-[1.3] m-0">{title}</h1>{desc && <p className="muted mt-2 max-w-lg">{desc}</p>}</div>{action}</header>; }
export function Modal({title,children,onClose}: {title:string,children:ReactNode,onClose:()=>void}) { return <div className="fixed inset-0 z-50 bg-[#102f2ac2] backdrop-blur-[5px] flex items-center justify-center p-4" onMouseDown={onClose}><div role="dialog" aria-modal="true" className="paper rounded-[24px] p-5 md:p-7 w-full max-w-xl max-h-[90dvh] overflow-auto page-enter" onMouseDown={e=>e.stopPropagation()}><div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold">{title}</h2><button onClick={onClose} className="btn btn-light !px-3" aria-label="إغلاق">×</button></div>{children}</div></div>; }
export function Field({label,children}: {label:string,children:ReactNode}) { return <label className="block mb-4"><span className="block text-sm font-bold mb-2">{label}</span>{children}</label>; }
const nav = [
  {href:'/home',label:'اليوم',icon:Home},{href:'/habits',label:'عاداتي',icon:ListChecks},{href:'/time',label:'وقتي',icon:Clock3},{href:'/memories',label:'ذكرياتي',icon:Images},
  {href:'/rewards',label:'المكافآت',icon:Gift},{href:'/journey',label:'رحلتي',icon:Map},{href:'/groups',label:'المجموعات',icon:Users},{href:'/settings',label:'الإعدادات',icon:Settings}
];
export function Shell({user,children}: {user:User,children:ReactNode}) {
  const [location] = useLocation();
  return <div className="min-h-[100dvh] md:flex">
    <aside className="hidden md:flex w-[245px] shrink-0 bg-[#1e493f] text-[#f6ead2] min-h-[100dvh] sticky top-0 h-[100dvh] flex-col px-4 py-7">
      <Link href="/home" className="flex items-center gap-3 px-4 mb-9"><img src={`${import.meta.env.BASE_URL}logo.svg`} className="w-10 h-10" alt="شعار رحلة العادة"/><span className="font-black text-xl" style={{fontFamily:'Cairo'}}>رحلة العادة</span></Link>
      <div className="px-4 text-[#a9c8b6] text-xs font-bold mb-3">مساحتك الخاصة</div>
      <nav className="space-y-1">{nav.map(({href,label,icon:Icon})=><Link key={href} href={href} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${location===href || (href==='/habits'&&location.startsWith('/habits/')) ? 'bg-[#e2ad73] text-[#1d463b] font-bold shadow-sm' : 'text-[#d7e4d8] hover:bg-[#356052]'}`}><Icon size={19} strokeWidth={1.8}/>{label}</Link>)}</nav>
      <div className="mt-auto px-3"><div className="border-t border-[#477266] pt-5 flex items-center gap-3"><span className="w-10 h-10 rounded-full bg-[#e4ae73] flex items-center justify-center text-xl">{user.avatarEmoji}</span><div className="min-w-0"><div className="font-bold truncate">{user.displayName}</div><div className="text-xs text-[#a9c8b6]">المستوى {user.level}</div></div></div></div>
    </aside>
    <div className="flex-1 min-w-0">
      <header className="h-16 md:h-20 border-b border-[#e8dfcb] flex items-center justify-between px-5 md:px-11 bg-[#fbf7ed]">
        <div className="flex items-center gap-3 md:hidden"><img src={`${import.meta.env.BASE_URL}logo.svg`} className="w-8 h-8" alt="شعار رحلة العادة"/><strong style={{fontFamily:'Cairo'}}>رحلة العادة</strong></div>
        <div className="hidden md:flex items-center gap-2 text-sm muted"><Sparkles size={17} className="text-[#c87953]"/> كل يوم، خطوة أقرب إلى نفسك</div>
        <div className="flex items-center gap-3"><span className="badge !bg-[#f6e5bf]"><Coins size={15}/> {user.coins} عملة</span><Link href="/settings" className="hidden md:flex items-center gap-2 text-sm font-semibold hover:opacity-70">{user.displayName}<ArrowLeft size={14}/></Link></div>
      </header>
      <main className="max-w-[1270px] mx-auto px-5 md:px-11 pt-8 md:pt-10 pb-28 md:pb-14 page-enter">{children}</main>
    </div>
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[#1e493f] border-t border-[#426b5d] flex justify-around px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]">{nav.filter(x=>['/home','/habits','/rewards','/journey','/settings'].includes(x.href)).map(({href,label,icon:Icon})=><Link key={href} href={href} className={`flex flex-col items-center gap-1 text-[10px] px-2 py-1 ${location===href?'text-[#f0bc82]':'text-[#c2d4c8]'}`}><Icon size={21}/>{label}</Link>)}</nav>
  </div>;
}
export function AddButton({onClick,label}: {onClick:()=>void,label:string}) { return <button className="btn" onClick={onClick}><Plus size={17}/>{label}</button>; }