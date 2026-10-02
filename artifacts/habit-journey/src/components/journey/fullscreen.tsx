import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { closeTopLayer } from './layers';

let nativeOwner: symbol | null = null;

export function FullscreenOverlay({ onClose, onAfterClose, returnSignal, children }: { onClose: () => void; onAfterClose?: () => void; returnSignal?: AbortSignal; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  const afterCloseRef = useRef(onAfterClose); afterCloseRef.current = onAfterClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    const appRoot = document.getElementById('root');
    const previousInert = appRoot?.inert ?? false;
    const previousHidden = appRoot?.getAttribute('aria-hidden');
    if (appRoot) { appRoot.inert = true; appRoot.setAttribute('aria-hidden', 'true'); }
    document.body.style.overflow = 'hidden';
    const nativeSession = Symbol('journey-fullscreen');
    const historyKey = crypto.randomUUID();
    nativeOwner = nativeSession;
    let pushed = false, done = false;
    const finish = () => { if (!done) { done = true; closeRef.current(); } };
    try { history.pushState({ ...history.state, jfs: historyKey }, ''); pushed = true; } catch { /* ignore */ }
    let native = false;
    const nativeEntry = document.documentElement.requestFullscreen?.().then(() => {
      native = true;
    }).catch(() => undefined);
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (e.defaultPrevented) return; e.preventDefault(); if (!closeTopLayer(ref.current)) finish(); return; }
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      // A focus-trapping layer (modal sheet, memory dialog, legacy modal) owns Tab.
      if (Array.from(document.querySelectorAll('[role="dialog"]')).some(d => d !== ref.current && !d.hasAttribute('data-modeless'))) return;
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
      // Restore only after both native exit and the temporary history entry
      // settle. A newly mounted page must not race their scroll restoration.
      const nativeExit = Promise.resolve(nativeEntry).then(async () => {
        if (nativeOwner !== nativeSession) return;
        if (document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => undefined);
        if (nativeOwner === nativeSession) nativeOwner = null;
      });
      const historyExit = pushed && history.state?.jfs === historyKey && !returnSignal?.aborted ? new Promise<void>(resolve => {
        const returned = () => {
          window.removeEventListener('popstate', returned);
          returnSignal?.removeEventListener('abort', returned);
          resolve();
        };
        window.addEventListener('popstate', returned, { once: true });
        returnSignal?.addEventListener('abort', returned, { once: true });
        try { history.back(); } catch {
          returned();
        }
      }) : Promise.resolve();
      Promise.all([nativeExit, historyExit]).then(() => requestAnimationFrame(() => {
        if (afterCloseRef.current) afterCloseRef.current();
        else if (prev?.isConnected) prev.focus({ preventScroll: true });
      }));
    };
  }, []);
  return createPortal(<div ref={ref} role="dialog" aria-modal="true" aria-label="الخريطة بملء الشاشة" tabIndex={-1} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} className="fixed inset-0 z-[100] bg-[#f2ecdc] overflow-hidden outline-none" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }} data-testid="journey-fullscreen">
    <div className="h-full w-full">{children}</div>
  </div>, document.body);
}
