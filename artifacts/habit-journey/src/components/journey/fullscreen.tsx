import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function FullscreenOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    const appRoot = document.getElementById('root');
    const previousInert = appRoot?.inert ?? false;
    const previousHidden = appRoot?.getAttribute('aria-hidden');
    if (appRoot) { appRoot.inert = true; appRoot.setAttribute('aria-hidden', 'true'); }
    document.body.style.overflow = 'hidden';
    let pushed = false, done = false;
    const finish = () => { if (!done) { done = true; closeRef.current(); } };
    try { history.pushState({ ...history.state, jfs: 1 }, ''); pushed = true; } catch { /* ignore */ }
    let native = false;
    document.documentElement.requestFullscreen?.().then(() => {
      native = true;
      if (done && document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    }).catch(() => undefined);
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
      if (e.key !== 'Tab') return;
      const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(el => el.getClientRects().length);
      const first = targets[0], last = targets[targets.length - 1];
      if (!first) { e.preventDefault(); ref.current?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
    };
    const pop = () => { pushed = false; finish(); };
    const fs = () => { if (native && !document.fullscreenElement) finish(); };
    window.addEventListener('keydown', key); window.addEventListener('popstate', pop); document.addEventListener('fullscreenchange', fs);
    return () => {
      done = true;
      window.removeEventListener('keydown', key); window.removeEventListener('popstate', pop); document.removeEventListener('fullscreenchange', fs);
      document.body.style.overflow = overflow;
      if (appRoot) {
        appRoot.inert = previousInert;
        if (previousHidden == null) appRoot.removeAttribute('aria-hidden');
        else appRoot.setAttribute('aria-hidden', previousHidden);
      }
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
      if (pushed && history.state?.jfs) history.back();
      prev?.focus?.();
    };
  }, []);
  return createPortal(<div ref={ref} role="dialog" aria-modal="true" aria-label="الخريطة بملء الشاشة" tabIndex={-1} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} className="fixed inset-0 z-[100] bg-[#f2ecdc] overflow-y-auto overflow-x-hidden outline-none" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }} data-testid="journey-fullscreen">
    <div className="sticky top-0 z-10 flex justify-end p-3 pointer-events-none"><button className="btn pointer-events-auto" onClick={() => closeRef.current()} data-testid="button-exit-fullscreen"><X size={17} />خروج من ملء الشاشة</button></div>
    <div className="max-w-[1270px] mx-auto px-4 md:px-8 pb-10 -mt-2">{children}</div>
  </div>, document.body);
}
