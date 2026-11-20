import { canTransitionSubmission, type PermissionKey, type SubmissionDetail, type SubmissionStatus } from '@ngao360/shared';
import { CAPTURE_STATUSES } from './status-path';
import { type SubmissionParticipants, supervisorViolation, verificationViolation } from './separation-of-duties';

export type AllowedAction = SubmissionDetail['allowedActions'][number];

export interface AllowedActionsInput {
  userId: string;
  permissions: ReadonlySet<PermissionKey>;
  status: SubmissionStatus;
  isCanonical: boolean;
  participants: SubmissionParticipants;
  /** True when some verification has no supervisor action yet. */
  hasPendingSupervisorReview: boolean;
  /** True when the latest verification asked for a third check. */
  thirdCheckRequested: boolean;
}

/**
 * Actions the user may take on a submission, computed server-side from
 * permissions, separation of duties and status. The UI uses it to show
 * buttons; every endpoint re-checks independently.
 */
export function allowedActions(i: AllowedActionsInput): AllowedAction[] {
  const has = (p: PermissionKey) => i.permissions.has(p);
  const out: AllowedAction[] = [];
  const supervisorOk = supervisorViolation(i.userId, i.participants) === null;

  if (has('tally.capture') && CAPTURE_STATUSES.has(i.status)) out.push('CAPTURE');
  if (has('tally.capture') && i.status === 'DATA_ENTRY_REVIEWED') out.push('SUBMIT_FOR_REVIEW');
  if ((has('tally.capture') || has('tally.verify')) && canTransitionSubmission(i.status, 'RETURNED')) out.push('RETURN');
  if (
    has('tally.verify') &&
    i.status === 'SECOND_REVIEW_PENDING' &&
    verificationViolation(i.userId, i.participants, { thirdCheck: i.thirdCheckRequested }) === null
  ) {
    out.push('VERIFY');
  }
  if (has('tally.approve') && i.hasPendingSupervisorReview && supervisorOk) out.push('SUPERVISOR_ACTION');
  if (has('tally.discrepancy.manage')) out.push('FLAG_DISCREPANCY');
  if (has('tally.exclude') && canTransitionSubmission(i.status, 'EXCLUDED_FROM_AGGREGATE') && supervisorOk) {
    out.push('EXCLUDE');
  }
  if (
    has('tally.approve') &&
    !i.isCanonical &&
    i.status !== 'ARCHIVED' &&
    i.status !== 'EXCLUDED_FROM_AGGREGATE' &&
    supervisorOk
  ) {
    out.push('DESIGNATE_CANONICAL');
  }
  if (has('tally.source.download')) out.push('DOWNLOAD_SOURCE');
  return out;
}
