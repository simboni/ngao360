'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `drawer` slides in from the right (audit history, details). */
  variant?: 'modal' | 'drawer';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Accessible modal / drawer built on the native <dialog> element: focus is
 * trapped and restored by the browser, Escape closes it, and the title and
 * description are announced through aria-labelledby / aria-describedby.
 */
export function Dialog({ open, onClose, title, description, children, footer, variant = 'modal', size = 'md', className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes it.
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'max-h-[100dvh] bg-transparent p-0 backdrop:bg-navy/40',
        variant === 'drawer'
          ? 'm-0 ml-auto h-[100dvh] w-full max-w-xl'
          : cn('w-full', size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl'),
        className,
      )}
    >
      {open ? (
        <div className={cn('flex flex-col bg-surface text-ink shadow-xl', variant === 'drawer' ? 'h-full' : 'max-h-[90dvh] rounded-card border border-line')}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={titleId} className="text-section font-semibold text-navy">
                {title}
              </h2>
              {description ? (
                <div id={descId} className="mt-1 text-body text-slate">
                  {description}
                </div>
              ) : null}
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate hover:bg-cloud hover:text-ink" aria-label="Close">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
