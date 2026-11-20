import {
  PROJECT_STAGE_KIND_LABELS,
  PROJECT_STATUS_LABELS,
  type ProjectStageKind,
  type ProjectStatus,
  VERIFICATION_STATUS_LABELS,
  type VerificationStatus,
} from '@ngao360/shared';
import {
  AlertTriangle,
  Ban,
  BadgeCheck,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  Clock,
  Construction,
  FileSignature,
  Gavel,
  HandCoins,
  HelpCircle,
  type LucideIcon,
  MessageSquareQuote,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
} from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';

const STATUS: Record<ProjectStatus, { tone: Tone; icon: LucideIcon }> = {
  PROPOSED: { tone: 'muted', icon: CircleDashed },
  COMMITTED: { tone: 'neutral', icon: MessageSquareQuote },
  APPROVED: { tone: 'info', icon: Gavel },
  FUNDED: { tone: 'info', icon: HandCoins },
  PROCUREMENT: { tone: 'info', icon: ShoppingCart },
  ONGOING: { tone: 'info', icon: Construction },
  DELAYED: { tone: 'danger', icon: AlertTriangle },
  COMPLETED: { tone: 'pending', icon: ClipboardCheck },
  VERIFIED_COMPLETED: { tone: 'success', icon: BadgeCheck },
  CANCELLED: { tone: 'muted', icon: Ban },
};

export function ProjectStatusBadge({ status, size }: { status: ProjectStatus; size?: 'sm' | 'md' }) {
  const s = STATUS[status];
  return <StatusBadge kind="custom" status={status} label={PROJECT_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

const STAGE: Record<ProjectStageKind, { tone: Tone; icon: LucideIcon }> = {
  COMMITMENT: { tone: 'neutral', icon: MessageSquareQuote },
  APPROVED: { tone: 'info', icon: FileSignature },
  IMPLEMENTATION: { tone: 'info', icon: Construction },
  REPORTED_COMPLETE: { tone: 'pending', icon: ClipboardCheck },
  VERIFIED_COMPLETE: { tone: 'success', icon: BadgeCheck },
  CANCELLED: { tone: 'muted', icon: Ban },
};

/** Commitment / approved / implementation / reported complete / verified complete, always in words. */
export function StageKindBadge({ stage, size }: { stage: ProjectStageKind; size?: 'sm' | 'md' }) {
  const s = STAGE[stage];
  return <StatusBadge kind="custom" status={stage} label={PROJECT_STAGE_KIND_LABELS[stage]} tone={s.tone} icon={s.icon} size={size} />;
}

const VERIFICATION: Record<VerificationStatus, { tone: Tone; icon: LucideIcon }> = {
  UNVERIFIED: { tone: 'muted', icon: HelpCircle },
  PENDING_VERIFICATION: { tone: 'pending', icon: Clock },
  VERIFIED: { tone: 'success', icon: ShieldCheck },
  DISPUTED: { tone: 'danger', icon: ShieldAlert },
};

export function VerificationBadge({ status, size, prefix }: { status: VerificationStatus; size?: 'sm' | 'md'; prefix?: string }) {
  const s = VERIFICATION[status];
  const label = prefix ? `${prefix}: ${VERIFICATION_STATUS_LABELS[status].toLowerCase()}` : VERIFICATION_STATUS_LABELS[status];
  return <StatusBadge kind="custom" status={status} label={label} tone={s.tone} icon={s.icon} size={size} />;
}

export function PublishedBadge({ isPublic, size }: { isPublic: boolean; size?: 'sm' | 'md' }) {
  return isPublic ? (
    <StatusBadge kind="custom" status="public" label="On public portal" tone="info" icon={CheckCircle2} size={size} />
  ) : (
    <StatusBadge kind="custom" status="internal" label="Internal only" tone="muted" icon={CircleDashed} size={size} />
  );
}
