'use client';

/**
 * Form and layout primitives for the public portal. Mobile first: 16px text
 * in inputs (no zoom on focus), 44px touch targets, labels above fields,
 * hints and errors tied to inputs with aria-describedby, and an error summary
 * that moves focus and links to each field.
 */
import { AlertTriangle, CheckCircle2, Info, Loader2, SearchX, XCircle } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
} from 'react';
import { cn } from '@/lib/cn';
import { usePortal } from './portal-context';

export const inputClass =
  'block min-h-[44px] w-full rounded-lg border border-slate/40 bg-surface px-3 py-2 text-base text-ink placeholder:text-slate focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30 disabled:bg-cloud aria-[invalid=true]:border-error';

export function fieldIds(name: string) {
  return { input: `f-${name}`, hint: `f-${name}-hint`, error: `f-${name}-error` };
}

export function describedBy(name: string, hint?: ReactNode, error?: string | null): string | undefined {
  const ids = fieldIds(name);
  const parts = [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

/** Label + hint + error wrapper. The control receives id/aria props from the caller. */
export function Field({
  name,
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { t } = usePortal();
  const ids = fieldIds(name);
  return (
    <div className={cn('mb-5', className)}>
      <label htmlFor={ids.input} className="mb-1 block text-base font-semibold text-ink">
        {label}
        {optional ? <span className="ml-1 font-normal text-slate">({t('common.optional')})</span> : null}
      </label>
      {hint ? (
        <p id={ids.hint} className="mb-2 text-body text-slate">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="mb-2 flex items-start gap-1.5 text-body font-medium text-error">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      {children}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClass, className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputClass, 'min-h-[140px] leading-6', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(inputClass, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

/** Large radio list inside a fieldset (each option is a 44px+ target). */
export function RadioGroup<V extends string>({
  name,
  legend,
  hint,
  error,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  value: V;
  options: Array<{ value: V; label: ReactNode; description?: ReactNode }>;
  onChange: (v: V) => void;
}) {
  const ids = fieldIds(name);
  return (
    <fieldset className="mb-5" aria-describedby={describedBy(name, hint, error)} id={ids.input} tabIndex={-1}>
      <legend className="mb-1 text-base font-semibold text-ink">{legend}</legend>
      {hint ? (
        <p id={ids.hint} className="mb-2 text-body text-slate">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="mb-2 flex items-start gap-1.5 text-body font-medium text-error">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {options.map((o) => {
          const id = `${ids.input}-${o.value}`;
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                'flex min-h-[48px] cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-base',
                checked ? 'border-teal bg-teal/5' : 'border-slate/30 bg-surface hover:bg-cloud',
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="mt-1 h-5 w-5 shrink-0 accent-teal"
              />
              <span>
                <span className="block font-medium text-ink">{o.label}</span>
                {o.description ? <span className="block text-body text-slate">{o.description}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Checkbox({
  name,
  label,
  checked,
  onChange,
  error,
}: {
  name: string;
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  error?: string | null;
}) {
  const ids = fieldIds(name);
  return (
    <div className="mb-5">
      {error ? (
        <p id={ids.error} className="mb-2 flex items-start gap-1.5 text-body font-medium text-error">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      <label htmlFor={ids.input} className="flex min-h-[44px] cursor-pointer items-start gap-3 text-base text-ink">
        <input
          id={ids.input}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? ids.error : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-teal"
        />
        <span>{label}</span>
      </label>
    </div>
  );
}

type Variant = 'primary' | 'secondary';
export const PortalButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }>(
  function PortalButton({ variant = 'primary', busy, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold transition-colors disabled:cursor-not-allowed',
          variant === 'primary' ? 'bg-teal text-white hover:bg-teal/90 disabled:bg-teal/50' : 'border border-slate/40 bg-surface text-ink hover:bg-cloud',
          className,
        )}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        {...rest}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);

/** Error summary (GOV.UK pattern): focused on appear, each error links to its field. */
export function ErrorSummary({ errors, title }: { errors: Array<{ field: string; message: string }>; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = errors.map((e) => `${e.field}:${e.message}`).join('|');
  useEffect(() => {
    if (errors.length) ref.current?.focus();
    // Focus again only when the set of errors changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  if (!errors.length) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" aria-labelledby="error-summary-title" className="mb-6 rounded-lg border-2 border-error bg-error/5 p-4 focus:outline-none focus:ring-2 focus:ring-error/40">
      <h2 id="error-summary-title" className="flex items-center gap-2 text-section font-semibold text-error">
        <AlertTriangle className="h-5 w-5" aria-hidden />
        {title}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-base">
        {errors.map((e) => (
          <li key={`${e.field}-${e.message}`}>
            <a
              href={`#${fieldIds(e.field).input}`}
              className="font-medium text-error underline"
              onClick={(ev) => {
                const el = document.getElementById(fieldIds(e.field).input);
                if (el) {
                  ev.preventDefault();
                  el.focus();
                  el.scrollIntoView({ block: 'center' });
                }
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type MessageTone = 'info' | 'warning' | 'error' | 'success';
const MESSAGE_TONES: Record<MessageTone, { cls: string; icon: typeof Info; iconCls: string }> = {
  info: { cls: 'border-deep-blue/25 bg-deep-blue/5', icon: Info, iconCls: 'text-deep-blue' },
  warning: { cls: 'border-gold/60 bg-gold/10', icon: AlertTriangle, iconCls: 'text-[#7a5a17]' },
  error: { cls: 'border-error/40 bg-error/5', icon: XCircle, iconCls: 'text-error' },
  success: { cls: 'border-success/40 bg-success/5', icon: CheckCircle2, iconCls: 'text-success' },
};

/** Inline message with icon and words (never colour alone). */
export function Message({ tone = 'info', title, children, className }: { tone?: MessageTone; title?: ReactNode; children?: ReactNode; className?: string }) {
  const spec = MESSAGE_TONES[tone];
  const Icon = spec.icon;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-lg border p-3 text-base', spec.cls, className)}>
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', spec.iconCls)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-ink">{title}</p> : null}
        {children ? <div className={cn('text-ink/90', title ? 'mt-0.5' : '')}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Panel({ title, children, className, id }: { title?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('rounded-card border border-line bg-surface p-4 shadow-card sm:p-6', className)} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {title ? (
        <h2 id={id ? `${id}-title` : undefined} className="mb-4 text-section font-semibold text-navy">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

export function PageTitle({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-[24px] font-semibold leading-8 text-navy sm:text-page">{title}</h1>
      {intro ? <p className="mt-2 max-w-2xl text-base text-slate">{intro}</p> : null}
    </div>
  );
}

/** Loading / not-found / error states for the whole page. */
export function PortalGate({ children }: { children: ReactNode }) {
  const { status, t, reload } = usePortal();
  if (status === 'loading') {
    return (
      <p className="flex items-center gap-2 py-12 text-base text-slate" role="status">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        {t('common.loading')}
      </p>
    );
  }
  if (status === 'not_found') {
    return (
      <Panel>
        <div className="flex flex-col items-start gap-2">
          <SearchX className="h-8 w-8 text-slate" aria-hidden />
          <h1 className="text-section font-semibold text-navy">{t('common.notFound.title')}</h1>
          <p className="text-base text-slate">{t('common.notFound.body')}</p>
        </div>
      </Panel>
    );
  }
  if (status === 'error') {
    return (
      <Message tone="error" title={t('common.error.generic')}>
        <button type="button" className="mt-2 font-semibold text-deep-blue underline" onClick={() => void reload()}>
          {t('common.retry')}
        </button>
      </Message>
    );
  }
  return <>{children}</>;
}

/** Visually hidden honeypot. Real people never see or fill it. */
export function Honeypot({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label htmlFor={`hp-${name}`}>Leave this field empty</label>
      <input id={`hp-${name}`} type="text" name={name} tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
