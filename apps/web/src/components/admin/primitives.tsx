'use client';

/**
 * Small form and overlay primitives for the admin and reference screens:
 * accessible dialog/drawer (Esc closes, focus moves in and returns), labelled
 * fields with inline errors, notices and chips. Tokens from blueprint 12.1.
 */
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close]), [tabindex="0"]');
    (first ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
        if (items.length === 0) return;
        const firstItem = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useOverlay(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'flex max-h-[92vh] w-full flex-col rounded-t-card bg-surface shadow-xl sm:rounded-card',
          size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-xl',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="text-section font-semibold text-navy">
              {title}
            </h2>
            {description ? <p className="mt-1 text-body text-slate">{description}</p> : null}
          </div>
          <button type="button" data-close onClick={onClose} className="rounded-lg p-1 text-slate hover:bg-cloud hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, actions }: { open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-navy/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex h-full w-full max-w-2xl flex-col bg-surface shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-section font-semibold text-navy">
              {title}
            </h2>
            {subtitle ? <div className="mt-1 text-meta text-slate">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button type="button" data-close onClick={onClose} className="rounded-lg p-1 text-slate hover:bg-cloud hover:text-ink" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor, required }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="mb-4">
      <label className="ngao-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-error" aria-hidden> *</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-meta text-slate">{hint}</p> : null}
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-meta text-error" role="alert">
          <XCircle className="h-3.5 w-3.5" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('ngao-input', className)} {...rest} />;
}

export function SelectInput({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('ngao-input pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('ngao-input h-auto min-h-[84px] py-2', className)} {...rest} />;
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
const NOTICE: Record<NoticeTone, { cls: string; Icon: typeof Info }> = {
  info: { cls: 'border-deep-blue/20 bg-deep-blue/5 text-deep-blue', Icon: Info },
  success: { cls: 'border-success/30 bg-success/10 text-success', Icon: CheckCircle2 },
  warning: { cls: 'border-gold/50 bg-gold/10 text-[#7a5a17]', Icon: AlertTriangle },
  danger: { cls: 'border-error/30 bg-error/10 text-error', Icon: XCircle },
};

export function Notice({ tone = 'info', title, children, className }: { tone?: NoticeTone; title?: string; children?: ReactNode; className?: string }) {
  const { cls, Icon } = NOTICE[tone];
  return (
    <div className={cn('flex gap-2 rounded-lg border px-3 py-2 text-body', cls, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-ink/90')}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warning' | 'danger'; title?: string }) {
  const tones = {
    neutral: 'border-line bg-cloud text-ink',
    info: 'border-deep-blue/20 bg-deep-blue/10 text-deep-blue',
    warning: 'border-gold/40 bg-gold/15 text-[#7a5a17]',
    danger: 'border-error/30 bg-error/10 text-error',
  } as const;
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[12px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/** Definition list used in detail drawers. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-meta text-slate">{i.label}</dt>
          <dd className="break-words text-body text-ink">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-body font-medium',
            value === t.value ? 'border-teal text-navy' : 'border-transparent text-slate hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined ? <span className="ml-1 text-meta text-slate">({t.count})</span> : null}
        </button>
      ))}
    </div>
  );
}
