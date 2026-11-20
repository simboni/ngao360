/**
 * NGAO TALLY validation engine (blueprint 8.4, 17.2).
 *
 * Pure functions: evaluates a form template's declarative, versioned rules
 * against captured values and returns a PASS / WARNING / FAIL result per rule
 * with the exact fields and arithmetic involved. It never alters, corrects or
 * discards a value: inputs are read-only and results only describe them.
 */
import type {
  FormFieldDefinition,
  FormFieldSchema,
  ValidationOutcome,
  ValidationRule,
  ValidationRules,
} from '@ngao360/shared';

export interface EngineValue {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
  textValue: string | null;
}

export interface EngineInput {
  rules: ValidationRules;
  fieldSchema: FormFieldSchema;
  values: readonly EngineValue[];
  /** Candidate ids of the contest, in ballot order (for per-candidate fields). */
  candidateIds: readonly string[];
}

export interface EngineResult {
  ruleKey: string;
  ruleVersion: number;
  outcome: ValidationOutcome;
  /** Exact fields examined; per-candidate cells use `fieldKey:candidateId`. */
  fieldKeys: string[];
  message: string;
  details: Record<string, unknown>;
  reference: string;
}

export interface EngineRun {
  rulesVersion: number;
  results: EngineResult[];
  summary: { pass: number; warning: number; fail: number };
}

/** Key of one captured cell, e.g. `total_valid_votes` or `candidate_votes:<uuid>`. */
export function cellKey(fieldKey: string, candidateReferenceId: string | null): string {
  return candidateReferenceId ? `${fieldKey}:${candidateReferenceId}` : fieldKey;
}

interface Operand {
  fieldKey: string;
  /** Sum of the field (per-candidate fields are summed across all candidates). */
  value: number | null;
  /** Cells that are missing (not captured). */
  missing: string[];
  /** Per-candidate breakdown for per-candidate fields. */
  cells?: Array<{ candidateReferenceId: string; value: number | null }>;
}

