/**
 * Pure breach-register logic (blueprint 15.4; API §30): labels, the
 * detect → contain → preserve → assess → notify → remediate → close steps,
 * which timeline entries are possible from the current status, and why
 * closing is blocked (lessons missing, reporter cannot close). No legal
 * notification deadline is built in; the screen shows elapsed time only.
 */
import {
  BREACH_DATA_CATEGORIES,
  BREACH_EVENT_TYPES,
  BREACH_STATUSES,
  type BreachDetail,
  type BreachEventType,
  type BreachSeverity,
  type BreachStatus,
  breachStatusFor,
  canTransitionBreach,
} from '@ngao360/shared';

export const BREACH_SEVERITY_LABELS: Record<BreachSeverity, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

export const BREACH_EVENT_TYPE_LABELS: Record<BreachEventType, string> = {
  DETECTED: 'Detected',
  CONTAINED: 'Contained',
  EVIDENCE_PRESERVED: 'Evidence preserved',
  ASSESSED: 'Scope and risk assessed',
  CONTROLLER_NOTIFIED: 'Data controller notified',
  REGULATOR_NOTIFIED: 'Regulator notified',
  SUBJECTS_NOTIFIED: 'Affected people notified',
  NOTIFICATION_NOT_REQUIRED: 'Decision: notification not required',
  REMEDIATED: 'Remediated',
  LESSONS_RECORDED: 'Lessons recorded',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  NOTE: 'Note',
};

export const BREACH_DATA_CATEGORY_LABELS: Record<(typeof BREACH_DATA_CATEGORIES)[number], string> = {
  STAFF_CONTACT: 'Staff contact details',
  AGENT_PERSONAL_DATA: 'Agent personal data',
  CITIZEN_CASE_DATA: 'Citizen case data',
  FINANCE_RECORDS: 'Finance records',
  CONTRIBUTOR_DATA: 'Contributor data',
  RESULT_FORM_EVIDENCE: 'Result form evidence',
  CREDENTIALS: 'Credentials',
  OTHER: 'Other',
};

/** Steps shown in the stepper (blueprint 15.4 order). */
export const BREACH_STEPS: readonly BreachStatus[] = BREACH_STATUSES;

export function breachStepIndex(status: BreachStatus): number {
  return BREACH_STEPS.indexOf(status);
}

/** Types an AddBreachEvent may carry (DETECTED is written on creation only). */
export const ADDABLE_EVENT_TYPES = BREACH_EVENT_TYPES.filter((t) => t !== 'DETECTED') as Exclude<BreachEventType, 'DETECTED'>[];

const NOTIFY_TYPES: readonly BreachEventType[] = ['CONTROLLER_NOTIFIED', 'REGULATOR_NOTIFIED', 'SUBJECTS_NOTIFIED'];

/**
 * Timeline entries possible from `status`: notes and lessons any time a record
 * is open; status moves per BREACH_STATUS_TRANSITIONS; several notifications
 * can be recorded while ASSESSED or NOTIFIED; "not required" only while
 * ASSESSED; a closed record only takes a note or a reopening.
 */
export function eventTypesFor(status: BreachStatus): Exclude<BreachEventType, 'DETECTED'>[] {
  if (status === 'CLOSED') return ['NOTE', 'REOPENED'];
  return ADDABLE_EVENT_TYPES.filter((t) => {
    if (t === 'NOTE' || t === 'LESSONS_RECORDED') return true;
    if (t === 'REOPENED') return false;
    if (t === 'NOTIFICATION_NOT_REQUIRED') return status === 'ASSESSED';
    if (NOTIFY_TYPES.includes(t)) return status === 'ASSESSED' || status === 'NOTIFIED';
    const target = breachStatusFor(t);
    return target !== null && canTransitionBreach(status, target);
  });
}

/** Reasons the record cannot be closed by this user (empty = can close, if REMEDIATED). */
export function closeBlockers(b: Pick<BreachDetail, 'status' | 'lessonsLearned' | 'reportedBy'>, userId: string | undefined): string[] {
  const out: string[] = [];
  if (b.status !== 'REMEDIATED') out.push('Only a remediated record can be closed.');
  if (!b.lessonsLearned?.trim()) out.push('Document the lessons learned first (edit the record).');
  if (userId && b.reportedBy.id === userId) out.push('Separation of duties: you reported this breach, so someone else must close it.');
  return out;
}

/** Time since detection in words ("3 h 20 min", "2 days 4 h"). Elapsed time only; no deadline is assumed. */
export function elapsedSince(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/**
 * Entries this caller may add: holders of security.breach.record alone add
 * notes only; status moves need ADVANCE (security.breach.manage); reopening
 * needs REOPEN. Closing stays listed for managers so the blockers can be shown.
 */
export function eventTypesForCaller(status: BreachStatus, allowedActions: readonly BreachDetail['allowedActions'][number][]): Exclude<BreachEventType, 'DETECTED'>[] {
  const manage = allowedActions.includes('ADVANCE') || allowedActions.includes('CLOSE') || allowedActions.includes('REOPEN');
  return eventTypesFor(status).filter((t) => {
    if (t === 'NOTE') return allowedActions.includes('ADD_EVENT');
    if (t === 'REOPENED') return allowedActions.includes('REOPEN');
    return manage;
  });
}
