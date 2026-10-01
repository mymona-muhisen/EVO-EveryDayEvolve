import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'wouter';
import { Bell, X, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useListSocialNotifications, getListSocialNotificationsQueryKey, type SocialUserSummary } from '@workspace/api-client-react';

export const statusOf = (e: unknown): number | undefined => (typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined);

/** Arabic message for a social API failure. */
export function socialError(e: unknown, fallback = 'حدث انقطاع بسيط. حاول مرة أخرى.'): string {
  const s = statusOf(e);
  if (s === 401) return 'انتهت جلستك. سجّل الدخول مجددًا.';
  if (s === 403) return 'هذا الإجراء غير متاح لك.';
  if (s === 404) return 'لم نجد ما تبحث عنه.';
  if (s === 409) return 'تعذّر تنفيذ الإجراء لأن الحالة تغيّرت. حدّث الصفحة وحاول مجددًا.';
  if (s === 429) return 'مهلًا قليلًا، حاول بعد لحظات.';
  return fallback;
}

export function useRefreshSocial() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('/api/social') });
}

export const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

export const normalizeUsername = (v: string) => v.trim().replace(/^@+/, '').toLowerCase();
export const usernameValid = (v: string, min = 3) => new RegExp(`^[a-z0-9_]{${min},24}$`).test(v);

export function SocialAvatar({ user, size = 44 }: { user: Pick<SocialUserSummary, 'avatarEmoji' | 'displayName'>; size?: number }) {
  return <span aria-hidden className="shrink-0 rounded-full bg-[#e9d3a8] flex items-center justify-center" style={{ width: size, height: size, fontSize: size * 0.5 }}>{user.avatarEmoji || <UserRound size={size * 0.5} />}</span>;
}

export function PersonLine({ user, extra, right }: { user: SocialUserSummary; extra?: ReactNode; right?: ReactNode }) {
  return <div className="flex items-center gap-3 min-w-0 flex-wrap sm:flex-nowrap">
    <SocialAvatar user={user} />
    <div className="min-w-0 flex-1 basis-40"><div className="font-bold truncate">{user.displayName}</div>
      <div className="text-xs muted truncate" dir="ltr" style={{ textAlign: 'right' }}>{user.username ? `@${user.username}` : 'بلا اسم مستخدم'}</div>{extra}</div>
    {right}
  </div>;
}

/** Portaled modal: lives on document.body (or the fullscreen element) so transformed page ancestors never offset it. */
export function SocialModal({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], act = document.activeElement;
      if (e.shiftKey && (act === first || act === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', k);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, []);
  const target = typeof document === 'undefined' ? null : (document.fullscreenElement ?? document.body);
  if (!target) return null;
  return createPortal(
    <div dir="rtl" className="fixed inset-0 z-[300] bg-[#102f2ac2] backdrop-blur-[5px] flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={e => { e.stopPropagation(); onClose(); }} onClick={e => e.stopPropagation()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} onMouseDown={e => e.stopPropagation()}
        className="paper rounded-t-[24px] sm:rounded-[24px] p-5 md:p-7 w-full max-w-lg max-h-[92dvh] overflow-auto outline-none">
        <div className="flex justify-between items-center gap-3 mb-5"><h2 className="text-xl md:text-2xl font-bold m-0">{title}</h2>
          <button type="button" onClick={onClose} className="btn btn-light !p-0 w-11 h-11 shrink-0" aria-label="إغلاق" data-testid="button-social-modal-close"><X size={18} /></button></div>
        {children}
      </div>
    </div>, target);
}

export function InlineError({ message, retry }: { message: string; retry?: () => void }) {
  return <div role="alert" className="rounded-2xl bg-[#f8e8df] border border-[#e7c3b2] p-4 flex flex-wrap items-center gap-3 text-sm"><span className="flex-1 min-w-[160px]">{message}</span>{retry && <button type="button" className="btn btn-light min-h-11" onClick={retry}>إعادة المحاولة</button>}</div>;
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3" aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-[72px] w-full" />)}</div>;
}

export function SoftEmpty({ title, desc, action, icon }: { title: string; desc: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="rounded-[22px] border border-dashed border-[#cfc6ae] bg-[#faf4e4] p-7 text-center">
    {icon && <div className="w-12 h-12 rounded-full bg-[#e5eadc] flex items-center justify-center mx-auto mb-3 text-[#245448]">{icon}</div>}
    <h3 className="font-bold text-lg m-0">{title}</h3><p className="muted mt-1 mb-0 text-sm">{desc}</p>{action && <div className="mt-4">{action}</div>}</div>;
}

export function useUnreadCount() {
  const params = { unreadOnly: true, limit: 50 };
  const q = useListSocialNotifications(params, { query: { queryKey: getListSocialNotificationsQueryKey(params), refetchInterval: 60000, refetchOnWindowFocus: true, retry: false } });
  return { count: q.data?.length ?? 0, capped: (q.data?.length ?? 0) >= 50, ...q };
}

export function NotificationBell({ className = '' }: { className?: string }) {
  const { count, capped } = useUnreadCount();
  return <Link href="/notifications" data-testid="link-notifications" aria-label={count ? `الإشعارات، ${count} غير مقروءة` : 'الإشعارات'} className={`relative w-11 h-11 rounded-full flex items-center justify-center hover:bg-[#efe6d0] ${className}`}>
    <Bell size={20} />{count > 0 && <span data-testid="badge-unread-count" className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#c87953] text-[#fff9e9] text-[10px] font-bold flex items-center justify-center">{capped ? '50+' : count}</span>}
  </Link>;
}

/** Fetches a private social memory photo as a Blob and exposes a revocable object URL. */
export function useObjectUrl(blob: Blob | undefined | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob); setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
