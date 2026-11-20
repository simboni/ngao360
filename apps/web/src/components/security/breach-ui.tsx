'use client';

import { BREACH_STATUS_LABELS, type BreachSeverity, type BreachStatus } from '@ngao360/shared';
import { AlertOctagon, AlertTriangle, Archive, CheckCircle2, Eye, FileLock2, FlaskConical, Info, Megaphone, Search, ShieldCheck, Wrench } from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { BREACH_SEVERITY_LABELS } from './breach-model';

const STATUS: Record<BreachStatus, { tone: Tone; icon: typeof Info }> = {
  DETECTED: { tone: 'danger', icon: Eye },
  CONTAINED: { tone: 'pending', icon: ShieldCheck },
  EVIDENCE_PRESERVED: { tone: 'pending', icon: FileLock2 },
  ASSESSED: { tone: 'info', icon: Search },
  NOTIFIED: { tone: 'info', icon: Megaphone },
  REMEDIATED: { tone: 'success', icon: Wrench },
  CLOSED: { tone: 'muted', icon: Archive },
};

const SEVERITY: Record<BreachSeverity, { tone: Tone; icon: typeof Info }> = {
  LOW: { tone: 'muted', icon: Info },
  MEDIUM: { tone: 'pending', icon: AlertTriangle },
  HIGH: { tone: 'danger', icon: AlertTriangle },
  CRITICAL: { tone: 'danger', icon: AlertOctagon },
};

export function BreachStatusBadge({ status, size }: { status: BreachStatus; size?: 'sm' | 'md' }) {
  const s = STATUS[status];
  return <StatusBadge kind="custom" status={status} label={BREACH_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export function BreachSeverityBadge({ severity, size }: { severity: BreachSeverity; size?: 'sm' | 'md' }) {
  const s = SEVERITY[severity];
  return <StatusBadge kind="custom" status={severity} label={`${BREACH_SEVERITY_LABELS[severity]} severity`} tone={s.tone} icon={s.icon} size={size} />;
}

/** Drills are labelled everywhere (blueprint 15.4). */
export function DrillBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <StatusBadge kind="custom" status="DRILL" label="Drill (exercise)" tone="info" icon={FlaskConical} size={size} />;
}

export function LiveBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <StatusBadge kind="custom" status="LIVE" label="Real incident" tone="neutral" icon={CheckCircle2} size={size} />;
}
