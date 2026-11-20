/**
 * Pure presentation helpers for the S21 parallel tally. They only reshape the
 * API aggregate; they never add, remove or reweight votes.
 *
 * Rules (blueprint 8.6 / 8.7 / 17.2):
 * - Totals and shares use verified submissions only.
 * - Missing stations are a coverage category, never zero votes.
 * - Every total is shown with included stations and the registry denominator.
 */
import type { CandidateTotal, Coverage } from '@ngao360/shared';

export interface CoverageSegment {
  key: 'verified' | 'awaitingReview' | 'receivedOther' | 'flagged' | 'excluded' | 'missing';
  label: string;
  count: number;
  /** Percent of the expected-station denominator (0 when there is no denominator). */
  percent: number;
}

export const SEGMENT_LABELS: Record<CoverageSegment['key'], string> = {
  verified: 'Verified (included)',
  awaitingReview: 'Awaiting second review',
  receivedOther: 'Received, in capture',
  flagged: 'Flagged',
  excluded: 'Excluded',
  missing: 'Missing (no form yet)',
};

/**
 * Split the expected stations into mutually exclusive coverage segments that
 * add up to the denominator. "Received, in capture" is whatever is received
 * but not verified, awaiting review, flagged or excluded.
 */
export function coverageSegments(c: Coverage): CoverageSegment[] {
  const receivedOther = Math.max(0, c.received - c.verified - c.awaitingReview - c.flagged - c.excluded);
  const counts: Array<[CoverageSegment['key'], number]> = [
    ['verified', c.verified],
    ['awaitingReview', c.awaitingReview],
    ['receivedOther', receivedOther],
    ['flagged', c.flagged],
    ['excluded', c.excluded],
    ['missing', c.missing],
  ];
  return counts.map(([key, count]) => ({
    key,
    label: SEGMENT_LABELS[key],
    count,
    percent: c.expectedStations > 0 ? (count / c.expectedStations) * 100 : 0,
  }));
}

/** "12 of 153 stations (7.8%)" — the denominator is always shown. */
export function denominatorLabel(included: number, expected: number): string {
  const pct = expected > 0 ? ` (${((included / expected) * 100).toFixed(1)}%)` : '';
  return `${included.toLocaleString('en-KE')} of ${expected.toLocaleString('en-KE')} expected stations${pct}`;
}

/** Candidates in ballot order (never re-ranked by votes, to avoid implying an outcome). */
export function ballotOrder(candidates: readonly CandidateTotal[]): CandidateTotal[] {
  return [...candidates].sort((a, b) => a.ballotOrder - b.ballotOrder);
}

/**
 * Share of verified valid votes as a percentage (0–100), computed from the
 * verified figures themselves so it always matches the totals shown. Null when
 * nothing is verified, so the UI shows "—" rather than 0%.
 */
export function shareOfVerified(c: Pick<CandidateTotal, 'verifiedVotes'>, totalVerifiedValid: number): number | null {
  if (totalVerifiedValid <= 0) return null;
  return (c.verifiedVotes / totalVerifiedValid) * 100;
}

/** "Nice" upper bound for a bar axis. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}
