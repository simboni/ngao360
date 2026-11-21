import type { SubmissionDetail } from '@ngao360/shared';

/** Who may re-run, and why not: the same conditions the API checks (`tally.discrepancy.manage`, verified later-stage form). */
export function stageComparisonBlock(detail: Pick<SubmissionDetail, 'status' | 'formLevel' | 'allowedActions'>): string | null {
  if (detail.formLevel === 'POLLING_STATION') return 'Polling-station forms are the aggregate itself; only collation and declaration forms are compared.';
  if (detail.status !== 'VERIFIED') return 'Only a verified form is compared with the verified station aggregate.';
  if (!detail.allowedActions.includes('FLAG_DISCREPANCY')) return 'Re-running needs permission to manage discrepancy cases for this area (tally supervisor).';
  return null;
}
