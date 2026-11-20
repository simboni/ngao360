/**
 * Cross-stage comparison (blueprint 8.2 step 9, 8.5 "Cross-stage mismatch",
 * 8.6): compare the verified station-level (A-form) aggregate for an area with
 * a later collation/declaration form (B or C) for the same area. Pure: it only
 * reports differences; no value on either side is ever overwritten.
 */
import { cellKey } from './validation-engine';

export interface StageCell {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
}

export interface StageDifference {
  cell: string;
  fieldKey: string;
  candidateReferenceId: string | null;
  /** Sum of verified station-level forms (source A). */
  sourceA: number;
  /** Value printed on the collation form (source B). */
  sourceB: number | null;
  difference: number | null;
}

export interface StageComparison {
  differences: StageDifference[];
  compared: number;
  /** Station-level coverage behind sourceA. */
  includedStations: number;
  expectedStations: number;
  /** True when every expected station is included, so differences are not explained by missing forms. */
  completeCoverage: boolean;
}

export function compareStages(input: {
  aggregateByCandidate: ReadonlyMap<string, number>;
  aggregateTotalValid: number;
  collationValues: readonly StageCell[];
  includedStations: number;
  expectedStations: number;
  keys?: { candidateVotes: string; totalValidVotes: string };
}): StageComparison {
  const keys = input.keys ?? { candidateVotes: 'candidate_votes', totalValidVotes: 'total_valid_votes' };
  const differences: StageDifference[] = [];
  let compared = 0;
  const lookup = new Map(input.collationValues.map((v) => [cellKey(v.fieldKey, v.candidateReferenceId), v] as const));

  const check = (fieldKey: string, candidateId: string | null, sourceA: number) => {
    compared += 1;
    const b = lookup.get(cellKey(fieldKey, candidateId))?.numericValue ?? null;
    if (b !== sourceA) {
      differences.push({
        cell: cellKey(fieldKey, candidateId),
        fieldKey,
        candidateReferenceId: candidateId,
        sourceA,
        sourceB: b,
        difference: b === null ? null : b - sourceA,
      });
    }
  };
  for (const [candidateId, votes] of input.aggregateByCandidate) check(keys.candidateVotes, candidateId, votes);
  check(keys.totalValidVotes, null, input.aggregateTotalValid);

  return {
    differences,
    compared,
    includedStations: input.includedStations,
    expectedStations: input.expectedStations,
    completeCoverage: input.expectedStations > 0 && input.includedStations === input.expectedStations,
  };
}
