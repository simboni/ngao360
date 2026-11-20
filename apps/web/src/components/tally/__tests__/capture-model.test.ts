/**
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/tally/__tests__/tsconfig.json --test src/components/tally/__tests__/*.test.ts src/components/tally/__tests__/*.test.tsx
 * (node:test + tsx; no extra test dependencies.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CandidateReference, FormFieldSchema, ResultValue, ValidationRules } from '@ngao360/shared';
import { analyseDraft, buildRows, initialDraft, liveValidation, parseCell, toCapturedValues, unconfirmedRequired } from '../capture-model';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const candidates: CandidateReference[] = [
  { id: B, contestId: 'c', candidateNameAsPublished: 'Synthetic Candidate Beta', partyLabel: null, isIndependent: true, ballotOrder: 2, referenceCode: null, source: 'synthetic' },
  { id: A, contestId: 'c', candidateNameAsPublished: 'Synthetic Candidate Alpha', partyLabel: 'Demo Party', isIndependent: false, ballotOrder: 1, referenceCode: null, source: 'synthetic' },
];

const schema: FormFieldSchema = {
  schemaVersion: 1,
  fields: [
    { key: 'candidate_votes', label: 'Votes obtained', kind: 'CANDIDATE_VOTES', section: 'CANDIDATE_FIGURES', required: true, perCandidate: true, observationOnly: false, min: 0 },
    { key: 'total_valid_votes', label: 'Total valid votes', kind: 'INTEGER', section: 'STATION_COUNTS', required: true, perCandidate: false, observationOnly: false, min: 0 },
    { key: 'stamp_present', label: 'Stamp present', kind: 'BOOLEAN_OBSERVATION', section: 'OBSERVATIONS', required: false, perCandidate: false, observationOnly: true },
  ],
};

const rules: ValidationRules = {
  rulesVersion: 3,
  rules: [
    { key: 'CANDIDATES_SUM_TO_TOTAL_VALID', version: 1, type: 'SUM_EQUALS', fields: ['total_valid_votes', 'candidate_votes'], severity: 'FAIL', message: 'Sum must equal total', reference: 'Form 37A' },
    { key: 'STAMP_OBSERVED', version: 1, type: 'REQUIRED_OBSERVATION', fields: ['stamp_present'], severity: 'WARNING', message: 'Stamp', reference: 'Form 37A' },
  ],
};

function value(fieldKey: string, candidateReferenceId: string | null, numericValue: number | null, changeVersion = 1): ResultValue {
  return {
    id: `${fieldKey}-${candidateReferenceId ?? 'x'}`,
    fieldKey,
    label: fieldKey,
    candidateReferenceId,
    candidateNameAsPublished: null,
    numericValue,
    textValue: null,
    ocrValue: null,
    ocrConfidence: null,
    confirmedBy: { id: A, displayName: 'Clerk' },
    confirmedAt: '2027-08-09T10:00:00.000Z',
    changeVersion,
    validationOutcome: null,
  };
}

describe('buildRows', () => {
  it('expands per-candidate fields in ballot order and keeps printed labels', () => {
    const rows = buildRows(schema, candidates, []);
    assert.deepEqual(
      rows.map((r) => r.cell),
      [`candidate_votes:${A}`, `candidate_votes:${B}`, 'total_valid_votes', 'stamp_present'],
    );
    assert.equal(rows[0]!.candidateName, 'Synthetic Candidate Alpha');
    assert.equal(rows[2]!.label, 'Total valid votes');
  });

  it('never hides stored values that the template does not list', () => {
    const rows = buildRows(null, [], [value('legacy_field', null, 5)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.cell, 'legacy_field');
  });
});

describe('parseCell', () => {
  const int = { kind: 'INTEGER' as const, min: 0 };
  it('treats empty input as not captured, never zero', () => {
    assert.deepEqual(parseCell(int, ''), { ok: true, numericValue: null });
  });
  it('rejects non-digits, negatives and decimals', () => {
    assert.equal(parseCell(int, '-3').ok, false);
    assert.equal(parseCell(int, '1.5').ok, false);
    assert.equal(parseCell(int, '12a').ok, false);
  });
  it('parses yes/no observations to 1/0', () => {
    assert.deepEqual(parseCell({ kind: 'BOOLEAN_OBSERVATION' }, 'yes'), { ok: true, numericValue: 1 });
    assert.deepEqual(parseCell({ kind: 'BOOLEAN_OBSERVATION' }, 'no'), { ok: true, numericValue: 0 });
  });
});

describe('analyseDraft', () => {
  it('sends only changed cells with the optimistic change version', () => {
    const rows = buildRows(schema, candidates, [value('total_valid_votes', null, 300, 4)]);
    const draft = { ...initialDraft(rows), [`candidate_votes:${A}`]: '120' };
    const a = analyseDraft(rows, draft);
    assert.equal(a.changes.length, 1);
    assert.deepEqual(a.changes[0], { fieldKey: 'candidate_votes', candidateReferenceId: A, numericValue: 120, expectedChangeVersion: 0 });
    assert.deepEqual(a.confirmedEdits, []);
  });

  it('requires a reason when a confirmed value changes', () => {
    const rows = buildRows(schema, candidates, [value('total_valid_votes', null, 300, 4)]);
    const a = analyseDraft(rows, { ...initialDraft(rows), total_valid_votes: '301' });
    assert.deepEqual(a.confirmedEdits, ['total_valid_votes']);
    assert.equal(a.changes[0]!.expectedChangeVersion, 4);
  });

  it('reports invalid input per cell instead of sending it', () => {
    const rows = buildRows(schema, candidates, []);
    const a = analyseDraft(rows, { ...initialDraft(rows), total_valid_votes: 'abc' });
    assert.equal(a.changes.length, 0);
    assert.ok(a.errors.total_valid_votes);
  });
});

describe('liveValidation', () => {
  it('shows exact arithmetic with printed labels and fails on a mismatch', () => {
    const rows = buildRows(schema, candidates, []);
    const draft = { ...initialDraft(rows), [`candidate_votes:${A}`]: '120', [`candidate_votes:${B}`]: '80', total_valid_votes: '205', stamp_present: 'yes' };
    const [sum, stamp] = liveValidation(rules, rows, draft);
    assert.equal(sum!.outcome, 'FAIL');
    assert.match(sum!.readableDetail, /120 \+ 80 = 200; Total valid votes = 205/);
    assert.equal(stamp!.outcome, 'PASS');
  });

  it('skips a comparison when a value is missing instead of assuming zero', () => {
    const rows = buildRows(schema, candidates, []);
    const draft = { ...initialDraft(rows), [`candidate_votes:${A}`]: '120', total_valid_votes: '120' };
    const [sum] = liveValidation(rules, rows, draft);
    assert.equal(sum!.outcome, 'SKIPPED');
    const values = toCapturedValues(rows, draft);
    assert.equal((values.candidate_votes as Record<string, number | undefined>)[B], undefined);
  });
});

describe('unconfirmedRequired', () => {
  it('lists required cells without a person-confirmed value', () => {
    const rows = buildRows(schema, candidates, [value('total_valid_votes', null, 300)]);
    assert.deepEqual(
      unconfirmedRequired(rows).map((r) => r.cell),
      [`candidate_votes:${A}`, `candidate_votes:${B}`],
    );
  });
});
