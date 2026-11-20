import type { SubmissionStatus, SubmissionSummary } from '@ngao360/shared';

/** Statuses on which a tally supervisor may act on the latest verification outcome. */
const SUPERVISOR_STATUSES: ReadonlySet<SubmissionStatus> = new Set(['SECOND_REVIEW_PENDING', 'VERIFIED', 'RETURNED', 'DISPUTED']);

/**
 * Where a submission opens for this user: the verification workspace for
 * reviewers and tally supervisors (who take supervisor actions there),
 * otherwise capture.
 */
export function submissionHref(
  s: Pick<SubmissionSummary, 'id' | 'status'>,
  opts: { canVerify: boolean; canCapture: boolean; canApprove?: boolean },
): string {
  if (opts.canVerify && (s.status === 'SECOND_REVIEW_PENDING' || !opts.canCapture)) return `/tally/verify/${s.id}`;
  if (opts.canApprove && (!opts.canCapture || SUPERVISOR_STATUSES.has(s.status))) return `/tally/verify/${s.id}`;
  return `/tally/capture/${s.id}`;
}

export function locationLabel(s: Pick<SubmissionSummary, 'pollingStationCode' | 'pollingStationName' | 'tallyCentreName'>): string {
  if (s.pollingStationCode || s.pollingStationName) return [s.pollingStationCode, s.pollingStationName].filter(Boolean).join(' ');
  return s.tallyCentreName ?? '—';
}
