import type { SubmissionStatus } from '@ngao360/shared';
import {
  type AggCandidate,
  type AggStation,
  type AggSubmission,
  CALCULATION_VERSION,
  classifyStation,
  computeAggregate,
} from './aggregation';
import { compareStages } from './stage-comparison';
import { compareIndependentValues, requiredReentryCells } from './verification-compare';
import { FIELD_SCHEMA_37A } from './__fixtures__/governor-37a';

const A = 'cand-a';
const B = 'cand-b';
const candidates: AggCandidate[] = [
  { id: B, candidateNameAsPublished: 'Synthetic Candidate B', partyLabel: 'Party Two', ballotOrder: 2 },
  { id: A, candidateNameAsPublished: 'Synthetic Candidate A', partyLabel: 'Party One', ballotOrder: 1 },
];

const station = (n: number): AggStation => ({
  id: `st-${n}`,
  code: `S${String(n).padStart(3, '0')}`,
  name: `Synthetic Station ${n}`,
  countyId: 'county',
  constituencyId: n <= 3 ? 'const-1' : 'const-2',
  wardId: `ward-${n}`,
  pollingCentreId: null,
  geographicUnitId: `ward-${n}`,
});

let seq = 0;
const sub = (
  stationN: number,
  status: SubmissionStatus,
  votes: { a: number; b: number; rejected?: number } | null = null,
  extra: Partial<AggSubmission> = {},
): AggSubmission => ({
  id: `sub-${++seq}`,
  pollingStationId: `st-${stationN}`,
  status,
  isCanonical: true,
  hasOpenDiscrepancy: false,
  values: votes
    ? [
        { fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: votes.a },
        { fieldKey: 'candidate_votes', candidateReferenceId: B, numericValue: votes.b },
        { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: votes.a + votes.b },
        { fieldKey: 'rejected_ballots', candidateReferenceId: null, numericValue: votes.rejected ?? null },
      ]
    : [],
  ...extra,
});

describe('aggregation (blueprint 8.6)', () => {
  const stations = [1, 2, 3, 4, 5, 6, 7, 8].map(station);

  it('includes only canonical VERIFIED submissions and keeps every other status visible', () => {
    const subs = [
      sub(1, 'VERIFIED', { a: 100, b: 50, rejected: 3 }),
      sub(2, 'VERIFIED', { a: 10, b: 90 }),
      sub(3, 'SECOND_REVIEW_PENDING', { a: 999, b: 999 }), // unverified: not counted
      sub(4, 'DATA_ENTRY_REVIEWED', { a: 999, b: 999 }),
      sub(5, 'DISPUTED', { a: 999, b: 999 }),
      sub(6, 'EXCLUDED_FROM_AGGREGATE', { a: 999, b: 999 }),
      sub(7, 'VERIFIED', { a: 999, b: 999 }, { isCanonical: false }), // non-canonical duplicate
      // station 8: missing
    ];
    const r = computeAggregate(stations, subs, candidates);
    expect(r.calculationVersion).toBe(CALCULATION_VERSION);
    expect(r.includedSubmissionIds).toEqual([subs[0]!.id, subs[1]!.id]);
    expect(r.includedStationCount).toBe(2);
    expect(r.totalVerifiedValidVotes).toBe(250);
    expect(r.rejectedBallots).toBe(3);
    expect(r.candidates.map((c) => [c.candidateReferenceId, c.verifiedVotes, c.shareOfVerifiedValidVotes])).toEqual([
      [A, 110, 44],
      [B, 140, 56],
    ]);
    expect(r.coverage).toEqual({
      expectedStations: 8,
      received: 7,
      transcribed: 5, // stations 1, 2, 3, 4 and 7 (values captured); excluded and disputed are not counted
      awaitingReview: 1,
      verified: 2,
      flagged: 1,
      excluded: 1,
      missing: 1,
      verifiedPercent: 25,
    });
  });

  it('never counts missing stations as zero votes', () => {
    const r = computeAggregate(stations, [sub(1, 'VERIFIED', { a: 5, b: 5 })], candidates);
    const missing = r.stations.filter((s) => s.coverageStatus === 'MISSING');
    expect(missing).toHaveLength(7);
    for (const m of missing) {
      expect(m.candidateVotes).toBeNull();
      expect(m.totalValidVotes).toBeNull();
      expect(m.submissionId).toBeNull();
    }
    expect(r.coverage.missing).toBe(7);
    expect(r.coverage.expectedStations).toBe(8);
  });

  it('returns zero totals and 0% (not NaN) when nothing is verified or nothing is expected', () => {
    const none = computeAggregate(stations, [], candidates);
    expect(none.totalVerifiedValidVotes).toBe(0);
    expect(none.candidates.every((c) => c.shareOfVerifiedValidVotes === 0)).toBe(true);
    const empty = computeAggregate([], [], candidates);
    expect(empty.coverage.verifiedPercent).toBe(0);
  });

  it('ignores submissions for stations outside the expected registry list', () => {
    const r = computeAggregate([station(1)], [sub(1, 'VERIFIED', { a: 1, b: 1 }), sub(99, 'VERIFIED', { a: 1000, b: 1000 })], candidates);
    expect(r.totalVerifiedValidVotes).toBe(2);
  });

  it('lists candidates in ballot order, never ranked by votes', () => {
    const r = computeAggregate([station(1)], [sub(1, 'VERIFIED', { a: 1, b: 1000 })], candidates);
    expect(r.candidates.map((c) => c.ballotOrder)).toEqual([1, 2]);
  });

  it('classifies stations: verified beats flags; all-excluded is excluded; archived is ignored', () => {
    expect(classifyStation([]).status).toBe('MISSING');
    expect(classifyStation([sub(1, 'ARCHIVED')]).status).toBe('MISSING');
    expect(classifyStation([sub(1, 'VERIFIED'), sub(1, 'DISPUTED', null, { isCanonical: false })]).status).toBe('VERIFIED');
    expect(classifyStation([sub(1, 'EXCLUDED_FROM_AGGREGATE'), sub(1, 'EXCLUDED_FROM_AGGREGATE')]).status).toBe('EXCLUDED');
    expect(classifyStation([sub(1, 'SUBMITTED', null, { hasOpenDiscrepancy: true })]).status).toBe('FLAGGED');
    expect(classifyStation([sub(1, 'QUARANTINED')]).status).toBe('FLAGGED');
    expect(classifyStation([sub(1, 'OCR_COMPLETE')]).status).toBe('RECEIVED');
  });
});

