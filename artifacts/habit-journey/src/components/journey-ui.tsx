import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Home, ListChecks, Clock3, Images, Gift, Map, Users, Settings, Coins, ArrowLeft, Plus, Compass, Sparkles, UserRoundCheck, MoreHorizontal, X } from 'lucide-react';
import { NotificationBell } from '@/components/social/social-common';
import type { User } from '@workspace/api-client-react';

export const categories: Record<string,string> = { health:'الصحة', learning:'التعلّم', productivity:'الإنتاجية', mindfulness:'الصفاء الذهني', social:'العلاقات', creativity:'الإبداع', finance:'المال', custom:'شيء آخر' };
export const styles: Record<string,string> = { encouraging:'مشجّع ولطيف', tough_love:'صريح وحازم', data_driven:'يركّز على الأرقام' };
export const dateToday = (timezone?: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toLocaleDateString('en-CA');
  }
};
export const arDate = (date:string) => new Date(date + (date.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('ar-EG-u-nu-latn',{day:'numeric',month:'long',year:'numeric'});
export function SectionTitle({label,title,action}: {label?:string,title:string,action?:ReactNode}) { return <div className="flex items-end justify-between gap-4 mb-5"><div>{label && <div className="eyebrow mb-1">{label}</div>}<h2 className="text-[24px] md:text-[29px] font-extrabold leading-tight m-0">{title}</h2></div>{action}</div>; }
export function Empty({title,desc,action}: {title:string,desc:string,action?:ReactNode}) { return <div className="paper rounded-[22px] p-9 text-center"><div className="w-14 h-14 rounded-full bg-[#e5eadc] flex items-center justify-center mx-auto mb-4"><Compass size={26}/></div><h3 className="text-xl font-bold">{title}</h3><p className="muted mt-1 mb-5">{desc}</p>{action}</div>; }
export function Loading() { return <div className="space-y-4"><div className="skeleton h-28 w-full"/><div className="skeleton h-20 w-full"/><div className="skeleton h-20 w-4/5"/></div>; }
export function ErrorBlock({retry}: {retry:()=>void}) { return <Empty title="تعذّر تحميل هذه الصفحة" desc="حدث انقطاع بسيط. لنحاول مرة أخرى." action={<button className="btn" onClick={retry}>إعادة المحاولة</button>}/>; }
export function PageHead({overline,title,desc,action}: {overline:string,title:string,desc?:string,action?:ReactNode}) { return <header className="mb-9 flex flex-col md:flex-row md:items-end justify-between gap-4"><div><div className="eyebrow mb-2">{overline}</div><h1 className="text-[34px] md:text-[42px] font-extrabold tracking-tight leading-[1.3] m-0">{title}</h1>{desc && <p className="muted mt-2 max-w-lg">{desc}</p>}</div>{action}</header>; }
export function Modal({title,children,onClose}: {title:string,children:ReactNode,onClose:()=>void}) { return <div className="fixed inset-0 z-50 bg-[#102f2ac2] backdrop-blur-[5px] flex items-center justify-center p-4" onMouseDown={onClose}><div role="dialog" aria-modal="true" className="paper rounded-[24px] p-5 md:p-7 w-full max-w-xl max-h-[90dvh] overflow-auto page-enter" onMouseDown={e=>e.stopPropagation()}><div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold">{title}</h2><button onClick={onClose} className="btn btn-light !px-3" aria-label="إغلاق">×</button></div>{children}</div></div>; }
export function Field({label,children}: {label:string,children:ReactNode}) { return <label className="block mb-4"><span className="block text-sm font-bold mb-2">{label}</span>{children}</label>; }
const nav = [
  {href:'/home',label:'اليوم',icon:Home},{href:'/time',label:'وقتي',icon:Clock3},{href:'/habits',label:'عاداتي',icon:ListChecks},{href:'/journey',label:'رحلتي',icon:Map},
  {href:'/character',label:'الشخصية والمتجر',icon:Sparkles},{href:'/rewards',label:'المكافآت',icon:Gift},{href:'/friends',label:'الأصدقاء',icon:UserRoundCheck},{href:'/memories',label:'ذكريات الرحلات',icon:Images},{href:'/groups',label:'المجموعات',icon:Users},{href:'/settings',label:'الإعدادات',icon:Settings}
];
const mobilePrimary = new Set(['/home', '/time', '/habits', '/journey']);
const navActive = (location: string, href: string) => location === href
  || (href === '/friends' && location.startsWith('/friends/'))
  || (href === '/journey' && /^\/habits\/\d+\/journey/.test(location))
  || (href === '/habits' && location.startsWith('/habits/') && !location.includes('/journey'));
function timeGreeting(timezone?: string) {
  let hour = new Date().getHours();
  try { hour = Number(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())); } catch { /* Use local time when a legacy timezone is invalid. */ }
  return hour >= 5 && hour < 12 ? 'صباح الخير' : hour >= 12 && hour < 21 ? 'مساء الخير' : 'ليلة هادئة';
}
export function Shell({user,children}: {user:User,children:ReactNode}) {
  const [location] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreDialog = useRef<HTMLDialogElement>(null);
  const [greeting, setGreeting] = useState(() => timeGreeting(user.timezone));
  useEffect(() => {
    const update = () => setGreeting(timeGreeting(user.timezone));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [user.timezone]);
  useEffect(() => { setMoreOpen(false); }, [location]);
  useEffect(() => {
    const dialog = moreDialog.current;
    if (!dialog) return;
    if (moreOpen && !dialog.open) dialog.showModal();
    else if (!moreOpen && dialog.open) dialog.close();
  }, [moreOpen]);
  const secondary = nav.filter(item => !mobilePrimary.has(item.href));
  return <div className="min-h-[100dvh] md:flex">
    <aside className="hidden md:flex w-[245px] shrink-0 bg-[#1e493f] text-[#f6ead2] min-h-[100dvh] sticky top-0 h-[100dvh] flex-col px-4 py-7">
      <Link href="/home" className="flex items-center gap-3 px-4 mb-9"><img src={`${import.meta.env.BASE_URL}logo.svg`} className="w-10 h-10" alt="شعار رحلة العادة"/><span className="font-black text-xl" style={{fontFamily:'Cairo'}}>رحلة العادة</span></Link>
      <div className="px-4 text-[#a9c8b6] text-xs font-bold mb-3">مساحتك الخاصة</div>
      <nav aria-label="التنقل الرئيسي" className="flex-1 min-h-0 space-y-1 overflow-y-auto">{nav.map(({href,label,icon:Icon})=><Link key={href} href={href} aria-current={navActive(location,href)?'page':undefined} className={`flex items-center gap-3 px-4 py-3 min-h-11 rounded-xl transition-all focus-visible:outline-2 focus-visible:outline-offset-2 ${navActive(location,href) ? 'bg-[#e2ad73] text-[#1d463b] font-bold shadow-sm' : 'text-[#d7e4d8] hover:bg-[#356052]'}`}><Icon aria-hidden="true" size={19} strokeWidth={1.8}/>{label}</Link>)}</nav>
      <div className="mt-auto px-3"><div className="border-t border-[#477266] pt-5 flex items-center gap-3"><span className="w-10 h-10 rounded-full bg-[#e4ae73] flex items-center justify-center text-xl">{user.avatarEmoji}</span><div className="min-w-0"><div className="font-bold truncate">{user.displayName}</div><div className="text-xs text-[#a9c8b6]">المستوى {user.level}</div></div></div></div>
    </aside>
    <div className="flex-1 min-w-0">
      <header className="h-16 md:h-20 border-b border-[#e8dfcb] flex items-center justify-between px-5 md:px-11 bg-[#fbf7ed]">
        <div className="flex items-center gap-2 min-w-0"><img src={`${import.meta.env.BASE_URL}logo.svg`} className="w-8 h-8 shrink-0 md:hidden" alt="شعار رحلة العادة"/><span className="truncate text-sm font-semibold">{greeting}، {user.displayName.trim().split(/\s+/)[0]}</span></div>
        <div className="flex items-center gap-2 shrink-0"><NotificationBell/><span className="badge !bg-[#f6e5bf] hidden sm:inline-flex"><Coins aria-hidden="true" size={15}/> {user.coins} عملة</span><Link href="/character" aria-label="تخصيص شخصيتي" title="تخصيص شخصيتي" className="inline-flex items-center justify-center min-w-11 min-h-11 rounded-full bg-[#e5eadc] hover:bg-[#d5e1cc] focus-visible:outline-2 focus-visible:outline-offset-2"><Sparkles aria-hidden="true" size={20}/></Link><Link href="/settings" className="hidden md:flex items-center gap-2 text-sm font-semibold hover:opacity-70">{user.displayName}<ArrowLeft aria-hidden="true" size={14}/></Link></div>
      </header>
      <main className="max-w-[1270px] mx-auto px-5 md:px-11 pt-8 md:pt-10 pb-28 md:pb-14 page-enter">{children}</main>
    </div>
    <nav aria-label="التنقل على الهاتف" className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[#1e493f] border-t border-[#426b5d] flex justify-around px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]">{nav.filter(x=>mobilePrimary.has(x.href)).map(({href,label,icon:Icon})=><Link key={href} href={href} aria-current={navActive(location,href)?'page':undefined} className={`flex-1 min-w-0 min-h-11 flex flex-col items-center justify-center gap-1 text-[10px] px-1 py-1 focus-visible:outline-2 ${navActive(location,href)?'text-[#f0bc82]':'text-[#c2d4c8]'}`}><Icon aria-hidden="true" size={21}/>{label}</Link>)}<button type="button" onClick={()=>setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls="mobile-more-menu" className={`flex-1 min-w-0 min-h-11 flex flex-col items-center justify-center gap-1 text-[10px] px-1 py-1 focus-visible:outline-2 ${secondary.some(item=>navActive(location,item.href))?'text-[#f0bc82]':'text-[#c2d4c8]'}`}><MoreHorizontal aria-hidden="true" size={21}/>المزيد</button></nav>
    <dialog id="mobile-more-menu" ref={moreDialog} aria-labelledby="mobile-more-title" onClose={()=>setMoreOpen(false)} onClick={event=>{if(event.target===event.currentTarget)setMoreOpen(false)}} className="fixed inset-x-4 top-auto bottom-[calc(90px+env(safe-area-inset-bottom))] mx-auto my-0 max-w-sm max-h-[70dvh] w-[calc(100%_-_2rem)] overflow-auto border-0 rounded-2xl p-5 text-[#214e43] bg-[#fbf7ed] shadow-xl backdrop:bg-[#102f2ac2]">
      <div className="flex items-center justify-between mb-3"><h2 id="mobile-more-title" className="font-bold text-lg">مساحتك الخاصة</h2><button type="button" autoFocus onClick={()=>setMoreOpen(false)} aria-label="إغلاق المزيد" className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-full hover:bg-[#e5eadc] focus-visible:outline-2"><X aria-hidden="true" size={20}/></button></div>
      <nav aria-label="الأقسام الأخرى" className="grid grid-cols-2 gap-2">{secondary.map(({href,label,icon:Icon})=><Link key={href} href={href} onClick={()=>setMoreOpen(false)} aria-current={navActive(location,href)?'page':undefined} className={`min-h-12 flex items-center gap-2 rounded-xl px-3 py-3 text-sm focus-visible:outline-2 ${navActive(location,href)?'bg-[#e2ad73] font-bold':'bg-[#e5eadc] hover:bg-[#d5e1cc]'}`}><Icon aria-hidden="true" size={18} className="shrink-0"/><span>{label}</span></Link>)}</nav>
    </dialog>
  </div>;
}
export function AddButton({onClick,label}: {onClick:()=>void,label:string}) { return <button className="btn" onClick={onClick}><Plus size={17}/>{label}</button>; }