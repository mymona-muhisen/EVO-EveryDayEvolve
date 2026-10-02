import { createContext, useRef, type ComponentProps } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Modal as BaseModal } from '@/components/journey-ui';

/** Element the legacy modal should portal into (a Radix layer's content, so focus containment includes it). */
export const ModalHost = createContext<HTMLElement | null>(null);

/** Each nested editor owns its focus scope. Portal outside the sheet's scrolling/animated content. */
export function Modal({ title, children, onClose }: ComponentProps<typeof BaseModal>) {
  const opener = useRef(document.activeElement as HTMLElement | null);
  const host = document.querySelector<HTMLElement>('[data-testid="journey-fullscreen"]') ?? document.body;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal container={host}>
      <Dialog.Overlay className="fixed inset-0 z-[200] bg-[#102f2ac2] backdrop-blur-[5px]" />
      <Dialog.Content data-scoped-modal aria-describedby={undefined}
        onEscapeKeyDown={event => { event.preventDefault(); onClose(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}
        className="paper fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[210] rounded-[24px] p-5 md:p-7 w-[calc(100%_-_2rem)] max-w-xl max-h-[90dvh] overflow-y-auto overscroll-contain shadow-2xl outline-none">
        <div className="flex justify-between items-center mb-6">
          <Dialog.Title className="text-2xl font-bold">{title}</Dialog.Title>
          <Dialog.Close className="btn btn-light !px-3" aria-label="إغلاق">×</Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
