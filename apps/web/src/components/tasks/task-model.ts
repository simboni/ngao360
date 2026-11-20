/**
 * Pure task-board logic (S08, API §24): filters to API queries, the status
 * moves the UI offers, calendar grids and timeline wording. The API is the
 * authority on every transition; these helpers only decide what to show.
 */
import {
  OPEN_TASK_STATUSES,
  TASK_STATUS_TRANSITIONS,
  type TaskDetail,
  type TaskEventType,
  type TaskPriority,
  type TaskQuery,
  type TaskStatus,
  type TaskSummary,
} from '@ngao360/shared';

export type TaskScope = 'all' | 'mine' | 'review' | 'overdue';
export type DueFilter = '' | 'overdue' | 'today' | 'week' | 'month';

export interface TaskFilters {
  scope: TaskScope;
  ownerId: string;
  priority: '' | TaskPriority;
  departmentId: string;
  geographicUnitId: string;
  due: DueFilter;
  q: string;
}

export const EMPTY_TASK_FILTERS: TaskFilters = { scope: 'all', ownerId: '', priority: '', departmentId: '', geographicUnitId: '', due: '', q: '' };

const NAIROBI_OFFSET_MS = 3 * 3_600_000;

/** YYYY-MM-DD of an instant in Africa/Nairobi (UTC+3, no daylight saving). */
export function nairobiDate(iso: string | Date): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight at the start of a Nairobi day, as an ISO instant. */
export function nairobiDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - NAIROBI_OFFSET_MS).toISOString();
}

export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Map the filter bar to a `TaskQuery` (empty values are left out). */
export function filtersToQuery(f: TaskFilters, now: Date = new Date()): Partial<TaskQuery> {
  const q: Partial<TaskQuery> = {};
  q.view = f.due === 'overdue' ? 'overdue' : f.scope;
  if (f.ownerId) q.ownerId = f.ownerId;
  if (f.priority) q.priority = f.priority;
  if (f.departmentId) q.departmentId = f.departmentId;
  if (f.geographicUnitId) q.geographicUnitId = f.geographicUnitId;
  if (f.q.trim()) q.q = f.q.trim();
  const today = nairobiDate(now);
  const until = f.due === 'today' ? 1 : f.due === 'week' ? 7 : f.due === 'month' ? 30 : 0;
  if (until) {
    q.dueFrom = nairobiDayStart(today);
    q.dueTo = nairobiDayStart(addDaysIso(today, until));
  }
  return q;
}

export function activeFilterCount(f: TaskFilters): number {
  return [f.ownerId, f.priority, f.departmentId, f.geographicUnitId, f.due, f.q.trim()].filter(Boolean).length + (f.scope === 'all' ? 0 : 1);
}

/**
 * Status moves offered in the status menu. Review decisions (from
 * SUBMITTED_FOR_REVIEW) use the review action instead; a task with a reviewer
 * cannot be completed directly (it is submitted for review), and one without
 * a reviewer is not submitted for review.
 */
export function taskStatusOptions(t: Pick<TaskDetail, 'status' | 'reviewer' | 'allowedActions'>): TaskStatus[] {
  if (!t.allowedActions.includes('CHANGE_STATUS') && !t.allowedActions.includes('SUBMIT_FOR_REVIEW') && !t.allowedActions.includes('CANCEL')) return [];
  if (t.status === 'SUBMITTED_FOR_REVIEW') return t.allowedActions.includes('CANCEL') ? ['CANCELLED'] : [];
  return TASK_STATUS_TRANSITIONS[t.status].filter((to) => {
    if (to === 'CANCELLED') return t.allowedActions.includes('CANCEL') || t.allowedActions.includes('CHANGE_STATUS');
    if (to === 'SUBMITTED_FOR_REVIEW') return !!t.reviewer && (t.allowedActions.includes('SUBMIT_FOR_REVIEW') || t.allowedActions.includes('CHANGE_STATUS'));
    if (to === 'COMPLETED') return !t.reviewer && t.allowedActions.includes('CHANGE_STATUS');
    return t.allowedActions.includes('CHANGE_STATUS');
  });
}

