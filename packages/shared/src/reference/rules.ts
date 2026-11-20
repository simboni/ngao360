/**
 * Declarative validation rules for form templates (blueprint 8.4).
 *
 * Rules are data (`ValidationRules` JSON on the template version). This file
 * gives them precise, testable semantics:
 *
 * - `checkTemplateDefinition()` checks a template's field schema and rules are
 *   consistent (every rule names real fields of the right kind). The API runs it
 *   on create/update; an approver only ever approves a consistent template.
 * - `evaluateValidationRules()` is the reference evaluator. It never changes or
 *   discards values; it returns PASS / WARNING / FAIL per rule naming the exact
 *   fields involved and the rule's form/legal reference.
 *
 * Semantics (fields are template field keys):
 *   SUM_EQUALS            fields = [target, perCandidateField]: sum(per candidate) == target
 *   FIELDS_SUM_EQUALS     fields = [target, a, b, ...]:          a + b + ... == target
 *   LESS_OR_EQUAL         fields = [left, right]:                left <= right
 *   NON_NEGATIVE          every listed numeric value >= 0
 *   REQUIRED_PRESENT      every listed field has a value
 *   REQUIRED_OBSERVATION  every listed observation was recorded as present (true)
 * A comparison whose inputs are missing is SKIPPED (reported as not evaluated),
 * never assumed to be zero. Missing values are caught by REQUIRED_PRESENT.
 */
import type { FormFieldDefinition, FormFieldSchema, ValidationRule, ValidationRules } from '../form-schema';

export interface TemplateDefinitionIssue {
  path: string;
  message: string;
}

const NUMERIC_KINDS = new Set(['INTEGER', 'CANDIDATE_VOTES']);

/** Structural consistency between a template's fields and its rules. */
export function checkTemplateDefinition(fieldSchema: FormFieldSchema, rules: ValidationRules): TemplateDefinitionIssue[] {
  const issues: TemplateDefinitionIssue[] = [];
  const fields = new Map<string, FormFieldDefinition>();
  fieldSchema.fields.forEach((f, i) => {
    if (fields.has(f.key)) issues.push({ path: `fieldSchema.fields.${i}.key`, message: `Duplicate field key "${f.key}"` });
    fields.set(f.key, f);
    if (f.kind === 'CANDIDATE_VOTES' && !f.perCandidate) {
      issues.push({ path: `fieldSchema.fields.${i}.perCandidate`, message: `Candidate vote field "${f.key}" must be per candidate` });
    }
    if (f.perCandidate && f.kind !== 'CANDIDATE_VOTES') {
      issues.push({ path: `fieldSchema.fields.${i}.perCandidate`, message: `Only CANDIDATE_VOTES fields can be per candidate ("${f.key}")` });
    }
    if (f.kind === 'BOOLEAN_OBSERVATION' && !f.observationOnly) {
      issues.push({ path: `fieldSchema.fields.${i}.observationOnly`, message: `Observation field "${f.key}" must be marked observation-only` });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      issues.push({ path: `fieldSchema.fields.${i}.min`, message: `"${f.key}" has min greater than max` });
    }
  });

  const ruleKeys = new Set<string>();
  rules.rules.forEach((r, i) => {
    const at = `validationRules.rules.${i}`;
    if (ruleKeys.has(r.key)) issues.push({ path: `${at}.key`, message: `Duplicate rule key "${r.key}"` });
    ruleKeys.add(r.key);
    if (r.reference.trim().length < 3) issues.push({ path: `${at}.reference`, message: `Rule ${r.key} must cite a form or legal reference` });
    const defs = r.fields.map((k) => fields.get(k));
    r.fields.forEach((k, j) => {
      if (!fields.has(k)) issues.push({ path: `${at}.fields.${j}`, message: `Rule ${r.key} refers to unknown field "${k}"` });
    });
    if (defs.some((d) => !d)) return;
    const numeric = (d: FormFieldDefinition | undefined) => !!d && NUMERIC_KINDS.has(d.kind);
    switch (r.type) {
      case 'SUM_EQUALS':
        if (r.fields.length !== 2 || defs[0]?.kind !== 'INTEGER' || defs[1]?.kind !== 'CANDIDATE_VOTES') {
          issues.push({ path: `${at}.fields`, message: `Rule ${r.key} (SUM_EQUALS) needs [integer target, candidate-votes field]` });
        }
        break;
      case 'FIELDS_SUM_EQUALS':
        if (r.fields.length < 3 || !defs.every((d) => d?.kind === 'INTEGER')) {
          issues.push({ path: `${at}.fields`, message: `Rule ${r.key} (FIELDS_SUM_EQUALS) needs an integer target and at least two integer addends` });
        }
        break;
      case 'LESS_OR_EQUAL':
        if (r.fields.length !== 2 || !defs.every((d) => d?.kind === 'INTEGER')) {
          issues.push({ path: `${at}.fields`, message: `Rule ${r.key} (LESS_OR_EQUAL) needs exactly two integer fields` });
        }
        break;
      case 'NON_NEGATIVE':
        if (!defs.every(numeric)) issues.push({ path: `${at}.fields`, message: `Rule ${r.key} (NON_NEGATIVE) applies to numeric fields only` });
        break;
      case 'REQUIRED_OBSERVATION':
        if (!defs.every((d) => d?.kind === 'BOOLEAN_OBSERVATION')) {
          issues.push({ path: `${at}.fields`, message: `Rule ${r.key} (REQUIRED_OBSERVATION) applies to observation fields only` });
        }
        break;
      case 'REQUIRED_PRESENT':
        break;
    }
  });
  return issues;
}

