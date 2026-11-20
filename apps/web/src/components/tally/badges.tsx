import { DISCREPANCY_TYPE_LABELS, type DiscrepancySeverity, type DiscrepancyType } from '@ngao360/shared';
import { AlertOctagon, AlertTriangle, ArrowDown, Ban, CheckCircle2, CircleDashed, Copy, FileInput, Gauge, Minus, Star } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StationCoverageStatus } from './types';

export function DuplicateBadge() {
  return <StatusBadge kind="custom" status="duplicate" label="Possible duplicate" tone="pending" icon={Copy} size="sm" />;
}

export function CanonicalBadge() {
  return <StatusBadge kind="custom" status="canonical" label="Canonical record" tone="info" icon={Star} size="sm" />;
}

const SEVERITY: Record<DiscrepancySeverity, { label: string; tone: 'muted' | 'info' | 'pending' | 'danger'; icon: typeof Minus }> = {
  LOW: { label: 'Low', tone: 'muted', icon: ArrowDown },
  MEDIUM: { label: 'Medium', tone: 'info', icon: Minus },
  HIGH: { label: 'High', tone: 'pending', icon: AlertTriangle },
  CRITICAL: { label: 'Critical', tone: 'danger', icon: AlertOctagon },
};

export function SeverityBadge({ severity }: { severity: DiscrepancySeverity }) {
  const s = SEVERITY[severity];
  return <StatusBadge kind="custom" status={severity} label={`${s.label} severity`} tone={s.tone} icon={s.icon} size="sm" />;
}

export function IssueTypeBadge({ type }: { type: DiscrepancyType }) {
  return <StatusBadge kind="custom" status={type} label={DISCREPANCY_TYPE_LABELS[type]} tone="neutral" icon={Gauge} size="sm" />;
}

const COVERAGE: Record<StationCoverageStatus, { label: string; tone: 'muted' | 'info' | 'success' | 'danger'; icon: typeof Minus }> = {
  MISSING: { label: 'Missing (no form)', tone: 'muted', icon: CircleDashed },
  RECEIVED: { label: 'Received, not verified', tone: 'info', icon: FileInput },
  VERIFIED: { label: 'Verified, included', tone: 'success', icon: CheckCircle2 },
  FLAGGED: { label: 'Flagged', tone: 'danger', icon: AlertTriangle },
  EXCLUDED: { label: 'Excluded', tone: 'muted', icon: Ban },
};

export const COVERAGE_LABELS: Record<StationCoverageStatus, string> = Object.fromEntries(
  Object.entries(COVERAGE).map(([k, v]) => [k, v.label]),
) as Record<StationCoverageStatus, string>;

export function CoverageBadge({ status }: { status: StationCoverageStatus }) {
  const s = COVERAGE[status];
  return <StatusBadge kind="custom" status={status} label={s.label} tone={s.tone} icon={s.icon} size="sm" />;
}

/** OCR confidence as a word + icon; OCR is a draft and never approves a value. */
export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return <span className="text-meta text-slate">No OCR</span>;
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.9) return <StatusBadge kind="custom" status="hi" label={`High ${pct}%`} tone="info" icon={Gauge} size="sm" />;
  if (confidence >= 0.6) return <StatusBadge kind="custom" status="mid" label={`Medium ${pct}%`} tone="pending" icon={Gauge} size="sm" />;
  return <StatusBadge kind="custom" status="lo" label={`Low ${pct}% · check`} tone="danger" icon={AlertTriangle} size="sm" />;
}
