/**
 * UI-local types for tally screens.
 *
 * `StationCoverageRow` mirrors the shape the tally API returns from
 * GET /tally/results/stations (docs/CHANGE_REQUESTS.md, tally item 3). Once the
 * shared schema `StationCoverageRowSchema` lands in @ngao360/shared, replace
 * this definition with a re-export.
 */
import type { SubmissionSummary } from '@ngao360/shared';

export type StationCoverageStatus = 'MISSING' | 'RECEIVED' | 'VERIFIED' | 'FLAGGED' | 'EXCLUDED';

type SubmissionSpecific =
  | 'id'
  | 'reference'
  | 'formNumber'
  | 'formLevel'
  | 'formTemplateVersion'
  | 'status'
  | 'sourceType'
  | 'isCanonical'
  | 'duplicateFlag'
  | 'submitter'
  | 'submittedAt'
  | 'createdAt'
  | 'updatedAt';

export type StationCoverageRow = Omit<SubmissionSummary, SubmissionSpecific | 'pollingStationId'> & {
  [K in SubmissionSpecific]: SubmissionSummary[K] | null;
} & {
  pollingStationId: string;
  coverageStatus: StationCoverageStatus;
  /** Votes by candidate id for verified (included) stations only; null otherwise, never zero-filled. */
  candidateVotes: Record<string, number> | null;
};
