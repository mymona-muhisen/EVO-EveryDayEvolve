import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { arSA } from '@clerk/localizations';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, Redirect, Link, useLocation, Router as WouterRouter } from 'wouter';
import { Toaster } from 'sonner';
import { useGetCurrentUser, type User } from '@workspace/api-client-react';
import { Shell, Loading, ErrorBlock } from '@/components/journey-ui';
import { Landing } from '@/pages/public';
import { Onboarding, SettingsPage } from '@/pages/profile';
import { HomePage } from '@/pages/home';
import { HabitsPage, HabitDetailPage } from '@/pages/habits';
import { TimePage, MemoriesPage } from '@/pages/life';
import { RewardsPage, JourneyPage } from '@/pages/rewards-journey';
import { HabitJourneyPage } from '@/pages/habit-journey';
import { HabitJourneyCompletePage } from '@/pages/habit-journey-complete';
import { GroupsPage, GroupDetailPage } from '@/pages/groups';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
function stripBase(path:string):string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length)||'/' : path;
}
if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsPlacement: 'bottom' as const,
  },
  variables: {
    colorPrimary:'#245448', colorForeground:'#1c443c', colorMutedForeground:'#647a6e',
    colorDanger:'#ae604f', colorBackground:'#fffaf0', colorInput:'#fffdf7',
    colorInputForeground:'#1c443c', colorNeutral:'#d7d2c3',
    fontFamily:'IBM Plex Sans Arabic, sans-serif', borderRadius:'14px',
  },
  elements: {
    rootBox:'w-full flex justify-center',
    cardBox:'bg-[#fffaf0] rounded-[24px] w-[440px] max-w-full overflow-hidden',
    card:'!shadow-none !border-0 !bg-transparent !rounded-none',
    footer:'!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle:'!text-[#1c443c] !font-bold !text-2xl',
    headerSubtitle:'!text-[#647a6e]',
    socialButtonsBlockButtonText:'!text-[#1c443c]',
    formFieldLabel:'!text-[#1c443c]',
    footerActionLink:'!text-[#245448] !font-bold',
    footerActionText:'!text-[#647a6e]',
    dividerText:'!text-[#647a6e]',
    identityPreviewEditButton:'!text-[#245448]',
    formFieldSuccessText:'!text-[#245448]',
    alertText:'!text-[#a35548]',
    logoBox:'!justify-center',
    logoImage:'!h-12 !w-12',
    socialButtonsBlockButton:'!border-[#ded7c7] !bg-[#fffdf7]',
    formButtonPrimary:'!bg-[#245448] !text-[#fffaf0] !font-bold',
    formFieldInput:'!bg-[#fffdf7] !border-[#ded7c7] !text-[#1c443c]',
    footerAction:'!bg-transparent',
    dividerLine:'!bg-[#ded7c7]',
    alert:'!bg-[#f8e8df]',
    otpCodeFieldInput:'!bg-[#fffdf7] !text-[#1c443c]',
    formFieldRow:'!text-[#1c443c]',
    main:'!text-[#1c443c]',
  },
};
const queryClient = new QueryClient({defaultOptions:{queries:{staleTime:30000,retry:1}}});
function ClerkQueryClientCacheInvalidator(){
  const {addListener}=useClerk();const queryClient=useQueryClient();const prevUserIdRef=useRef<string|null|undefined>(undefined);
  useEffect(()=>{const unsubscribe=addListener(({user})=>{const userId=user?.id??null;if(prevUserIdRef.current!==undefined&&prevUserIdRef.current!==userId)queryClient.clear();prevUserIdRef.current=userId;});return unsubscribe;},[addListener,queryClient]);
  return null;
}
function AuthLayout({children,title}: {children:ReactNode,title:string}) {
  return <div className="min-h-[100dvh] bg-[#f2ecdc] grid lg:grid-cols-[.88fr_1.12fr]">
    <div className="hidden lg:flex relative bg-[#214e43] text-[#fff9ed] p-14 flex-col justify-between overflow-hidden"><Link href="/" className="flex gap-3 items-center font-black text-xl" style={{fontFamily:'Cairo'}}><img src={`${basePath}/logo.svg`} className="w-11 h-11" alt="شعار رحلة العادة"/>رحلة العادة</Link><div className="relative z-10"><div className="eyebrow !text-[#e8b87e] mb-5">رحلة تبدأ من هنا</div><h2 className="text-5xl leading-[1.45] font-black max-w-lg">كل يوم تكتب سطرًا جديدًا في حكايتك.</h2><p className="text-[#c4d8ca] mt-5 leading-8">عاداتك، ذكرياتك، وخطواتك الصغيرة. كلها في مكان يشبهك.</p></div><div className="text-[#adccbb] text-sm">لا يوجد طريق واحد صحيح. فقط طريقك أنت.</div><img src={`${basePath}/journey-landscape.png`} className="absolute bottom-0 left-0 w-full h-1/2 object-cover opacity-15 pointer-events-none" alt=""/></div>
    <div className="flex flex-col items-center justify-center p-5 md:p-10"><Link href="/" className="lg:hidden flex items-center gap-2 font-bold text-xl mb-10"><img src={`${basePath}/logo.svg`} className="w-9 h-9" alt="الشعار"/>رحلة العادة</Link><div className="text-center mb-6"><div className="eyebrow mb-2">مساحتك الخاصة</div><h1 className="text-3xl font-extrabold">{title}</h1></div>{children}</div>
  </div>;
}
function SignInPage(){return <AuthLayout title="أهلًا بعودتك"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/home`}/></AuthLayout>}
function SignUpPage(){return <AuthLayout title="ابدأ حكايتك"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/onboarding`}/></AuthLayout>}
function HomeRedirect(){return <><Show when="signed-in"><Redirect to="/home"/></Show><Show when="signed-out"><Landing/></Show></>}
function Protected({children,onboarding=false}: {children:(user:User)=>ReactNode,onboarding?:boolean}){
  return <><Show when="signed-out"><Redirect to="/"/></Show><Show when="signed-in"><ProtectedContent onboarding={onboarding}>{children}</ProtectedContent></Show></>;
}
function ProtectedContent({children,onboarding}: {children:(user:User)=>ReactNode,onboarding:boolean}){
  const user=useGetCurrentUser();
  if(user.isLoading)return <div className="max-w-4xl mx-auto p-10"><Loading/></div>;
  if(user.isError||!user.data)return <div className="max-w-2xl mx-auto p-10"><ErrorBlock retry={()=>user.refetch()}/></div>;
  if(!user.data.onboardingCompleted&&!onboarding)return <Redirect to="/onboarding"/>;
  if(user.data.onboardingCompleted&&onboarding)return <Redirect to="/home"/>;
  return onboarding?<>{children(user.data)}</>:<Shell user={user.data}>{children(user.data)}</Shell>;
}
function NotFound(){return <div className="min-h-[100dvh] flex flex-col justify-center items-center text-center p-5"><div className="eyebrow">طريق غير موجود</div><h1 className="text-4xl font-black mt-4">يبدو أننا ابتعدنا قليلًا.</h1><p className="muted my-5">لا بأس، الطريق إلى البداية ما زال هنا.</p><Link href="/" className="btn">العودة للبداية</Link></div>}
function Routes(){
  return <Switch>
    <Route path="/" component={HomeRedirect}/>
    <Route path="/sign-in/*?" component={SignInPage}/>
    <Route path="/sign-up/*?" component={SignUpPage}/>
    <Route path="/onboarding">{()=><Protected onboarding>{user=><Onboarding user={user}/>}</Protected>}</Route>
    <Route path="/home">{()=><Protected>{user=><HomePage user={user}/>}</Protected>}</Route>
    <Route path="/habits">{()=><Protected>{()=><HabitsPage/>}</Protected>}</Route>
    <Route path="/habits/:habitId/journey/complete">{()=><Protected>{()=><HabitJourneyCompletePage/>}</Protected>}</Route>
    <Route path="/habits/:habitId/journey">{()=><Protected>{()=><HabitJourneyPage/>}</Protected>}</Route>
    <Route path="/habits/:habitId">{()=><Protected>{user=><HabitDetailPage user={user}/>}</Protected>}</Route>
    <Route path="/time">{()=><Protected>{user=><TimePage user={user}/>}</Protected>}</Route>
    <Route path="/memories">{()=><Protected>{()=><MemoriesPage/>}</Protected>}</Route>
    <Route path="/rewards">{()=><Protected>{()=><RewardsPage/>}</Protected>}</Route>
    <Route path="/journey">{()=><Protected>{()=><JourneyPage/>}</Protected>}</Route>
    <Route path="/groups">{()=><Protected>{()=><GroupsPage/>}</Protected>}</Route>
    <Route path="/groups/:groupId">{()=><Protected>{()=><GroupDetailPage/>}</Protected>}</Route>
    <Route path="/settings">{()=><Protected>{user=><SettingsPage user={user}/>}</Protected>}</Route>
    <Route component={NotFound}/>
  </Switch>;
}
function ClerkProviderWithRoutes(){
  const [,setLocation]=useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{...arSA,signIn:{...arSA.signIn,start:{...arSA.signIn?.start,title:'أهلًا بعودتك',subtitle:'سجّل دخولك لتواصل رحلتك'}},signUp:{...arSA.signUp,start:{...arSA.signUp?.start,title:'ابدأ رحلتك',subtitle:'مساحة جديدة لخطواتك الصغيرة'}}}} routerPush={(to)=>setLocation(stripBase(to))} routerReplace={(to)=>setLocation(stripBase(to),{replace:true})}>
    <QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator/><Routes/><Toaster position="top-center" dir="rtl" richColors closeButton/></QueryClientProvider>
  </ClerkProvider>;
}
function App(){return <WouterRouter base={basePath}><ClerkProviderWithRoutes/></WouterRouter>}
export default App;