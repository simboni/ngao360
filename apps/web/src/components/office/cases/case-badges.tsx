import {
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  type CasePriority,
  type CaseStatus,
  type CaseEventVisibility,
  REFERRAL_STATUS_LABELS,
  type ReferralStatus,
  type SensitivityLevel,
} from '@ngao360/shared';
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  ChevronsUp,
  CircleDashed,
  Clock,
  Eye,
  Globe2,
  Inbox,
  Lock,
  type LucideIcon,
  MessageSquareReply,
  Minus,
  RotateCcw,
  Search,
  Share2,
  ShieldAlert,
  UserCheck,
  Wrench,
} from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import type { Sla, SlaKind } from './sla';

const STATUS: Record<CaseStatus, { tone: Tone; icon: LucideIcon }> = {
  SUBMITTED: { tone: 'info', icon: Inbox },
  TRIAGE: { tone: 'pending', icon: Search },
  ASSIGNED: { tone: 'info', icon: UserCheck },
  IN_PROGRESS: { tone: 'info', icon: Wrench },
  REFERRED: { tone: 'neutral', icon: Share2 },
  RESOLUTION_PROPOSED: { tone: 'pending', icon: MessageSquareReply },
  CITIZEN_FEEDBACK: { tone: 'pending', icon: Clock },
  CLOSED: { tone: 'muted', icon: Archive },
  REOPENED: { tone: 'danger', icon: RotateCcw },
};

export function CaseStatusBadge({ status, size }: { status: CaseStatus; size?: 'sm' | 'md' }) {
  const s = STATUS[status];
  return <StatusBadge kind="custom" status={status} label={CASE_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

const PRIORITY: Record<CasePriority, { tone: Tone; icon: LucideIcon }> = {
  LOW: { tone: 'muted', icon: ArrowDown },
  MEDIUM: { tone: 'neutral', icon: Minus },
  HIGH: { tone: 'pending', icon: ArrowUp },
  URGENT: { tone: 'danger', icon: ChevronsUp },
};

export function PriorityBadge({ priority, size }: { priority: CasePriority; size?: 'sm' | 'md' }) {
  const s = PRIORITY[priority];
  return <StatusBadge kind="custom" status={priority} label={`${CASE_PRIORITY_LABELS[priority]} priority`} tone={s.tone} icon={s.icon} size={size} />;
}

const SLA: Record<SlaKind, { tone: Tone; icon: LucideIcon }> = {
  overdue: { tone: 'danger', icon: CalendarX },
  triage_late: { tone: 'danger', icon: AlarmClock },
  due_today: { tone: 'pending', icon: CalendarClock },
  due_soon: { tone: 'pending', icon: CalendarClock },
  scheduled: { tone: 'muted', icon: CalendarCheck },
  triage: { tone: 'info', icon: Search },
  no_review: { tone: 'pending', icon: CircleDashed },
  none: { tone: 'muted', icon: CheckCircle2 },
};

export function SlaBadge({ sla, size }: { sla: Sla; size?: 'sm' | 'md' }) {
  if (sla.kind === 'none') return null;
  const s = SLA[sla.kind];
  return <StatusBadge kind="custom" status={sla.kind} label={sla.label} tone={s.tone} icon={s.icon} size={size} />;
}

const REFERRAL: Record<ReferralStatus, { tone: Tone; icon: LucideIcon }> = {
  SENT: { tone: 'info', icon: Share2 },
  ACKNOWLEDGED: { tone: 'info', icon: Eye },
  RESPONDED: { tone: 'success', icon: CheckCircle2 },
  NO_RESPONSE: { tone: 'danger', icon: AlertTriangle },
  CLOSED: { tone: 'muted', icon: Archive },
};

export function ReferralStatusBadge({ status }: { status: ReferralStatus }) {
  const s = REFERRAL[status];
  return <StatusBadge kind="custom" status={status} label={REFERRAL_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size="sm" />;
}

export const SENSITIVITY_LABELS: Record<SensitivityLevel, string> = {
  PUBLIC: 'Public',
  INTERNAL: 'Internal',
  CONFIDENTIAL: 'Confidential',
  HIGHLY_RESTRICTED: 'Highly restricted',
};

export function SensitivityBadge({ level }: { level: SensitivityLevel }) {
  const restricted = level === 'CONFIDENTIAL' || level === 'HIGHLY_RESTRICTED';
  return (
    <StatusBadge kind="custom" status={level} label={SENSITIVITY_LABELS[level]} tone={restricted ? 'danger' : 'muted'} icon={restricted ? ShieldAlert : Lock} size="sm" />
  );
}

/**
 * Who can see a timeline entry. Public entries are shown to the requester on
 * the tracking page; internal entries never leave the office.
 */
export function VisibilityTag({ visibility, className }: { visibility: CaseEventVisibility; className?: string }) {
  const pub = visibility === 'PUBLIC';
  const Icon = pub ? Globe2 : Lock;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        pub ? 'border-teal/40 bg-teal/10 text-teal' : 'border-slate/30 bg-slate/10 text-slate',
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {pub ? 'Public · requester sees this' : 'Internal · staff only'}
    </span>
  );
}
