/** Synthetic Form 37A template fixture mirroring the seeded baseline (blueprint Appendix A.1). */
import type { FormFieldSchema, ValidationRules } from '@ngao360/shared';

export const CANDIDATES = [
  'c0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
] as const;

export const FIELD_SCHEMA_37A: FormFieldSchema = {
  schemaVersion: 1,
  fields: [
    { key: 'registered_voters', label: 'Number of registered voters', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'candidate_votes', label: 'Number of valid votes obtained', kind: 'CANDIDATE_VOTES', section: 'CANDIDATE_FIGURES', required: true, perCandidate: true, min: 0, observationOnly: false },
    { key: 'total_valid_votes', label: 'Total number of valid votes cast', kind: 'INTEGER', section: 'CANDIDATE_FIGURES', required: true, perCandidate: false, min: 0, observationOnly: false },
    { key: 'rejected_ballots', label: 'Number of rejected ballot papers', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'total_votes_cast', label: 'Total votes cast', kind: 'INTEGER', section: 'STATION_COUNTS', required: false, perCandidate: false, min: 0, observationOnly: false },
    { key: 'presiding_officer_name', label: 'Name of presiding officer (as printed)', kind: 'TEXT', section: 'DECLARATION', required: false, perCandidate: false, observationOnly: false },
    { key: 'stamp_present', label: 'Official stamp visible', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: true },
  ],
};

export const RULES_37A: ValidationRules = {
  rulesVersion: 1,
  rules: [
    { key: 'NON_NEGATIVE_COUNTS', version: 1, type: 'NON_NEGATIVE', fields: ['candidate_votes', 'total_valid_votes', 'rejected_ballots', 'total_votes_cast', 'registered_voters'], severity: 'FAIL', message: 'Vote counts must be whole numbers of zero or more.', reference: 'Form 37A; blueprint 8.4' },
    { key: 'TOTAL_VALID_PRESENT', version: 1, type: 'REQUIRED_PRESENT', fields: ['total_valid_votes'], severity: 'FAIL', message: 'Total valid votes is printed on the form and must be captured.', reference: 'Form 37A' },
    { key: 'CANDIDATES_SUM_TO_TOTAL_VALID', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'candidate_votes'], severity: 'FAIL', message: 'Sum of candidate votes must equal total valid votes.', reference: 'Form 37A; blueprint 8.4 / 8.5 arithmetic' },
    { key: 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED', version: 1, type: 'FIELDS_SUM_EQUALS', fields: ['total_votes_cast', 'total_valid_votes', 'rejected_ballots'], severity: 'WARNING', message: 'Total votes cast should equal valid votes plus rejected ballots where both are printed.', reference: 'Form 37A (pending 2027 confirmation)' },
    { key: 'VOTES_CAST_NOT_ABOVE_REGISTERED', version: 1, type: 'LESS_OR_EQUAL', fields: ['total_votes_cast', 'registered_voters'], severity: 'WARNING', message: 'Total votes cast exceeds registered voters; flag for human review.', reference: 'Blueprint 8.4 turnout check' },
    { key: 'STAMP_OBSERVED', version: 1, type: 'REQUIRED_OBSERVATION', fields: ['stamp_present'], severity: 'WARNING', message: 'Reviewer has not observed an official stamp.', reference: 'Blueprint 8.4 visible required fields' },
  ],
};

export function values(v: {
  candidates?: Array<number | null>;
  total_valid_votes?: number | null;
  rejected_ballots?: number | null;
  total_votes_cast?: number | null;
  registered_voters?: number | null;
  stamp_present?: number | null;
}) {
  const out: Array<{ fieldKey: string; candidateReferenceId: string | null; numericValue: number | null; textValue: string | null }> = [];
  (v.candidates ?? []).forEach((n, i) => {
    out.push({ fieldKey: 'candidate_votes', candidateReferenceId: CANDIDATES[i]!, numericValue: n, textValue: null });
  });
  for (const k of ['total_valid_votes', 'rejected_ballots', 'total_votes_cast', 'registered_voters', 'stamp_present'] as const) {
    if (v[k] !== undefined) out.push({ fieldKey: k, candidateReferenceId: null, numericValue: v[k] ?? null, textValue: null });
  }
  return out;
}
