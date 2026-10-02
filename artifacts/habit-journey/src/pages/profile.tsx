import { ConsistencyOverview } from '@/components/daily/consistency-overview';
import { JourneyHistory } from '@/components/reward/real-reward';
import { SocialSettingsPanel } from '@/components/social/social-widgets';
import { CharacterSummary } from '@/components/character/character-summary';
import { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useClerk } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateCurrentUser, getGetCurrentUserQueryKey, type User, type UserUpdate } from '@workspace/api-client-react';
import { Field, PageHead, categories, styles } from '@/components/journey-ui';
import { ArrowLeft, LogOut } from 'lucide-react';
import { toast } from 'sonner';

const avatars = ['🧭','🌿','🦊','🌙','🐢','🪴','☀️','🦉'];
export function ProfileForm({user,onboarding=false}: {user:User,onboarding?:boolean}) {
  const [name,setName] = useState(user.displayName || '');
  const [avatar,setAvatar] = useState(user.avatarEmoji || avatars[0]);
  const [style,setStyle] = useState<UserUpdate['motivationStyle']>(user.motivationStyle || 'encouraging');
  const [category,setCategory] = useState<UserUpdate['primaryGoalCategory']>(user.primaryGoalCategory || 'health');
  const [timezone,setTimezone] = useState(user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const update = useUpdateCurrentUser(); const qc=useQueryClient(); const [,navigate]=useLocation(); const {signOut}=useClerk();
  const submit = (e:React.FormEvent) => { e.preventDefault(); if(!name.trim()){toast.error('اكتب اسمًا نرحب بك به');return;} update.mutate({data:{displayName:name.trim(),avatarEmoji:avatar,motivationStyle:style,primaryGoalCategory:category,timezone,onboardingCompleted:true}}, {onSuccess:(u)=>{qc.setQueryData(getGetCurrentUserQueryKey(),u);toast.success(onboarding?'أهلًا بك في رحلتك!':'حُفظت تغييراتك');if(onboarding) navigate('/home');},onError:()=>toast.error('لم نتمكن من حفظ التغييرات')}); };
  return <form onSubmit={submit} className="paper rounded-[28px] p-6 md:p-9 max-w-[760px]">
    <Field label="كيف نُناديك؟"><input className="field" value={name} onChange={e=>setName(e.target.value)} placeholder="اسمك الذي تحبّه" required data-testid="input-display-name"/></Field>
    <div className="mb-6"><div className="text-sm font-bold mb-3">رمز ملفك الشخصي</div><div className="flex flex-wrap gap-2">{avatars.map(a=><button type="button" key={a} onClick={()=>setAvatar(a)} className={`w-12 h-12 text-2xl rounded-xl border transition-transform hover:scale-110 ${avatar===a?'bg-[#e3b878] border-[#bf8e55] scale-110':'bg-[#f4eddd] border-[#e2dac9]'}`}>{a}</button>)}</div></div>
    <div className="mb-6"><div className="text-sm font-bold mb-3">أي صوت يساعدك على الاستمرار؟</div><div className="grid md:grid-cols-3 gap-3">{([['encouraging','مشجّع ولطيف','يذكّرك بما أنجزته ويرافقك بهدوء.'],['tough_love','صريح وحازم','يقول الحقيقة ويدفعك للعودة إلى الطريق.'],['data_driven','يركّز على الأرقام','يريك تقدّمك كما هو، بالأرقام والأنماط.']] as const).map(([v,t,d])=><button type="button" key={v} onClick={()=>setStyle(v)} className={`text-right rounded-2xl p-4 border transition-all ${style===v?'bg-[#e5ece0] border-[#36725a]':'bg-[#faf5eb] border-[#e5dfd0]'}`}><strong className="block">{t}</strong><small className="muted leading-6">{d}</small></button>)}</div></div>
    <div className="grid md:grid-cols-2 gap-4"><Field label="المجال الأقرب إلى هدفك"><select className="field" value={category} onChange={e=>setCategory(e.target.value as UserUpdate['primaryGoalCategory'])}>{Object.entries(categories).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></Field><Field label="المنطقة الزمنية"><input className="field" value={timezone} onChange={e=>setTimezone(e.target.value)} placeholder="Asia/Riyadh"/></Field></div>
    <div className="flex flex-wrap gap-3 mt-4"><button type="submit" className="btn !px-7" disabled={update.isPending}>{update.isPending?'نحفظ رحلتك...':onboarding?'لنبدأ الرحلة':'حفظ التغييرات'} <ArrowLeft size={17}/></button>{!onboarding && <button type="button" className="btn btn-light" onClick={()=>signOut({redirectUrl:import.meta.env.BASE_URL})}><LogOut size={16}/> تسجيل الخروج</button>}</div>
  </form>;
}
export function Onboarding({user}: {user:User}) { return <div className="min-h-[100dvh] bg-[#f4ecdb] p-5 md:p-12"><div className="max-w-[760px] mx-auto"><div className="flex items-center gap-3 mb-10"><img src={`${import.meta.env.BASE_URL}evo-logo.png`} className="w-24 h-14 object-contain rounded-lg" alt="EVO — Every Day, Evolve."/><strong className="text-xl" style={{fontFamily:'Cairo'}}>رحلة العادة</strong></div><PageHead overline="خطوتك الأولى" title="لنبدأ بالتعارف." desc="هذه مساحتك. اختر ما يجعل الرحلة أقرب إليك، ويمكنك تغيير كل شيء لاحقًا."/><ProfileForm user={user} onboarding/></div></div>; }
export function SettingsPage({user}: {user:User}) { return <><PageHead overline="مساحتك الخاصة" title="الإعدادات" desc={`مدرّبك الآن: ${styles[user.motivationStyle]}. يمكنك تغيير صوت الرحلة متى أردت.`}/><div className="max-w-[760px] mb-8"><CharacterSummary profile /></div><ProfileForm user={user}/><div className="mt-8"><SocialSettingsPanel/></div><div className="mt-8"><ConsistencyOverview settings/></div><div className="mt-8"><JourneyHistory/></div><div className="mt-6"><Link href="/memories" data-testid="link-memories" className="btn btn-light">ذكرياتي الخاصة</Link></div></>; }