/** Wording for the button that performs a move. */
export const TASK_MOVE_LABELS: Record<TaskStatus, string> = {
  DRAFT: 'Back to draft',
  READY: 'Mark ready',
  IN_PROGRESS: 'Start work',
  BLOCKED: 'Mark blocked',
  SUBMITTED_FOR_REVIEW: 'Submit for review',
  COMPLETED: 'Mark completed',
  CANCELLED: 'Cancel task',
};

export function moveNeedsReason(to: TaskStatus): boolean {
  return to === 'BLOCKED' || to === 'CANCELLED';
}

/** Moves blocked by open dependencies (API answers 409 CONFLICT `openDependencies`). */
export function moveBlockedByDependencies(to: TaskStatus, openDependencyCount: number): boolean {
  return openDependencyCount > 0 && (to === 'IN_PROGRESS' || to === 'COMPLETED' || to === 'SUBMITTED_FOR_REVIEW');
}

export function isOpenTask(status: TaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}

export interface DueInfo {
  text: string;
  tone: 'danger' | 'pending' | 'muted' | 'neutral';
}

/** Due-date wording in words (never colour alone). */
export function dueInfo(t: Pick<TaskSummary, 'dueAt' | 'status' | 'isOverdue'>, now: Date = new Date()): DueInfo | null {
  if (!t.dueAt) return null;
  const today = nairobiDate(now);
  const due = nairobiDate(t.dueAt);
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!isOpenTask(t.status)) return { text: `Due ${formatDay(due)}`, tone: 'muted' };
  if (t.isOverdue || days < 0) return { text: days < 0 ? `Overdue by ${-days} ${-days === 1 ? 'day' : 'days'}` : 'Overdue', tone: 'danger' };
  if (days === 0) return { text: 'Due today', tone: 'pending' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'pending' };
  if (days <= 7) return { text: `Due in ${days} days`, tone: 'neutral' };
  return { text: `Due ${formatDay(due)}`, tone: 'neutral' };
}

export function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/* -------------------------------- Calendar -------------------------------- */

export interface CalendarGrid {
  month: string;
  /** 42 days (6 weeks, Monday first). */
  days: string[];
  from: string;
  to: string;
}

/** Month grid for `YYYY-MM`, Monday first; from/to are Nairobi-day bounds (≤ 92 days). */
export function calendarGrid(month: string): CalendarGrid {
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDaysIso(first, -weekday);
  const days = Array.from({ length: 42 }, (_, i) => addDaysIso(start, i));
  return { month, days, from: nairobiDayStart(days[0]!), to: nairobiDayStart(addDaysIso(days[41]!, 1)) };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Tasks per Nairobi day, placed on the due date (or the start date when there is none). */
export function tasksByDay(tasks: readonly TaskSummary[]): Map<string, TaskSummary[]> {
  const out = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    const at = t.dueAt ?? t.startAt;
    if (!at) continue;
    const day = nairobiDate(at);
    out.set(day, [...(out.get(day) ?? []), t]);
  }
  return out;
}

/* -------------------------------- Timeline -------------------------------- */

export const TASK_EVENT_LABELS: Record<TaskEventType, string> = {
  CREATED: 'Task created',
  UPDATED: 'Details updated',
  ASSIGNED: 'Owner assigned',
  COLLABORATORS_CHANGED: 'Collaborators changed',
  REVIEWER_CHANGED: 'Reviewer changed',
  STATUS_CHANGED: 'Status changed',
  DEPENDENCY_ADDED: 'Dependency added',
  DEPENDENCY_REMOVED: 'Dependency removed',
  CHECKLIST_UPDATED: 'Checklist updated',
  COMMENTED: 'Comment added',
  ATTACHMENT_ADDED: 'Attachment added',
  EVIDENCE_ADDED: 'Completion evidence added',
  REVIEW_APPROVED: 'Review approved',
  REVIEW_RETURNED: 'Returned by reviewer',
};

/** Checklist editing state → `SaveTaskChecklist.items` (blank labels dropped). */
export function checklistPayload(items: ReadonlyArray<{ id?: string; label: string; isDone: boolean }>) {
  return items.filter((i) => i.label.trim()).map((i) => ({ ...(i.id ? { id: i.id } : {}), label: i.label.trim(), isDone: i.isDone }));
}
