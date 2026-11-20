import {
  CORRESPONDENCE_DIRECTION_LABELS,
  CORRESPONDENCE_STATUS_LABELS,
  type CorrespondenceDirection,
  type CorrespondenceStatus,
} from '@ngao360/shared';
import {
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CircleDashed,
  FolderClosed,
  Inbox,
  type LucideIcon,
  MailCheck,
  Send,
  UserCheck,
  Wrench,
} from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import type { Deadline, DeadlineKind } from './correspondence-model';

const STATUS: Record<CorrespondenceStatus, { tone: Tone; icon: LucideIcon }> = {
  DRAFT: { tone: 'muted', icon: CircleDashed },
  RECEIVED: { tone: 'info', icon: Inbox },
  ASSIGNED: { tone: 'info', icon: UserCheck },
  IN_PROGRESS: { tone: 'pending', icon: Wrench },
  RESPONDED: { tone: 'success', icon: MailCheck },
  SENT: { tone: 'success', icon: Send },
  FILED: { tone: 'muted', icon: FolderClosed },
  ARCHIVED: { tone: 'muted', icon: Archive },
};

export function CorrespondenceStatusBadge({ status, size }: { status: CorrespondenceStatus; size?: 'sm' | 'md' }) {
  const s = STATUS[status];
  return <StatusBadge kind="custom" status={status} label={CORRESPONDENCE_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

export function DirectionBadge({ direction, size }: { direction: CorrespondenceDirection; size?: 'sm' | 'md' }) {
  return (
    <StatusBadge
      kind="custom"
      status={direction}
      label={CORRESPONDENCE_DIRECTION_LABELS[direction]}
      tone={direction === 'INCOMING' ? 'info' : 'neutral'}
      icon={direction === 'INCOMING' ? ArrowDownLeft : ArrowUpRight}
      size={size}
    />
  );
}

const DEADLINE: Record<Exclude<DeadlineKind, 'none'>, { tone: Tone; icon: LucideIcon }> = {
  overdue: { tone: 'danger', icon: CalendarX },
  due_today: { tone: 'pending', icon: CalendarClock },
  due_soon: { tone: 'pending', icon: CalendarClock },
  scheduled: { tone: 'muted', icon: CalendarCheck },
};

/** Overdue / due-soon badge: word plus icon, never colour alone. Renders nothing when no deadline applies. */
export function DeadlineBadge({ deadline, size }: { deadline: Deadline; size?: 'sm' | 'md' }) {
  if (deadline.kind === 'none') return null;
  const s = DEADLINE[deadline.kind];
  return <StatusBadge kind="custom" status={deadline.kind} label={deadline.label} tone={s.tone} icon={s.icon} size={size} />;
}
