/**
 * Parallel-tally aggregation (blueprint 8.6, 8.7; API contract §5.6). Pure.
 *
 * - Only canonical submissions with status VERIFIED ("Verified for parallel
 *   tally") contribute votes.
 * - The denominator is the expected station list from the approved registry.
 * - Missing stations are reported as missing and never contribute zero votes:
 *   their rows carry `candidateVotes: null`, not zeros.
 * - Received, transcribed, awaiting review, flagged and excluded records stay
 *   visible in the coverage counts.
 */
import { AGGREGATE_ELIGIBLE_STATUS, type SubmissionStatus } from '@ngao360/shared';

export const CALCULATION_VERSION = 'tally-agg-v1';

export type CoverageStatus = 'MISSING' | 'RECEIVED' | 'VERIFIED' | 'FLAGGED' | 'EXCLUDED';

export interface AggStation {
  id: string;
  code: string;
  name: string;
  countyId: string;
  constituencyId: string;
  wardId: string;
  pollingCentreId: string | null;
  geographicUnitId: string;
}

export interface AggValue {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
}

export interface AggSubmission {
  id: string;
  pollingStationId: string | null;
  status: SubmissionStatus;
  isCanonical: boolean;
  hasOpenDiscrepancy: boolean;
  values: readonly AggValue[];
}

export interface AggCandidate {
  id: string;
  candidateNameAsPublished: string;
  partyLabel: string | null;
  ballotOrder: number;
}

export interface AggFieldKeys {
  candidateVotes: string;
  totalValidVotes: string;
  rejectedBallots: string;
}

export const DEFAULT_FIELD_KEYS: AggFieldKeys = {
  candidateVotes: 'candidate_votes',
  totalValidVotes: 'total_valid_votes',
  rejectedBallots: 'rejected_ballots',
};

export interface CoverageCounts {
  expectedStations: number;
  received: number;
  transcribed: number;
  awaitingReview: number;
  verified: number;
  flagged: number;
  excluded: number;
  missing: number;
  verifiedPercent: number;
}

export interface CandidateTotalRow {
  candidateReferenceId: string;
  candidateNameAsPublished: string;
  partyLabel: string | null;
  ballotOrder: number;
  verifiedVotes: number;
  shareOfVerifiedValidVotes: number;
}

export interface StationRow {
  pollingStationId: string;
  code: string;
  name: string;
  coverageStatus: CoverageStatus;
  /** The included submission (VERIFIED) or the most relevant other submission. */
  submissionId: string | null;
  transcribed: boolean;
  awaitingReview: boolean;
  /** Votes by candidate for included stations only; null when not included (never zero-filled). */
  candidateVotes: Record<string, number> | null;
  totalValidVotes: number | null;
  rejectedBallots: number | null;
}

export interface AggregateResult {
  calculationVersion: string;
  coverage: CoverageCounts;
  candidates: CandidateTotalRow[];
  totalVerifiedValidVotes: number;
  rejectedBallots: number;
  includedStationCount: number;
  includedSubmissionIds: string[];
  stations: StationRow[];
}

const TRANSCRIBED: ReadonlySet<SubmissionStatus> = new Set(['DATA_ENTRY_REVIEWED', 'SECOND_REVIEW_PENDING', 'VERIFIED']);
const FLAGGED: ReadonlySet<SubmissionStatus> = new Set(['DISPUTED', 'QUARANTINED']);

/** Coverage classification of one expected station from its submissions. */
export function classifyStation(subs: readonly AggSubmission[]): {
  status: CoverageStatus;
  included: AggSubmission | null;
  representative: AggSubmission | null;
  transcribed: boolean;
  awaitingReview: boolean;
} {
  const active = subs.filter((s) => s.status !== 'ARCHIVED');
  if (active.length === 0) {
    return { status: 'MISSING', included: null, representative: null, transcribed: false, awaitingReview: false };
  }
  const included = active.find((s) => s.isCanonical && s.status === AGGREGATE_ELIGIBLE_STATUS) ?? null;
  const transcribed = active.some((s) => TRANSCRIBED.has(s.status));
  const awaitingReview = !included && active.some((s) => s.status === 'SECOND_REVIEW_PENDING');
  const representative = included ?? active.find((s) => s.isCanonical) ?? active[0] ?? null;
  if (included) return { status: 'VERIFIED', included, representative, transcribed: true, awaitingReview: false };
  if (active.every((s) => s.status === 'EXCLUDED_FROM_AGGREGATE')) {
    return { status: 'EXCLUDED', included: null, representative, transcribed, awaitingReview };
  }
  if (active.some((s) => FLAGGED.has(s.status) || s.hasOpenDiscrepancy)) {
    return { status: 'FLAGGED', included: null, representative, transcribed, awaitingReview };
  }
  return { status: 'RECEIVED', included: null, representative, transcribed, awaitingReview };
}

