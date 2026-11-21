'use client';

/**
 * Small presentational pieces of the account-recovery screens (CR AR8): the status badge (word and
 * icon, never colour alone) and an action button that, when the rules refuse it, stays visible but
 * disabled with the reason next to it.
 */
import type { AccountRecoveryStatus } from '@ngao360/shared';
import { Ban, CheckCircle2, Clock, Hourglass, KeyRound, type LucideIcon, XCircle } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { RECOVERY_STATUS_SHORT, RECOVERY_STATUS_TONES, type ActionRule } from './recovery-model';

const ICONS: Record<AccountRecoveryStatus, LucideIcon> = {
  PENDING: Hourglass,
  APPROVED: KeyRound,
  REJECTED: XCircle,
  COMPLETED: CheckCircle2,
  EXPIRED: Clock,
  CANCELLED: Ban,
};

export function RecoveryStatusBadge({ status, size }: { status: AccountRecoveryStatus; size?: 'sm' | 'md' }) {
  return <StatusBadge kind="custom" status={status} label={RECOVERY_STATUS_SHORT[status]} tone={RECOVERY_STATUS_TONES[status]} icon={ICONS[status]} size={size} />;
}

export function RuleButton({
  rule,
  onClick,
  children,
  variant = 'secondary',
}: {
  rule: ActionRule;
  onClick: () => void;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant={variant} onClick={onClick} disabled={!rule.allowed} aria-describedby={rule.reason ? hintId : undefined}>
        {children}
      </Button>
      {rule.reason ? (
        <p id={hintId} className="max-w-xs text-meta text-slate">
          {rule.reason}
        </p>
      ) : null}
    </div>
  );
}