describe('cross-stage comparison', () => {
  it('reports each differing figure with both sources and never modifies either', () => {
    const agg = new Map([
      [A, 110],
      [B, 140],
    ]);
    const collation = Object.freeze([
      Object.freeze({ fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: 110 }),
      Object.freeze({ fieldKey: 'candidate_votes', candidateReferenceId: B, numericValue: 150 }),
      Object.freeze({ fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 260 }),
    ]);
    const r = compareStages({
      aggregateByCandidate: agg,
      aggregateTotalValid: 250,
      collationValues: collation,
      includedStations: 2,
      expectedStations: 2,
    });
    expect(r.completeCoverage).toBe(true);
    expect(r.compared).toBe(3);
    expect(r.differences).toEqual([
      { cell: `candidate_votes:${B}`, fieldKey: 'candidate_votes', candidateReferenceId: B, sourceA: 140, sourceB: 150, difference: 10 },
      { cell: 'total_valid_votes', fieldKey: 'total_valid_votes', candidateReferenceId: null, sourceA: 250, sourceB: 260, difference: 10 },
    ]);
  });

  it('marks partial coverage so differences are not over-interpreted', () => {
    const r = compareStages({
      aggregateByCandidate: new Map([[A, 1]]),
      aggregateTotalValid: 1,
      collationValues: [],
      includedStations: 1,
      expectedStations: 5,
    });
    expect(r.completeCoverage).toBe(false);
    expect(r.differences.every((d) => d.sourceB === null && d.difference === null)).toBe(true);
  });
});

describe('independent re-entry comparison', () => {
  it('lists mismatched cells without changing captured values', () => {
    const captured = [
      { fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: 100 },
      { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 150 },
    ];
    const snapshot = JSON.stringify(captured);
    const m = compareIndependentValues(captured, [
      { fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: 101 },
      { fieldKey: 'total_valid_votes', candidateReferenceId: null, numericValue: 150 },
    ]);
    expect(m).toEqual([
      { cell: `candidate_votes:${A}`, fieldKey: 'candidate_votes', candidateReferenceId: A, captured: 100, independent: 101, difference: 1 },
    ]);
    expect(JSON.stringify(captured)).toBe(snapshot);
  });

  it('requires every candidate cell and required count in re-entry mode', () => {
    expect(requiredReentryCells(FIELD_SCHEMA_37A, [A, B])).toEqual([`candidate_votes:${A}`, `candidate_votes:${B}`, 'total_valid_votes']);
  });
});
