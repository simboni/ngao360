import type { SubmissionSummary } from '@ngao360/shared';

/** Where a submission opens for this user: the verification workspace for reviewers, otherwise capture. */
export function submissionHref(s: Pick<SubmissionSummary, 'id' | 'status'>, opts: { canVerify: boolean; canCapture: boolean }): string {
  if (opts.canVerify && (s.status === 'SECOND_REVIEW_PENDING' || !opts.canCapture)) return `/tally/verify/${s.id}`;
  return `/tally/capture/${s.id}`;
}

export function locationLabel(s: Pick<SubmissionSummary, 'pollingStationCode' | 'pollingStationName' | 'tallyCentreName'>): string {
  if (s.pollingStationCode || s.pollingStationName) return [s.pollingStationCode, s.pollingStationName].filter(Boolean).join(' ');
  return s.tallyCentreName ?? '—';
}
