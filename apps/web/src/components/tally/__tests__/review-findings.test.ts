/**
 * Regression tests for review findings in the tally UI (blind re-entry,
 * supervisor routing, arithmetic blockers).
 * Run with the other tally tests: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockingFailures, type CaptureRow } from '../capture-model';
import { submissionHref } from '../links';
import { independentValuesFor } from '../verify-model';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const row = (fieldKey: string, candidateReferenceId: string | null): CaptureRow => ({
  cell: candidateReferenceId ? `${fieldKey}:${candidateReferenceId}` : fieldKey,
  fieldKey,
  candidateReferenceId,
  label: fieldKey,
  candidateName: null,
  kind: candidateReferenceId ? 'CANDIDATE_VOTES' : 'INTEGER',
  section: 'CANDIDATE_FIGURES',
  required: true,
  observationOnly: false,
  min: 0,
  value: null,
});

const rows = [row('candidate_votes', A), row('candidate_votes', B), row('total_valid_votes', null)];

describe('blind re-entry payload', () => {
  it('a Return with blank cells sends no re-entered values (never nulls the API reads as disagreement)', () => {
    const draft = { [`candidate_votes:${A}`]: '600', [`candidate_votes:${B}`]: '', total_valid_votes: '' };
    assert.deepEqual(independentValuesFor('RETURN', 'blind', rows, draft), []);
    assert.deepEqual(independentValuesFor('DISPUTE', 'blind', rows, draft), []);
  });

  it('a Return with every cell entered sends them for information', () => {
    const draft = { [`candidate_votes:${A}`]: '600', [`candidate_votes:${B}`]: '400', total_valid_votes: '1000' };
    const sent = independentValuesFor('RETURN', 'blind', rows, draft);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((v) => typeof v.numericValue === 'number'));
  });

  it('confirm mode never sends re-entered values', () => {
    assert.deepEqual(independentValuesFor('PASS', 'confirm', rows, {}), []);
  });
});

describe('supervisor routing', () => {
  it('a tally supervisor without verify or capture opens the verification workspace for outcomes awaiting them', () => {
    for (const status of ['VERIFIED', 'RETURNED', 'DISPUTED', 'SECOND_REVIEW_PENDING'] as const) {
      assert.equal(submissionHref({ id: 'x', status }, { canVerify: false, canCapture: false, canApprove: true }), '/tally/verify/x');
    }
  });

  it('a clerk still opens capture', () => {
    assert.equal(submissionHref({ id: 'x', status: 'SUBMITTED' }, { canVerify: false, canCapture: true }), '/tally/capture/x');
  });
});

describe('arithmetic blockers', () => {
  it('arithmetic failures on printed figures do not block sending forward; other failures do', () => {
    const split = blockingFailures([
      { outcome: 'FAIL', type: 'SUM_EQUALS' },
      { outcome: 'FAIL', type: 'FIELDS_SUM_EQUALS' },
      { outcome: 'FAIL', type: 'REQUIRED_PRESENT' },
      { outcome: 'WARNING', type: 'LESS_OR_EQUAL' },
    ]);
    assert.equal(split.arithmetic.length, 2);
    assert.deepEqual(
      split.blocking.map((b) => b.type),
      ['REQUIRED_PRESENT'],
    );
  });
});
