import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({open, onOpenChange, title, description, children, variant = 'default', className = ''}: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode;
  variant?: 'default' | 'trade' | 'settings';
  className?: string;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className={`modal-content ${variant === 'default' ? '' : `${variant}-dialog`} ${className}`}
        onPointerDownOutside={event => {if (variant !== 'default') event.preventDefault();}}>
        <div className="modal-header">
        <Dialog.Title className="modal-title">{title}</Dialog.Title>
        <Dialog.Description className="modal-description">{description}</Dialog.Description>
        <Dialog.Close className="modal-close" aria-label="关闭"><X size={19} /></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