/* ------------------------------- Evaluation ------------------------------- */

/** Captured values: scalars by field key; per-candidate fields as { candidateId: votes }. */
export type CapturedValue = number | string | boolean | null | undefined | Record<string, number | null | undefined>;
export type CapturedValues = Record<string, CapturedValue>;

export interface RuleEvaluation {
  ruleKey: string;
  ruleVersion: number;
  rulesVersion: number;
  type: ValidationRule['type'];
  /** PASS, or the rule's severity when it is not met; SKIPPED when inputs are missing. */
  outcome: 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED';
  fields: string[];
  message: string;
  reference: string;
  /** Human-readable arithmetic, e.g. "120 + 80 + 10 = 210, expected 205". */
  detail: string;
}

function isPerCandidate(v: CapturedValue): v is Record<string, number | null | undefined> {
  return typeof v === 'object' && v !== null;
}

function num(v: CapturedValue): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function present(v: CapturedValue): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (isPerCandidate(v)) return Object.values(v).length > 0 && Object.values(v).every((x) => typeof x === 'number');
  return true;
}

export function evaluateRule(rule: ValidationRule, values: CapturedValues, rulesVersion = 1): RuleEvaluation {
  const base = {
    ruleKey: rule.key,
    ruleVersion: rule.version,
    rulesVersion,
    type: rule.type,
    fields: rule.fields,
    message: rule.message,
    reference: rule.reference,
  };
  const result = (ok: boolean | null, detail: string): RuleEvaluation => ({
    ...base,
    outcome: ok === null ? 'SKIPPED' : ok ? 'PASS' : rule.severity,
    detail,
  });

  switch (rule.type) {
    case 'SUM_EQUALS': {
      const target = num(values[rule.fields[0]!]);
      const per = values[rule.fields[1]!];
      if (target === null || !isPerCandidate(per) || !present(per)) {
        return result(null, 'Not evaluated: candidate votes or total not captured');
      }
      const parts = Object.values(per) as number[];
      const sum = parts.reduce((a, b) => a + b, 0);
      return result(sum === target, `${parts.join(' + ')} = ${sum}; ${rule.fields[0]} = ${target}`);
    }
    case 'FIELDS_SUM_EQUALS': {
      const [targetKey, ...addKeys] = rule.fields;
      const target = num(values[targetKey!]);
      const parts = addKeys.map((k) => num(values[k]));
      if (target === null || parts.some((p) => p === null)) {
        return result(null, 'Not evaluated: one or more values not captured');
      }
      const sum = (parts as number[]).reduce((a, b) => a + b, 0);
      return result(sum === target, `${addKeys.map((k, i) => `${k} ${parts[i]}`).join(' + ')} = ${sum}; ${targetKey} = ${target}`);
    }
    case 'LESS_OR_EQUAL': {
      const left = num(values[rule.fields[0]!]);
      const right = num(values[rule.fields[1]!]);
      if (left === null || right === null) return result(null, 'Not evaluated: one or both values not captured');
      return result(left <= right, `${rule.fields[0]} ${left} ${left <= right ? '≤' : '>'} ${rule.fields[1]} ${right}`);
    }
    case 'NON_NEGATIVE': {
      const bad: string[] = [];
      let any = false;
      for (const k of rule.fields) {
        const v = values[k];
        if (isPerCandidate(v)) {
          for (const [cand, x] of Object.entries(v)) {
            if (typeof x === 'number') {
              any = true;
              if (x < 0 || !Number.isInteger(x)) bad.push(`${k}[${cand}]`);
            }
          }
        } else if (typeof v === 'number') {
          any = true;
          if (v < 0 || !Number.isInteger(v)) bad.push(k);
        }
      }
      if (!any) return result(null, 'Not evaluated: no numeric values captured');
      return result(bad.length === 0, bad.length ? `Negative or non-whole values: ${bad.join(', ')}` : 'All values are whole numbers ≥ 0');
    }
    case 'REQUIRED_PRESENT': {
      const missing = rule.fields.filter((k) => !present(values[k]));
      return result(missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : 'All present');
    }
    case 'REQUIRED_OBSERVATION': {
      const notObserved = rule.fields.filter((k) => values[k] !== true);
      return result(
        notObserved.length === 0,
        notObserved.length ? `Not observed as present: ${notObserved.join(', ')}` : 'Observed as present',
      );
    }
  }
}

/** Evaluate every rule of a template version. Values are never modified. */
export function evaluateValidationRules(rules: ValidationRules, values: CapturedValues): RuleEvaluation[] {
  return rules.rules.map((r) => evaluateRule(r, values, rules.rulesVersion));
}

/** Overall outcome: FAIL if any rule failed, WARNING if any warned, else PASS. */
export function overallOutcome(results: readonly RuleEvaluation[]): 'PASS' | 'WARNING' | 'FAIL' {
  if (results.some((r) => r.outcome === 'FAIL')) return 'FAIL';
  if (results.some((r) => r.outcome === 'WARNING')) return 'WARNING';
  return 'PASS';
}
