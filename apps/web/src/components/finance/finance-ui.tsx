'use client';

/**
 * Finance presentation pieces: status badges (word + icon), money cells,
 * compliance findings with the setting's legal source note and an
 * "Unverified" badge, and the export-classification line.
 */
import {
  type ComplianceFinding,
  type ComplianceFlag,
  FINANCE_TRANSACTION_STATUS_LABELS,
  type FinanceTransactionStatus,
  type MoneyMinor,
  UNVERIFIED_LIMIT_LABEL,
} from '@ngao360/shared';
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, HelpCircle, Octagon, RotateCcw, Scale, Wallet, XCircle } from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { findingViews, flagLabels, money } from './finance-model';

const STATUS_SPEC: Record<FinanceTransactionStatus, { tone: Tone; icon: typeof CheckCircle2 }> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  REQUESTED: { tone: 'pending', icon: Clock },
  APPROVED: { tone: 'info', icon: CheckCircle2 },
  PAID: { tone: 'success', icon: Wallet },
  REJECTED: { tone: 'danger', icon: XCircle },
  CANCELLED: { tone: 'muted', icon: Ban },
  REVERSED: { tone: 'muted', icon: RotateCcw },
};

export function TransactionStatusBadge({ status, size }: { status: FinanceTransactionStatus; size?: 'sm' | 'md' }) {
  const s = STATUS_SPEC[status];
  return <StatusBadge kind="custom" status={status} label={FINANCE_TRANSACTION_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

/** "Unverified – configure to the applicable law" badge (blueprint 15.3; never colour alone). */
export function UnverifiedBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <StatusBadge kind="custom" status="UNVERIFIED" label={UNVERIFIED_LIMIT_LABEL} tone="pending" icon={HelpCircle} size={size} />;
}

export function VerifiedBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <StatusBadge kind="custom" status="VERIFIED" label="Verified" tone="success" icon={CheckCircle2} size={size} />;
}

/** Right-aligned tabular money from integer minor units. */
export function Money({ value, className, strong }: { value: MoneyMinor | null | undefined; className?: string; strong?: boolean }) {
  return <span className={cn('whitespace-nowrap tabular-nums', strong && 'font-semibold text-ink', className)}>{money(value)}</span>;
}

/**
 * Compliance findings: each with the plain-language message, the level as a
 * word (warning / blocks approval), the unverified badge where the setting is
 * unverified, and the setting's legal source note.
 */
export function ComplianceFindings({ findings, emptyText, compact }: { findings: readonly ComplianceFinding[]; emptyText?: string; compact?: boolean }) {
  const views = findingViews(findings);
  if (views.length === 0) return emptyText ? <p className="text-body text-slate">{emptyText}</p> : null;
  return (
    <ul className="space-y-2" aria-label="Limit findings">
      {views.map((v) => (
        <li key={v.key} className={cn('rounded-lg border px-3 py-2', v.level === 'BLOCK' ? 'border-error/30 bg-error/5' : 'border-gold/50 bg-gold/10')}>
          <div className="flex flex-wrap items-center gap-2">
            {v.level === 'BLOCK' ? <Octagon className="h-4 w-4 text-error" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-[#7a5a17]" aria-hidden />}
            <span className="font-semibold text-ink">{v.title}</span>
            <span className="text-meta font-medium text-slate">{v.level === 'BLOCK' ? 'Blocks approval' : 'Warning'}</span>
            {v.unverified ? <UnverifiedBadge /> : null}
          </div>
          <p className="mt-0.5 text-body text-ink">{v.message}</p>
          {!compact && v.legalSourceNote ? (
            <p className="mt-1 flex items-start gap-1 text-meta text-slate">
              <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Legal source (as configured): </span>
                {v.legalSourceNote}
              </span>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Compact flag chips for ledger rows. */
export function FlagChips({ flags }: { flags: readonly ComplianceFlag[] }) {
  if (flags.length === 0) return <span className="text-slate">—</span>;
  const { labels, unverified } = flagLabels(flags);
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l} className="inline-flex items-center gap-1 rounded-md border border-gold/40 bg-gold/15 px-1.5 py-0.5 text-[11px] font-medium text-[#7a5a17]">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {l}
        </span>
      ))}
      {unverified ? <UnverifiedBadge /> : null}
    </span>
  );
}
