import { APPOINTMENT_STATUS_LABELS, type AppointmentStatus, MEETING_STATUS_LABELS, type MeetingStatus } from '@ngao360/shared';
import { Ban, CalendarCheck, CalendarClock, CalendarX, CheckCircle2, Clock, type LucideIcon, Repeat, UserX, Users } from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';

const APPOINTMENT: Record<AppointmentStatus, { tone: Tone; icon: LucideIcon }> = {
  REQUESTED: { tone: 'pending', icon: Clock },
  CONFIRMED: { tone: 'info', icon: CalendarCheck },
  RESCHEDULED: { tone: 'info', icon: Repeat },
  DECLINED: { tone: 'muted', icon: CalendarX },
  CANCELLED: { tone: 'muted', icon: Ban },
  COMPLETED: { tone: 'success', icon: CheckCircle2 },
  NO_SHOW: { tone: 'danger', icon: UserX },
};

export function AppointmentStatusBadge({ status, size }: { status: AppointmentStatus; size?: 'sm' | 'md' }) {
  const s = APPOINTMENT[status];
  return <StatusBadge kind="custom" status={status} label={APPOINTMENT_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}

const MEETING: Record<MeetingStatus, { tone: Tone; icon: LucideIcon }> = {
  SCHEDULED: { tone: 'info', icon: CalendarClock },
  HELD: { tone: 'success', icon: Users },
  CANCELLED: { tone: 'muted', icon: Ban },
};

export function MeetingStatusBadge({ status, size }: { status: MeetingStatus; size?: 'sm' | 'md' }) {
  const s = MEETING[status];
  return <StatusBadge kind="custom" status={status} label={MEETING_STATUS_LABELS[status]} tone={s.tone} icon={s.icon} size={size} />;
}