class ValueIndex {
  private readonly map = new Map<string, EngineValue>();
  constructor(values: readonly EngineValue[]) {
    for (const v of values) this.map.set(cellKey(v.fieldKey, v.candidateReferenceId), v);
  }
  get(fieldKey: string, candidateId: string | null): EngineValue | undefined {
    return this.map.get(cellKey(fieldKey, candidateId));
  }
  /** All captured cells of a field (any candidate). */
  allOf(fieldKey: string): EngineValue[] {
    return [...this.map.values()].filter((v) => v.fieldKey === fieldKey);
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-GB');
}

function operand(
  def: FormFieldDefinition,
  idx: ValueIndex,
  candidateIds: readonly string[],
): Operand {
  if (def.perCandidate) {
    const cells = candidateIds.map((cid) => ({
      candidateReferenceId: cid,
      value: idx.get(def.key, cid)?.numericValue ?? null,
    }));
    const missing = cells.filter((c) => c.value === null).map((c) => cellKey(def.key, c.candidateReferenceId));
    const value = missing.length === cells.length ? null : cells.reduce((s, c) => s + (c.value ?? 0), 0);
    return { fieldKey: def.key, value, missing, cells };
  }
  const v = idx.get(def.key, null)?.numericValue ?? null;
  return { fieldKey: def.key, value: v, missing: v === null ? [def.key] : [] };
}

function result(
  rule: ValidationRule,
  outcome: ValidationOutcome,
  fieldKeys: string[],
  message: string,
  details: Record<string, unknown>,
): EngineResult {
  return {
    ruleKey: rule.key,
    ruleVersion: rule.version,
    outcome,
    fieldKeys: [...new Set(fieldKeys)],
    message,
    details,
    reference: rule.reference,
  };
}

/** Outcome when a rule is breached: the rule's configured severity. */
function breach(rule: ValidationRule): ValidationOutcome {
  return rule.severity === 'FAIL' ? 'FAIL' : 'WARNING';
}

function notEvaluated(rule: ValidationRule, fields: string[], missing: string[]): EngineResult {
  return result(
    rule,
    'WARNING',
    [...fields, ...missing],
    `Not evaluated: ${missing.join(', ')} not captured. Confirm against the source form whether ${
      missing.length === 1 ? 'it is' : 'they are'
    } printed. ${rule.message}`,
    { evaluated: false, missing },
  );
}

function evaluateRule(
  rule: ValidationRule,
  defs: Map<string, FormFieldDefinition>,
  idx: ValueIndex,
  candidateIds: readonly string[],
): EngineResult {
  const unknown = rule.fields.filter((f) => !defs.has(f));
  if (unknown.length > 0) {
    return result(
      rule,
      'WARNING',
      rule.fields,
      `Rule configuration references fields not in the form template: ${unknown.join(', ')}. Ask the configuration administrator to review the template.`,
      { evaluated: false, misconfigured: true, unknownFields: unknown },
    );
  }
  const fieldDefs = rule.fields.map((f) => defs.get(f)!);

  switch (rule.type) {
    case 'NON_NEGATIVE': {
      const offending: Array<{ cell: string; value: number }> = [];
      for (const def of fieldDefs) {
        for (const v of idx.allOf(def.key)) {
          if (v.numericValue !== null && (v.numericValue < 0 || !Number.isInteger(v.numericValue))) {
            offending.push({ cell: cellKey(v.fieldKey, v.candidateReferenceId), value: v.numericValue });
          }
        }
      }
      if (offending.length === 0) return result(rule, 'PASS', rule.fields, rule.message, { evaluated: true });
      return result(
        rule,
        breach(rule),
        [...rule.fields, ...offending.map((o) => o.cell)],
        `${rule.message} Not a whole number of zero or more: ${offending
          .map((o) => `${o.cell} = ${o.value}`)
          .join('; ')}.`,
        { evaluated: true, offending },
      );
    }

    case 'REQUIRED_PRESENT': {
      const missing: string[] = [];
      for (const def of fieldDefs) {
        if (def.perCandidate) {
          for (const cid of candidateIds) {
            const v = idx.get(def.key, cid);
            if (!v || (v.numericValue === null && (v.textValue ?? '') === '')) missing.push(cellKey(def.key, cid));
          }
        } else {
          const v = idx.get(def.key, null);
          if (!v || (v.numericValue === null && (v.textValue ?? '') === '')) missing.push(def.key);
        }
      }
      if (missing.length === 0) return result(rule, 'PASS', rule.fields, rule.message, { evaluated: true });
      return result(rule, breach(rule), [...rule.fields, ...missing], `${rule.message} Missing: ${missing.join(', ')}.`, {
        evaluated: true,
        missing,
      });
    }

    case 'REQUIRED_OBSERVATION': {
      const notObserved: string[] = [];
      for (const def of fieldDefs) {
        const v = idx.get(def.key, null);
        if (!v || v.numericValue !== 1) notObserved.push(def.key);
      }
      if (notObserved.length === 0) return result(rule, 'PASS', rule.fields, rule.message, { evaluated: true });
      return result(rule, breach(rule), rule.fields, rule.message, {
        evaluated: true,
        notObserved,
        note: 'Reviewer observation only; software cannot establish authenticity.',
      });
    }

    case 'SUM_EQUALS':
    case 'FIELDS_SUM_EQUALS': {
      const [targetDef, ...operandDefs] = fieldDefs;
      if (!targetDef || operandDefs.length === 0) {
        return result(rule, 'WARNING', rule.fields, 'Rule needs a target field and at least one operand.', {
          evaluated: false,
          misconfigured: true,
        });
      }
      const target = operand(targetDef, idx, candidateIds);
      const operands = operandDefs.map((d) => operand(d, idx, candidateIds));
      const missing = [...target.missing, ...operands.flatMap((o) => o.missing)];
      const cellKeys = operands.flatMap((o) =>
        o.cells ? o.cells.map((c) => cellKey(o.fieldKey, c.candidateReferenceId)) : [o.fieldKey],
      );
      if (missing.length > 0) return notEvaluated(rule, rule.fields, missing);
      const expected = target.value!;
      const actual = operands.reduce((s, o) => s + (o.value ?? 0), 0);
      const difference = actual - expected;
      const details = {
        evaluated: true,
        target: { fieldKey: target.fieldKey, value: expected },
        operands: operands.map((o) => ({
          fieldKey: o.fieldKey,
          value: o.value,
          ...(o.cells ? { cells: o.cells } : {}),
        })),
        expected,
        actual,
        difference,
        arithmetic: `${operands
          .map((o) => (o.cells ? o.cells.map((c) => fmt(c.value ?? 0)).join(' + ') : fmt(o.value ?? 0)))
          .join(' + ')} = ${fmt(actual)}; ${target.fieldKey} = ${fmt(expected)}`,
      };
      if (difference === 0) return result(rule, 'PASS', [...rule.fields, ...cellKeys], rule.message, details);
      return result(
        rule,
        breach(rule),
        [...rule.fields, ...cellKeys],
        `${rule.message} ${operands.map((o) => o.fieldKey).join(' + ')} = ${fmt(actual)}, but ${
          target.fieldKey
        } = ${fmt(expected)} (difference ${difference > 0 ? '+' : ''}${fmt(difference)}).`,
        details,
      );
    }

    case 'LESS_OR_EQUAL': {
      const [leftDef, rightDef] = fieldDefs;
      if (!leftDef || !rightDef) {
        return result(rule, 'WARNING', rule.fields, 'Rule needs exactly two fields.', {
          evaluated: false,
          misconfigured: true,
        });
      }
      const left = operand(leftDef, idx, candidateIds);
      const right = operand(rightDef, idx, candidateIds);
      const missing = [...left.missing, ...right.missing];
      if (missing.length > 0) return notEvaluated(rule, rule.fields, missing);
      const details = {
        evaluated: true,
        left: { fieldKey: left.fieldKey, value: left.value },
        right: { fieldKey: right.fieldKey, value: right.value },
        difference: left.value! - right.value!,
        arithmetic: `${left.fieldKey} (${fmt(left.value!)}) <= ${right.fieldKey} (${fmt(right.value!)})`,
      };
      if (left.value! <= right.value!) return result(rule, 'PASS', rule.fields, rule.message, details);
      return result(
        rule,
        breach(rule),
        rule.fields,
        `${rule.message} ${left.fieldKey} = ${fmt(left.value!)} exceeds ${right.fieldKey} = ${fmt(right.value!)} by ${fmt(
          left.value! - right.value!,
        )}.`,
        details,
      );
    }

    default: {
      const exhaustive: never = rule.type;
      return result(rule, 'WARNING', rule.fields, `Unknown rule type ${String(exhaustive)}`, {
        evaluated: false,
        misconfigured: true,
      });
    }
  }
}

/** Evaluate every rule of a template. Results are returned in rule order. */
export function runValidation(input: EngineInput): EngineRun {
  const defs = new Map(input.fieldSchema.fields.map((f) => [f.key, f] as const));
  const idx = new ValueIndex(input.values);
  const results = input.rules.rules.map((rule) => evaluateRule(rule, defs, idx, input.candidateIds));
  const summary = { pass: 0, warning: 0, fail: 0 };
  for (const r of results) {
    if (r.outcome === 'PASS') summary.pass += 1;
    else if (r.outcome === 'WARNING') summary.warning += 1;
    else summary.fail += 1;
  }
  return { rulesVersion: input.rules.rulesVersion, results, summary };
}

/** Rule types whose FAIL is an arithmetic discrepancy (blueprint 8.5 "Arithmetic"). */
export const ARITHMETIC_RULE_TYPES: ReadonlySet<string> = new Set(['SUM_EQUALS', 'FIELDS_SUM_EQUALS', 'LESS_OR_EQUAL']);

/** FAIL results produced by arithmetic rules. */
export function arithmeticFailures(rules: ValidationRules, run: EngineRun): EngineResult[] {
  const types = new Map(rules.rules.map((r) => [r.key, r.type] as const));
  return run.results.filter((r) => r.outcome === 'FAIL' && ARITHMETIC_RULE_TYPES.has(types.get(r.ruleKey) ?? ''));
}

/** Validation outcome per captured cell (worst outcome of the rules that name it). */
export function outcomeByCell(run: EngineRun): Map<string, ValidationOutcome> {
  const rank: Record<ValidationOutcome, number> = { PASS: 0, WARNING: 1, FAIL: 2 };
  const out = new Map<string, ValidationOutcome>();
  for (const r of run.results) {
    for (const k of r.fieldKeys) {
      const prev = out.get(k);
      if (!prev || rank[r.outcome] > rank[prev]) out.set(k, r.outcome);
    }
  }
  return out;
}
