import { useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { ModalHost } from './scoped-modal';

/** On-demand overlay anchored in the map workspace. modal=true: real focus containment, inert background. modal=false: map stays interactive. */
export function Layer({ label, onClose, modal, variant, testId, container, restore, children }: { label: string; onClose: () => void; modal: boolean; variant: 'details' | 'reward'; testId: string; container: HTMLElement; restore?: () => HTMLElement | null; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const prev = useRef(document.activeElement as HTMLElement | null);
  const details = variant === 'details';
  return <Dialog.Root open modal={modal} onOpenChange={o => { if (!o) onClose(); }}>
    <Dialog.Portal container={container}>
      {modal && <Dialog.Overlay className="absolute inset-0 z-[55] bg-[#102f2a]/35" data-testid={`${testId}-scrim`} />}
      <Dialog.Content ref={setHost} aria-describedby={undefined} data-esc-layer data-modeless={modal ? undefined : ''} data-testid={testId}
        onWheel={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
        onInteractOutside={e => { if (!modal) e.preventDefault(); }}
        onCloseAutoFocus={e => { e.preventDefault(); const t = prev.current?.isConnected ? prev.current : restore?.(); t?.focus({ preventScroll: true }); }}
        className={`absolute z-[60] overflow-y-auto overscroll-contain outline-none bg-[#fbf7ed] shadow-2xl border border-[#e3d9c9] fade-in-layer inset-x-0 bottom-0 max-h-[74%] rounded-t-[26px] p-3 ${details ? 'md:inset-x-auto md:bottom-3 md:top-3 md:right-3 md:w-[400px] md:max-h-none md:rounded-[24px]' : 'md:inset-x-0 md:mx-auto md:bottom-8 md:w-[430px] md:rounded-[24px]'}`}>
        <div className="flex justify-between items-center mb-2 sticky top-0 z-10 bg-[#fbf7ed]/95 -mt-1 pt-1">
          <Dialog.Title className="text-xs font-bold muted px-2">{label}</Dialog.Title>
          <Dialog.Close data-layer-close aria-label="إغلاق" data-testid={`${testId}-close`} className="btn btn-light !p-2 min-w-10 min-h-10"><X size={17} /></Dialog.Close>
        </div>
        <ModalHost.Provider value={host}>{children}</ModalHost.Provider>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
