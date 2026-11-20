import {
  ACCREDITATION_STATUS_LABELS,
  AGENT_AVAILABILITY_LABELS,
  AGENT_STATUS_LABELS,
  type AccreditationStatus,
  type AgentAvailability,
  type AgentStatus,
  DEPLOYMENT_STATUS_LABELS,
  type DeploymentStatus,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_STATUS_LABELS,
  type IncidentSeverity,
  type IncidentStatus,
  READINESS_ITEM_STATUS_LABELS,
  READINESS_STATUS_LABELS,
  type ReadinessItemStatus,
  type ReadinessStatus,
  TRAINING_STATUS_LABELS,
  type TrainingStatus,
} from '@ngao360/shared';
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  Clock,
  type LucideIcon,
  LogOut,
  MinusCircle,
  PauseCircle,
  Radio,
  Replace,
  SignalHigh,
  SignalLow,
  SignalMedium,
  UserCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';

/**
 * Field status badges: always a word AND an icon, never colour alone
 * (blueprint 12.2). Tones follow the blueprint 12.1 palette: teal/success for
 * done, gold for pending or attention, error red for blocked and critical only.
 */
type Spec = { tone: Tone; icon: LucideIcon };

const AGENT: Record<AgentStatus, Spec> = {
  RECRUITED: { tone: 'info', icon: UserPlus },
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  STANDBY: { tone: 'pending', icon: PauseCircle },
  INACTIVE: { tone: 'muted', icon: MinusCircle },
  WITHDRAWN: { tone: 'muted', icon: Ban },
};

const AVAILABILITY: Record<AgentAvailability, Spec> = {
  AVAILABLE: { tone: 'success', icon: CheckCircle2 },
  LIMITED: { tone: 'pending', icon: Clock },
  UNAVAILABLE: { tone: 'muted', icon: CircleSlash },
};

const ACCREDITATION: Record<AccreditationStatus, Spec> = {
  NOT_SUBMITTED: { tone: 'muted', icon: CircleDashed },
  SUBMITTED: { tone: 'info', icon: ArrowUpRight },
  PENDING: { tone: 'pending', icon: Clock },
  APPROVED: { tone: 'success', icon: CheckCircle2 },
  REJECTED: { tone: 'danger', icon: XCircle },
  EXPIRED: { tone: 'danger', icon: AlertTriangle },
  NOT_APPLICABLE: { tone: 'muted', icon: MinusCircle },
};

const TRAINING: Record<TrainingStatus, Spec> = {
  SCHEDULED: { tone: 'info', icon: Clock },
  ATTENDED: { tone: 'info', icon: UserCheck },
  COMPLETED: { tone: 'success', icon: CheckCircle2 },
  NOT_PASSED: { tone: 'pending', icon: AlertTriangle },
  ABSENT: { tone: 'muted', icon: CircleSlash },
};

const DEPLOYMENT: Record<DeploymentStatus, Spec> = {
  ASSIGNED: { tone: 'info', icon: UserCheck },
  CONFIRMED: { tone: 'info', icon: CheckCircle2 },
  CHECKED_IN: { tone: 'success', icon: Radio },
  CHECKED_OUT: { tone: 'muted', icon: LogOut },
  REPLACED: { tone: 'muted', icon: Replace },
  CANCELLED: { tone: 'muted', icon: Ban },
};

const READINESS: Record<ReadinessStatus, Spec> = {
  NOT_STARTED: { tone: 'muted', icon: CircleDashed },
  IN_PROGRESS: { tone: 'pending', icon: Clock },
  READY: { tone: 'success', icon: CheckCircle2 },
  BLOCKED: { tone: 'danger', icon: XCircle },
};

const READINESS_ITEM: Record<ReadinessItemStatus, Spec> = {
  NOT_STARTED: { tone: 'muted', icon: CircleDashed },
  IN_PROGRESS: { tone: 'pending', icon: Clock },
  DONE: { tone: 'success', icon: CheckCircle2 },
  BLOCKED: { tone: 'danger', icon: XCircle },
  NOT_APPLICABLE: { tone: 'muted', icon: MinusCircle },
};

const SEVERITY: Record<IncidentSeverity, Spec> = {
  LOW: { tone: 'muted', icon: SignalLow },
  MEDIUM: { tone: 'pending', icon: SignalMedium },
  HIGH: { tone: 'danger', icon: SignalHigh },
  CRITICAL: { tone: 'danger', icon: AlertOctagon },
};

const INCIDENT: Record<IncidentStatus, Spec> = {
  REPORTED: { tone: 'pending', icon: Circle },
  TRIAGED: { tone: 'info', icon: CheckCircle2 },
  ASSIGNED: { tone: 'info', icon: UserCheck },
  ESCALATED: { tone: 'danger', icon: ArrowUpRight },
  RESOLVED: { tone: 'pending', icon: Clock },
  CLOSED: { tone: 'muted', icon: Archive },
};

type Size = { size?: 'sm' | 'md'; className?: string };

export function AgentStatusBadge({ status, ...rest }: { status: AgentStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={AGENT_STATUS_LABELS[status]} {...AGENT[status]} {...rest} />;
}
export function AvailabilityBadge({ status, ...rest }: { status: AgentAvailability } & Size) {
  return <StatusBadge kind="custom" status={status} label={AGENT_AVAILABILITY_LABELS[status]} {...AVAILABILITY[status]} {...rest} />;
}
export function AccreditationBadge({ status, ...rest }: { status: AccreditationStatus | null } & Size) {
  if (!status) return <StatusBadge kind="custom" status="NONE" label="No record" tone="muted" icon={CircleDashed} {...rest} />;
  return <StatusBadge kind="custom" status={status} label={ACCREDITATION_STATUS_LABELS[status]} {...ACCREDITATION[status]} {...rest} />;
}
export function TrainingStatusBadge({ status, ...rest }: { status: TrainingStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={TRAINING_STATUS_LABELS[status]} {...TRAINING[status]} {...rest} />;
}
export function DeploymentStatusBadge({ status, ...rest }: { status: DeploymentStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={DEPLOYMENT_STATUS_LABELS[status]} {...DEPLOYMENT[status]} {...rest} />;
}
export function ReadinessStatusBadge({ status, ...rest }: { status: ReadinessStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={READINESS_STATUS_LABELS[status]} {...READINESS[status]} {...rest} />;
}
export function ReadinessItemBadge({ status, ...rest }: { status: ReadinessItemStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={READINESS_ITEM_STATUS_LABELS[status]} {...READINESS_ITEM[status]} {...rest} />;
}
export function SeverityBadge({ severity, ...rest }: { severity: IncidentSeverity } & Size) {
  return <StatusBadge kind="custom" status={severity} label={INCIDENT_SEVERITY_LABELS[severity]} {...SEVERITY[severity]} {...rest} />;
}
export function IncidentStatusBadge({ status, ...rest }: { status: IncidentStatus } & Size) {
  return <StatusBadge kind="custom" status={status} label={INCIDENT_STATUS_LABELS[status]} {...INCIDENT[status]} {...rest} />;
}

/** Badge spec lookups for tests and legends. */
export const FIELD_BADGE_SPECS = { AGENT, ACCREDITATION, DEPLOYMENT, READINESS, READINESS_ITEM, SEVERITY, INCIDENT, TRAINING } as const;
