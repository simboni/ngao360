'use client';

/**
 * Touch-first building blocks for the field PWA (blueprint 11.3, 12):
 * targets at least 48px high, one column, readable at 360px wide, no
 * images or web fonts beyond the app's own.
 */
import type { PermissionKey } from '@ngao360/shared';
import { AlertTriangle, CheckCircle2, Info, ShieldOff, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useMobileSession } from './mobile-session';

type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';
const TONES: Record<Tone, string> = {
  primary: 'bg-teal text-white active:bg-teal/90 disabled:bg-teal/50',
  secondary: 'border border-line bg-surface text-ink active:bg-cloud disabled:text-slate',
  danger: 'bg-error text-white active:bg-error/90 disabled:bg-error/50',
  ghost: 'text-teal active:bg-cloud',
};

export function BigButton({
  tone = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; loading?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 text-card font-semibold disabled:cursor-not-allowed',
        TONES[tone],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function BigLink({ href, icon: Icon, title, hint, tone = 'secondary' }: { href: string; icon: LucideIcon; title: string; hint?: string; tone?: 'primary' | 'secondary' }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-h-[64px] items-center gap-3 rounded-xl px-4 py-3',
        tone === 'primary' ? 'bg-teal text-white' : 'border border-line bg-surface text-ink',
      )}
    >
      <Icon className="h-6 w-6 shrink-0" aria-hidden />
      <span className="flex flex-col">
        <span className="text-card font-semibold">{title}</span>
        {hint ? <span className={cn('text-meta', tone === 'primary' ? 'text-white/85' : 'text-slate')}>{hint}</span> : null}
      </span>
    </Link>
  );
}

export function MobileCard({ title, children, className, action }: { title?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn('ngao-card p-4', className)}>
      {title ? (
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="text-card font-semibold text-navy">{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-[20px] font-semibold leading-7 text-navy">{children}</h1>
      {sub ? <p className="mt-1 text-body text-slate">{sub}</p> : null}
    </div>
  );
}

const NOTICE: Record<'info' | 'warning' | 'error' | 'success', { cls: string; icon: LucideIcon }> = {
  info: { cls: 'border-deep-blue/20 bg-deep-blue/5 text-ink', icon: Info },
  warning: { cls: 'border-gold/50 bg-gold/10 text-ink', icon: AlertTriangle },
  error: { cls: 'border-error/40 bg-error/5 text-ink', icon: AlertTriangle },
  success: { cls: 'border-success/40 bg-success/5 text-ink', icon: CheckCircle2 },
};

export function Notice({ tone = 'info', title, children, role }: { tone?: keyof typeof NOTICE; title?: ReactNode; children?: ReactNode; role?: 'status' | 'alert' }) {
  const { cls, icon: Icon } = NOTICE[tone];
  return (
    <div className={cn('flex gap-2 rounded-xl border p-3 text-body', cls)} role={role}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5' : ''}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-body font-medium text-ink" htmlFor={htmlFor}>
        {label}
      </label>
      {hint ? <p className="text-meta text-slate">{hint}</p> : null}
      {children}
      {error ? (
        <p className="text-meta font-medium text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputCls =
  'min-h-[48px] w-full rounded-xl border border-line bg-surface px-3 text-card text-ink placeholder:text-slate focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30';

/** Bottom sheet dialog for confirmations (sign-out warning, discard). */
export function Sheet({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-navy/40" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="w-full max-w-lg rounded-t-2xl bg-surface p-4 pb-6 shadow-card focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={id} className="mb-3 text-section font-semibold text-navy">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** Screen guard using the mobile session (works offline from the encrypted snapshot). */
export function MobileGate({ anyOf, module, children }: { anyOf: PermissionKey[]; module?: 'tally'; children: ReactNode }) {
  const { can, moduleEnabled } = useMobileSession();
  if (!anyOf.some((p) => can(p)) || (module && !moduleEnabled(module))) {
    return (
      <div className="ngao-card">
        <EmptyState icon={ShieldOff} title="Not available to you" description="Your account does not include this part of the field app. Ask your coordinator if you need it." />
      </div>
    );
  }
  return <>{children}</>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-body text-slate" role="status" aria-live="polite">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden />
      {label}
    </div>
  );
}

/** "Shown from this phone" marker when data comes from the encrypted copy. */
export function SourceNote({ source, savedAt }: { source: 'server' | 'phone' | null; savedAt: string | null }) {
  if (source !== 'phone') return null;
  return (
    <p className="text-meta text-slate">
      Shown from the copy saved on this phone{savedAt ? ` (${formatDateTime(savedAt)})` : ''}. It may be out of date.
    </p>
  );
}
