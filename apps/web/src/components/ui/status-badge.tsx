import {
  DATA_PROVENANCE_LABELS,
  DISCREPANCY_STATUS_LABELS,
  type DataProvenance,
  type DiscrepancyStatus,
  FORM_TEMPLATE_APPROVAL_STATE_LABELS,
  type FormTemplateApprovalState,
  OPERATIONAL_STATUS_LABELS,
  type OperationalStatus,
  SUBMISSION_STATUS_LABELS,
  type SubmissionStatus,
  USER_STATUS_LABELS,
  type UserStatus,
  VALIDATION_OUTCOME_LABELS,
  type ValidationOutcome,
} from '@ngao360/shared';
import {
  AlertTriangle,
  Archive,
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock,
  Eye,
  FileCheck2,
  FileInput,
  FlaskConical,
  History,
  Lock,
  type LucideIcon,
  MailQuestion,
  PauseCircle,
  Radio,
  RotateCcw,
  ScanText,
  ShieldAlert,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'info' | 'pending' | 'success' | 'danger' | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'bg-cloud text-ink border-line',
  info: 'bg-deep-blue/10 text-deep-blue border-deep-blue/20',
  pending: 'bg-gold/15 text-[#7a5a17] border-gold/40',
  success: 'bg-success/10 text-success border-success/30',
  danger: 'bg-error/10 text-error border-error/30',
  muted: 'bg-slate/10 text-slate border-slate/20',
};

interface Spec {
  label: string;
  tone: Tone;
  icon: LucideIcon;
}

const SUBMISSION: Record<SubmissionStatus, Omit<Spec, 'label'>> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  SUBMITTED: { tone: 'info', icon: FileInput },
  OCR_COMPLETE: { tone: 'info', icon: ScanText },
  DATA_ENTRY_REVIEWED: { tone: 'info', icon: FileCheck2 },
  SECOND_REVIEW_PENDING: { tone: 'pending', icon: Clock },
  VERIFIED: { tone: 'success', icon: CheckCircle2 },
  RETURNED: { tone: 'pending', icon: RotateCcw },
  DISPUTED: { tone: 'danger', icon: ShieldAlert },
  QUARANTINED: { tone: 'danger', icon: Lock },
  EXCLUDED_FROM_AGGREGATE: { tone: 'muted', icon: Ban },
  ARCHIVED: { tone: 'muted', icon: Archive },
};

const OPERATIONAL: Record<OperationalStatus, Omit<Spec, 'label'>> = {
  NOT_ASSIGNED: { tone: 'muted', icon: Circle },
  ASSIGNED: { tone: 'info', icon: UserCheck },
  CONFIRMED: { tone: 'info', icon: CheckCircle2 },
  CHECKED_IN: { tone: 'success', icon: Radio },
  UPDATE_RECEIVED: { tone: 'info', icon: MailQuestion },
  FORM_EXPECTED: { tone: 'pending', icon: Clock },
  FORM_RECEIVED: { tone: 'info', icon: FileInput },
  VERIFICATION_PENDING: { tone: 'pending', icon: Eye },
  VERIFIED_FOR_PARALLEL_TALLY: { tone: 'success', icon: CheckCircle2 },
  FLAGGED: { tone: 'danger', icon: AlertTriangle },
  CLOSED: { tone: 'muted', icon: Archive },
};

const DISCREPANCY: Record<DiscrepancyStatus, Omit<Spec, 'label'>> = {
  OPEN: { tone: 'danger', icon: AlertTriangle },
  UNDER_REVIEW: { tone: 'pending', icon: Eye },
  ESCALATED: { tone: 'danger', icon: ShieldAlert },
  RESOLVED: { tone: 'success', icon: CheckCircle2 },
  CLOSED: { tone: 'muted', icon: Archive },
};

const VALIDATION: Record<ValidationOutcome, Omit<Spec, 'label'>> = {
  PASS: { tone: 'success', icon: CheckCircle2 },
  WARNING: { tone: 'pending', icon: AlertTriangle },
  FAIL: { tone: 'danger', icon: XCircle },
};

const TEMPLATE: Record<FormTemplateApprovalState, Omit<Spec, 'label'>> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  PENDING_APPROVAL: { tone: 'pending', icon: Clock },
  APPROVED: { tone: 'success', icon: CheckCircle2 },
  RETIRED: { tone: 'muted', icon: Archive },
};

const USER: Record<UserStatus, Omit<Spec, 'label'>> = {
  INVITED: { tone: 'info', icon: MailQuestion },
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  SUSPENDED: { tone: 'danger', icon: PauseCircle },
  DEACTIVATED: { tone: 'muted', icon: Ban },
};

const PROVENANCE: Record<DataProvenance, Omit<Spec, 'label'>> = {
  SYNTHETIC: { tone: 'info', icon: FlaskConical },
  HISTORICAL: { tone: 'pending', icon: History },
  LIVE: { tone: 'neutral', icon: Radio },
};

export type StatusBadgeProps =
  | { kind: 'submission'; status: SubmissionStatus }
  | { kind: 'operational'; status: OperationalStatus }
  | { kind: 'discrepancy'; status: DiscrepancyStatus }
  | { kind: 'validation'; status: ValidationOutcome }
  | { kind: 'template'; status: FormTemplateApprovalState }
  | { kind: 'user'; status: UserStatus }
  | { kind: 'provenance'; status: DataProvenance }
  | { kind: 'custom'; status: string; label: string; tone: Tone; icon: LucideIcon };

function resolve(props: StatusBadgeProps): Spec {
  switch (props.kind) {
    case 'submission':
      return { ...SUBMISSION[props.status], label: SUBMISSION_STATUS_LABELS[props.status] };
    case 'operational':
      return { ...OPERATIONAL[props.status], label: OPERATIONAL_STATUS_LABELS[props.status] };
    case 'discrepancy':
      return { ...DISCREPANCY[props.status], label: DISCREPANCY_STATUS_LABELS[props.status] };
    case 'validation':
      return { ...VALIDATION[props.status], label: VALIDATION_OUTCOME_LABELS[props.status] };
    case 'template':
      return { ...TEMPLATE[props.status], label: FORM_TEMPLATE_APPROVAL_STATE_LABELS[props.status] };
    case 'user':
      return { ...USER[props.status], label: USER_STATUS_LABELS[props.status] };
    case 'provenance':
      return { ...PROVENANCE[props.status], label: DATA_PROVENANCE_LABELS[props.status] };
    case 'custom':
      return { label: props.label, tone: props.tone, icon: props.icon };
  }
}

/**
 * Status badge: always a word AND an icon, never colour alone (blueprint 12.2).
 */
export function StatusBadge(props: StatusBadgeProps & { className?: string; size?: 'sm' | 'md' }) {
  const spec = resolve(props);
  const Icon = spec.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium',
        props.size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-meta',
        TONES[spec.tone],
        props.className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{spec.label}</span>
    </span>
  );
}
