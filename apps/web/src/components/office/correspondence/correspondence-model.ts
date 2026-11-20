/**
 * Pure helpers for the S23 correspondence screens (deadline badges, the
 * transitions to offer and when a reason is required). They mirror API §9 so
 * the UI never offers a move the API would refuse; the API stays the authority.
 */
import {
  CORRESPONDENCE_STATUS_TRANSITIONS,
  type CorrespondenceDirection,
  type CorrespondenceStatus,
  type CorrespondenceSummary,
} from '@ngao360/shared';
import { daysBetween } from './office-common';

/** Statuses in which a response deadline no longer applies (API §9 `overdue`). */
export const CLOSED_CORRESPONDENCE_STATUSES: readonly CorrespondenceStatus[] = ['RESPONDED', 'SENT', 'FILED', 'ARCHIVED'];

export type DeadlineKind = 'overdue' | 'due_today' | 'due_soon' | 'scheduled' | 'none';

export interface Deadline {
  kind: DeadlineKind;
  label: string;
  days: number | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Response-deadline state. `overdue` from the API wins (it uses the server's
 * date); otherwise it is computed from `today` (YYYY-MM-DD, Africa/Nairobi).
 */
export function correspondenceDeadline(
  item: Pick<CorrespondenceSummary, 'responseDueDate' | 'status' | 'overdue'>,
  today: string,
): Deadline {
  if (!item.responseDueDate || CLOSED_CORRESPONDENCE_STATUSES.includes(item.status)) return { kind: 'none', label: '', days: null };
  const days = daysBetween(today, item.responseDueDate);
  if (item.overdue || days < 0) {
    const late = Math.max(1, -days);
    return { kind: 'overdue', label: `Overdue by ${plural(late, 'day')}`, days: -late };
  }
  if (days === 0) return { kind: 'due_today', label: 'Response due today', days };
  if (days <= 3) return { kind: 'due_soon', label: `Due in ${plural(days, 'day')}`, days };
  return { kind: 'scheduled', label: `Due in ${plural(days, 'day')}`, days };
}

export interface TransitionOption {
  to: CorrespondenceStatus;
  label: string;
  /** API §9: reason needed for filing without a response and for archiving. */
  reasonRequired: boolean;
  /** SENT records the dispatch time. */
  asksSentAt: boolean;
  hint?: string;
}

const LABELS: Partial<Record<CorrespondenceStatus, string>> = {
  ASSIGNED: 'Mark assigned',
  IN_PROGRESS: 'Start work',
  RESPONDED: 'Mark responded',
  SENT: 'Mark sent',
  FILED: 'File',
  ARCHIVED: 'Archive',
};

export function reasonRequiredFor(from: CorrespondenceStatus, to: CorrespondenceStatus): boolean {
  if (to === 'ARCHIVED') return true;
  return to === 'FILED' && (from === 'RECEIVED' || from === 'ASSIGNED' || from === 'IN_PROGRESS');
}

/**
 * Transitions to offer for an item. RECEIVED→ASSIGNED happens through the
 * assign action (an assignee is needed), so it is not offered as a bare move.
 */
export function correspondenceTransitions(status: CorrespondenceStatus, hasAssignee: boolean): TransitionOption[] {
  return CORRESPONDENCE_STATUS_TRANSITIONS[status]
    .filter((to) => !(to === 'ASSIGNED' && !hasAssignee))
    .map((to) => ({
      to,
      label: to === 'FILED' && reasonRequiredFor(status, to) ? 'File without response' : (LABELS[to] ?? to),
      reasonRequired: reasonRequiredFor(status, to),
      asksSentAt: to === 'SENT',
      hint:
        to === 'ARCHIVED'
          ? 'Archived items can no longer be edited or receive attachments.'
          : to === 'FILED' && reasonRequiredFor(status, to)
            ? 'Use this when no response is needed. Say why.'
            : undefined,
    }));
}

/** Sender for incoming, recipient for outgoing; the label used in the inbox column. */
export function counterpartLabel(direction: CorrespondenceDirection): string {
  return direction === 'INCOMING' ? 'From' : 'To';
}

/** Sort weight so overdue and due-soon items surface first in a page. */
export const DEADLINE_WEIGHT: Record<DeadlineKind, number> = { overdue: 0, due_today: 1, due_soon: 2, scheduled: 3, none: 4 };