function num(values: readonly AggValue[], key: string): number | null {
  const v = values.find((x) => x.fieldKey === key && x.candidateReferenceId === null);
  return v?.numericValue ?? null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute coverage and verified totals for a set of expected stations.
 * Submissions for stations not in `stations` are ignored (they are outside the
 * approved registry or the requested geography).
 */
export function computeAggregate(
  stations: readonly AggStation[],
  submissions: readonly AggSubmission[],
  candidates: readonly AggCandidate[],
  keys: AggFieldKeys = DEFAULT_FIELD_KEYS,
): AggregateResult {
  const byStation = new Map<string, AggSubmission[]>();
  for (const s of submissions) {
    if (!s.pollingStationId) continue;
    const list = byStation.get(s.pollingStationId) ?? [];
    list.push(s);
    byStation.set(s.pollingStationId, list);
  }
  const candidateIds = new Set(candidates.map((c) => c.id));
  const votes = new Map<string, number>(candidates.map((c) => [c.id, 0]));
  let totalValid = 0;
  let rejected = 0;
  const included: string[] = [];
  const coverage: CoverageCounts = {
    expectedStations: stations.length,
    received: 0,
    transcribed: 0,
    awaitingReview: 0,
    verified: 0,
    flagged: 0,
    excluded: 0,
    missing: 0,
    verifiedPercent: 0,
  };
  const rows: StationRow[] = [];

  for (const st of stations) {
    const c = classifyStation(byStation.get(st.id) ?? []);
    if (c.status !== 'MISSING') coverage.received += 1;
    if (c.transcribed) coverage.transcribed += 1;
    if (c.awaitingReview) coverage.awaitingReview += 1;
    if (c.status === 'VERIFIED') coverage.verified += 1;
    if (c.status === 'FLAGGED') coverage.flagged += 1;
    if (c.status === 'EXCLUDED') coverage.excluded += 1;
    if (c.status === 'MISSING') coverage.missing += 1;

    let candidateVotes: Record<string, number> | null = null;
    let stationValid: number | null = null;
    let stationRejected: number | null = null;
    if (c.included) {
      included.push(c.included.id);
      candidateVotes = {};
      let candSum = 0;
      for (const v of c.included.values) {
        if (v.fieldKey !== keys.candidateVotes || !v.candidateReferenceId) continue;
        if (!candidateIds.has(v.candidateReferenceId) || v.numericValue === null) continue;
        candidateVotes[v.candidateReferenceId] = v.numericValue;
        votes.set(v.candidateReferenceId, (votes.get(v.candidateReferenceId) ?? 0) + v.numericValue);
        candSum += v.numericValue;
      }
      stationValid = num(c.included.values, keys.totalValidVotes) ?? candSum;
      stationRejected = num(c.included.values, keys.rejectedBallots);
      totalValid += stationValid;
      rejected += stationRejected ?? 0;
    }
    rows.push({
      pollingStationId: st.id,
      code: st.code,
      name: st.name,
      coverageStatus: c.status,
      submissionId: c.representative?.id ?? null,
      transcribed: c.transcribed,
      awaitingReview: c.awaitingReview,
      candidateVotes,
      totalValidVotes: stationValid,
      rejectedBallots: stationRejected,
    });
  }

  coverage.verifiedPercent = stations.length === 0 ? 0 : round2((coverage.verified / stations.length) * 100);
  const candidateRows = [...candidates]
    .sort((a, b) => a.ballotOrder - b.ballotOrder)
    .map((c) => {
      const v = votes.get(c.id) ?? 0;
      return {
        candidateReferenceId: c.id,
        candidateNameAsPublished: c.candidateNameAsPublished,
        partyLabel: c.partyLabel,
        ballotOrder: c.ballotOrder,
        verifiedVotes: v,
        shareOfVerifiedValidVotes: totalValid === 0 ? 0 : round2((v / totalValid) * 100),
      };
    });

  return {
    calculationVersion: CALCULATION_VERSION,
    coverage,
    candidates: candidateRows,
    totalVerifiedValidVotes: totalValid,
    rejectedBallots: rejected,
    includedStationCount: included.length,
    includedSubmissionIds: included,
    stations: rows,
  };
}

/** Group stations by a key (e.g. constituency id) for geography drill-down. */
export function groupStations<K>(stations: readonly AggStation[], key: (s: AggStation) => K | null): Map<K, AggStation[]> {
  const out = new Map<K, AggStation[]>();
  for (const s of stations) {
    const k = key(s);
    if (k === null) continue;
    const list = out.get(k) ?? [];
    list.push(s);
    out.set(k, list);
  }
  return out;
}
