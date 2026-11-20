import { AlertTriangle, CheckCircle2, Info, ShieldAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type NoticeTone = 'info' | 'warning' | 'error' | 'success' | 'sod';

const TONES: Record<NoticeTone, { cls: string; icon: typeof Info }> = {
  info: { cls: 'border-deep-blue/20 bg-deep-blue/5 text-ink', icon: Info },
  warning: { cls: 'border-gold/50 bg-gold/10 text-ink', icon: AlertTriangle },
  error: { cls: 'border-error/30 bg-error/5 text-ink', icon: XCircle },
  success: { cls: 'border-success/30 bg-success/5 text-ink', icon: CheckCircle2 },
  sod: { cls: 'border-deep-blue/30 bg-deep-blue/5 text-ink', icon: ShieldAlert },
};

const ICON_COLOUR: Record<NoticeTone, string> = {
  info: 'text-deep-blue',
  warning: 'text-[#7a5a17]',
  error: 'text-error',
  success: 'text-success',
  sod: 'text-deep-blue',
};

/**
 * Inline message block with an icon and a word title (never colour alone).
 * `role="alert"` for errors so screen readers announce them immediately.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const spec = TONES[tone];
  const Icon = spec.icon;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5', spec.cls, className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_COLOUR[tone])} aria-hidden />
      <div className="min-w-0 flex-1 text-body">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title ? 'mt-0.5' : '', 'text-slate')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
