import type { ValidationRules } from '@ngao360/shared';
import {
  CANDIDATES,
  FIELD_SCHEMA_37A,
  FIELD_SCHEMA_37B,
  FIELD_SCHEMA_37C,
  RULES_37A,
  RULES_37B,
  RULES_37C,
  values,
} from './__fixtures__/governor-37a';
import { arithmeticFailures, cellKey, type EngineInput, outcomeByCell, runValidation } from './validation-engine';

const run = (v: Parameters<typeof values>[0], rules: ValidationRules = RULES_37A) =>
  runValidation({ rules, fieldSchema: FIELD_SCHEMA_37A, values: values(v), candidateIds: [...CANDIDATES] });

const byKey = (r: ReturnType<typeof run>, key: string) => {
  const found = r.results.find((x) => x.ruleKey === key);
  if (!found) throw new Error(`rule ${key} missing`);
  return found;
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const CLEAN = {
  candidates: [500, 300, 200],
  total_valid_votes: 1000,
  rejected_ballots: 12,
  total_votes_cast: 1012,
  registered_voters: 1500,
  stamp_present: 1,
  po_signature_present: 1,
};

describe('validation engine', () => {
  it('passes every rule for a consistent form and reports one result per rule in order', () => {
    const r = run(CLEAN);
    expect(r.results.map((x) => x.ruleKey)).toEqual(RULES_37A.rules.map((x) => x.key));
    expect(r.summary.fail).toBe(0);
    expect(r.summary.pass + r.summary.warning + r.summary.fail).toBe(RULES_37A.rules.length);
    expect(byKey(r, 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED').outcome).toBe('PASS');
    expect(r.rulesVersion).toBe(1);
    for (const res of r.results) {
      expect(res.ruleVersion).toBe(1);
      expect(res.reference).toBeTruthy();
    }
  });

  it('fails SUM_EQUALS with the exact fields, cells and arithmetic', () => {
    const r = run({ ...CLEAN, candidates: [500, 299, 200] });
    const res = byKey(r, 'CANDIDATES_SUM_TO_TOTAL_VALID');
    expect(res.outcome).toBe('FAIL');
    expect(res.fieldKeys).toEqual(
      expect.arrayContaining(['total_valid_votes', 'candidate_votes', ...CANDIDATES.map((c) => cellKey('candidate_votes', c))]),
    );
    expect(res.details).toMatchObject({ expected: 1000, actual: 999, difference: -1, evaluated: true });
    expect(res.details.arithmetic).toBe('500 + 299 + 200 = 999; total_valid_votes = 1,000');
    expect(res.message).toContain('candidate_votes = 999');
    expect(res.message).toContain('total_valid_votes = 1,000');
    expect(res.message).toContain('difference -1');
    expect(r.summary.fail).toBe(1);
  });

  it('reports a WARNING (not FAIL) for warning-severity rules, and FAIL for the seeded votes-cast arithmetic', () => {
    const r = run({ ...CLEAN, total_votes_cast: 1600 });
    const turnout = byKey(r, 'VOTES_CAST_NOT_ABOVE_REGISTERED');
    expect(turnout.outcome).toBe('WARNING');
    expect(turnout.details).toMatchObject({ left: { value: 1600 }, right: { value: 1500 }, difference: 100 });
    expect(turnout.message).toContain('exceeds registered_voters = 1,500 by 100');
    // Seeded as FAIL in the shared catalogue: it blocks a pass and counts as arithmetic.
    expect(byKey(r, 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED').outcome).toBe('FAIL');
    expect(r.summary.fail).toBe(1);
    expect(arithmeticFailures(RULES_37A, r).map((f) => f.ruleKey)).toEqual(['VOTES_CAST_EQUALS_VALID_PLUS_REJECTED']);
  });

  it('flags missing required values and names each missing cell', () => {
    const r = run({ candidates: [500, null, 200] });
    const req = byKey(r, 'TOTAL_VALID_PRESENT');
    expect(req.outcome).toBe('FAIL');
    expect(req.details.missing).toEqual(['total_valid_votes']);
    const sum = byKey(r, 'CANDIDATES_SUM_TO_TOTAL_VALID');
    // Arithmetic cannot be evaluated without operands: a warning naming the gaps, never a guess.
    expect(sum.outcome).toBe('WARNING');
    expect(sum.details.evaluated).toBe(false);
    expect(sum.details.missing).toEqual(expect.arrayContaining(['total_valid_votes', cellKey('candidate_votes', CANDIDATES[1])]));
  });

  it('does not evaluate optional "where printed" rules when fields are not captured', () => {
    const r = run({ candidates: [1, 2, 3], total_valid_votes: 6, stamp_present: 1 });
    expect(byKey(r, 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED')).toMatchObject({ outcome: 'WARNING', details: { evaluated: false } });
    expect(byKey(r, 'CANDIDATES_SUM_TO_TOTAL_VALID').outcome).toBe('PASS');
  });

  it('fails NON_NEGATIVE for negative or fractional values and lists each offending cell', () => {
    const r = run({ ...CLEAN, candidates: [-5, 300.5, 200] });
    const res = byKey(r, 'NON_NEGATIVE_COUNTS');
    expect(res.outcome).toBe('FAIL');
    expect(res.details.offending).toEqual([
      { cell: cellKey('candidate_votes', CANDIDATES[0]), value: -5 },
      { cell: cellKey('candidate_votes', CANDIDATES[1]), value: 300.5 },
    ]);
  });

  it('treats observations as reviewer observations only', () => {
    const r = run({ ...CLEAN, stamp_present: 0 });
    const res = byKey(r, 'STAMP_OBSERVED');
    expect(res.outcome).toBe('WARNING');
    expect(res.details.note).toMatch(/cannot establish authenticity/);
  });

  it('flags misconfigured rules referencing unknown fields without throwing', () => {
    const rules: ValidationRules = {
      rulesVersion: 2,
      rules: [{ key: 'BAD', version: 3, type: 'SUM_EQUALS', fields: ['nope', 'candidate_votes'], severity: 'FAIL', message: 'x', reference: 'r' }],
    };
    const r = run(CLEAN, rules);
    expect(r.rulesVersion).toBe(2);
    expect(r.results[0]).toMatchObject({ ruleKey: 'BAD', ruleVersion: 3, outcome: 'WARNING', details: { misconfigured: true } });
  });

  it('never alters or discards input values', () => {
    const input: EngineInput = deepFreeze({
      rules: RULES_37A,
      fieldSchema: FIELD_SCHEMA_37A,
      values: values({ ...CLEAN, candidates: [-1, 300, 200], total_valid_votes: 7 }),
      candidateIds: [...CANDIDATES],
    });
    const before = JSON.stringify(input);
    expect(() => runValidation(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is deterministic', () => {
    expect(run({ ...CLEAN, candidates: [1, 2, 3] })).toEqual(run({ ...CLEAN, candidates: [1, 2, 3] }));
  });

  it('extracts arithmetic failures and per-cell outcomes', () => {
    const r = run({ ...CLEAN, candidates: [500, 300, 201], total_votes_cast: 9999 });
    expect(arithmeticFailures(RULES_37A, r).map((f) => f.ruleKey)).toEqual([
      'CANDIDATES_SUM_TO_TOTAL_VALID',
      'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED',
    ]);
    const cells = outcomeByCell(r);
    expect(cells.get('total_valid_votes')).toBe('FAIL');
    expect(cells.get(cellKey('candidate_votes', CANDIDATES[2]))).toBe('FAIL');
    expect(cells.get('registered_voters')).toBe('WARNING');
    expect(cells.get('stamp_present')).toBe('PASS');
  });

  describe.each([
    ['37B', FIELD_SCHEMA_37B, RULES_37B],
    ['37C', FIELD_SCHEMA_37C, RULES_37C],
  ] as const)('collation form %s (seeded rules)', (_form, schema, rules) => {
    const runC = (v: Parameters<typeof values>[0]) =>
      runValidation({ rules, fieldSchema: schema, values: values(v), candidateIds: [...CANDIDATES] });
    const keyOf = (r: ReturnType<typeof runC>, key: string) => {
      const found = r.results.find((x) => x.ruleKey === key);
      if (!found) throw new Error(`rule ${key} missing`);
      return found;
    };

    it('uses the collation schema and passes consistent totals', () => {
      expect(schema.fields.some((f) => f.key === 'stations_count')).toBe(true);
      const r = runC({ ...CLEAN, po_signature_present: undefined });
      expect(keyOf(r, 'CANDIDATES_SUM_TO_TOTAL_VALID').outcome).toBe('PASS');
      expect(keyOf(r, 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED').outcome).toBe('PASS');
      expect(r.summary.fail).toBe(0);
    });

    it('fails the candidate sum and reports it as arithmetic', () => {
      const r = runC({ ...CLEAN, candidates: [5000, 3000, 2001], total_valid_votes: 10000, total_votes_cast: 10012 });
      expect(keyOf(r, 'CANDIDATES_SUM_TO_TOTAL_VALID')).toMatchObject({ outcome: 'FAIL', details: { expected: 10000, actual: 10001, difference: 1 } });
      expect(arithmeticFailures(rules, r).map((f) => f.ruleKey)).toContain('CANDIDATES_SUM_TO_TOTAL_VALID');
    });

    it('fails votes cast ≠ valid + rejected', () => {
      const r = runC({ ...CLEAN, total_votes_cast: 1013 });
      expect(keyOf(r, 'VOTES_CAST_EQUALS_VALID_PLUS_REJECTED').outcome).toBe('FAIL');
      expect(arithmeticFailures(rules, r).map((f) => f.ruleKey)).toEqual(['VOTES_CAST_EQUALS_VALID_PLUS_REJECTED']);
    });

    it('never guesses when operands are missing', () => {
      const r = runC({ candidates: [500, null, 200], total_valid_votes: 700 });
      const sum = keyOf(r, 'CANDIDATES_SUM_TO_TOTAL_VALID');
      expect(sum.outcome).toBe('WARNING');
      expect(sum.details.evaluated).toBe(false);
      expect(keyOf(r, 'CANDIDATE_VOTES_PRESENT').outcome).toBe('FAIL');
    });
  });
});
