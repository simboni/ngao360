/**
 * Pure capture-grid logic for S19/S20: builds one row per captured cell from the
 * approved template, parses reviewer input, works out which cells changed and
 * whether a change reason is required, and evaluates the template's
 * validation rules live with exact arithmetic.
 *
 * Nothing here modifies a stored value; the API re-validates and is the
 * authority on every rule outcome.
 */
import type {
  CandidateReference,
  CaptureValueInput,
  FormFieldDefinition,
  FormFieldSchema,
  ResultValue,
  ValidationRules,
} from '@ngao360/shared';
import { type CapturedValues, evaluateValidationRules, type RuleEvaluation } from '@ngao360/shared';

export type CellKind = FormFieldDefinition['kind'];

export interface CaptureRow {
  /** `fieldKey` or `fieldKey:candidateId` (matches the API's cell key). */
  cell: string;
  fieldKey: string;
  candidateReferenceId: string | null;
  /** Label exactly as printed on the form template. */
  label: string;
  candidateName: string | null;
  kind: CellKind;
  section: FormFieldDefinition['section'];
  required: boolean;
  observationOnly: boolean;
  min?: number;
  max?: number;
  helpText?: string;
  value: ResultValue | null;
}

export type Draft = Record<string, string>;

export function cellKey(fieldKey: string, candidateReferenceId: string | null): string {
  return candidateReferenceId ? `${fieldKey}:${candidateReferenceId}` : fieldKey;
}

const NUMERIC: ReadonlySet<CellKind> = new Set(['INTEGER', 'CANDIDATE_VOTES']);
export const isNumericKind = (k: CellKind) => NUMERIC.has(k);

/**
 * Rows in template order; per-candidate fields expand to one row per candidate
 * in ballot order. Without a template (reference data unavailable) the rows are
 * derived from the stored values so nothing captured is ever hidden.
 */
export function buildRows(
  schema: FormFieldSchema | null | undefined,
  candidates: readonly CandidateReference[],
  values: readonly ResultValue[],
): CaptureRow[] {
  const byCell = new Map(values.map((v) => [cellKey(v.fieldKey, v.candidateReferenceId), v] as const));
  const rows: CaptureRow[] = [];
  if (schema) {
    const ordered = [...candidates].sort((a, b) => a.ballotOrder - b.ballotOrder);
    for (const f of schema.fields) {
      const base = {
        fieldKey: f.key,
        label: f.label,
        kind: f.kind,
        section: f.section,
        required: f.required,
        observationOnly: f.observationOnly,
        min: f.min,
        max: f.max,
        helpText: f.helpText,
      };
      if (f.perCandidate) {
        for (const c of ordered) {
          const cell = cellKey(f.key, c.id);
          rows.push({ ...base, cell, candidateReferenceId: c.id, candidateName: c.candidateNameAsPublished, value: byCell.get(cell) ?? null });
          byCell.delete(cell);
        }
      } else {
        rows.push({ ...base, cell: f.key, candidateReferenceId: null, candidateName: null, value: byCell.get(f.key) ?? null });
        byCell.delete(f.key);
      }
    }
  }
  // Stored values the template does not list (or no template): still shown.
  for (const [cell, v] of byCell) {
    rows.push({
      cell,
      fieldKey: v.fieldKey,
      candidateReferenceId: v.candidateReferenceId,
      label: v.label,
      candidateName: v.candidateNameAsPublished,
      kind: v.candidateReferenceId ? 'CANDIDATE_VOTES' : v.numericValue !== null ? 'INTEGER' : 'TEXT',
      section: v.candidateReferenceId ? 'CANDIDATE_FIGURES' : 'STATION_COUNTS',
      required: false,
      observationOnly: false,
      value: v,
    });
  }
  return rows;
}

/** Display string of a stored value, as the reviewer input expects it. */
export function storedText(row: Pick<CaptureRow, 'kind' | 'value'>): string {
  const v = row.value;
  if (!v) return '';
  if (row.kind === 'BOOLEAN_OBSERVATION') return v.numericValue === null ? '' : v.numericValue === 1 ? 'yes' : 'no';
  if (isNumericKind(row.kind)) return v.numericValue === null ? '' : String(v.numericValue);
  return v.textValue ?? '';
}

export function initialDraft(rows: readonly CaptureRow[]): Draft {
  return Object.fromEntries(rows.map((r) => [r.cell, storedText(r)]));
}

export type Parsed =
  | { ok: true; numericValue?: number | null; textValue?: string | null }
  | { ok: false; error: string };

/** Parse reviewer input for a cell. Empty input means "not captured" (null), never zero. */
export function parseCell(row: Pick<CaptureRow, 'kind' | 'min' | 'max'>, raw: string): Parsed {
  const s = raw.trim();
  if (row.kind === 'BOOLEAN_OBSERVATION') {
    if (s === '') return { ok: true, numericValue: null };
    if (s === 'yes') return { ok: true, numericValue: 1 };
    if (s === 'no') return { ok: true, numericValue: 0 };
    return { ok: false, error: 'Choose yes or no' };
  }
  if (isNumericKind(row.kind)) {
    if (s === '') return { ok: true, numericValue: null };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Enter a whole number (digits only)' };
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n > 10_000_000) return { ok: false, error: 'Number is too large' };
    if (row.min !== undefined && n < row.min) return { ok: false, error: `Must be at least ${row.min}` };
    if (row.max !== undefined && n > row.max) return { ok: false, error: `Must be at most ${row.max}` };
    return { ok: true, numericValue: n };
  }
  if (s.length > 2000) return { ok: false, error: 'Too long (2000 characters maximum)' };
  return { ok: true, textValue: s === '' ? null : s };
}

export interface DraftAnalysis {
  changes: CaptureValueInput[];
  errors: Record<string, string>;
  /** Cells whose existing, person-confirmed value would change: a reason is mandatory. */
  confirmedEdits: string[];
}

export function analyseDraft(rows: readonly CaptureRow[], draft: Draft): DraftAnalysis {
  const changes: CaptureValueInput[] = [];
  const errors: Record<string, string> = {};
  const confirmedEdits: string[] = [];
  for (const r of rows) {
    const raw = draft[r.cell] ?? '';
    if (raw.trim() === storedText(r).trim()) continue;
    const p = parseCell(r, raw);
    if (!p.ok) {
      errors[r.cell] = p.error;
      continue;
    }
    const hadValue = !!r.value && (r.value.numericValue !== null || r.value.textValue !== null);
    if (hadValue) confirmedEdits.push(r.cell);
    changes.push({
      fieldKey: r.fieldKey,
      candidateReferenceId: r.candidateReferenceId,
      ...(p.numericValue !== undefined ? { numericValue: p.numericValue } : {}),
      ...(p.textValue !== undefined ? { textValue: p.textValue } : {}),
      expectedChangeVersion: r.value?.changeVersion ?? 0,
    });
  }
  return { changes, errors, confirmedEdits };
}

/** Values in the evaluator's shape: scalars by field key, per-candidate maps by candidate id. */
export function toCapturedValues(rows: readonly CaptureRow[], draft: Draft): CapturedValues {
  const out: CapturedValues = {};
  for (const r of rows) {
    const p = parseCell(r, draft[r.cell] ?? '');
    const n = p.ok ? (p.numericValue ?? null) : null;
    if (r.candidateReferenceId) {
      const existing = out[r.fieldKey];
      const map = (typeof existing === 'object' && existing !== null ? existing : {}) as Record<string, number | null | undefined>;
      map[r.candidateReferenceId] = n ?? undefined;
      out[r.fieldKey] = map;
    } else if (r.kind === 'BOOLEAN_OBSERVATION') {
      out[r.fieldKey] = n === null ? null : n === 1;
    } else if (isNumericKind(r.kind)) {
      out[r.fieldKey] = n;
    } else {
      out[r.fieldKey] = p.ok ? (p.textValue ?? null) : null;
    }
  }
  return out;
}

export interface LiveCheck extends RuleEvaluation {
  /** Detail with field keys replaced by their printed labels. */
  readableDetail: string;
  labels: string[];
}

export function liveValidation(rules: ValidationRules | null | undefined, rows: readonly CaptureRow[], draft: Draft): LiveCheck[] {
  if (!rules) return [];
  const labelOf = new Map<string, string>();
  for (const r of rows) if (!labelOf.has(r.fieldKey)) labelOf.set(r.fieldKey, r.label);
  const keys = [...labelOf.keys()].sort((a, b) => b.length - a.length);
  const humanise = (text: string) =>
    keys.reduce((t, k) => t.replace(new RegExp(`\\b${k}\\b`, 'g'), labelOf.get(k)!), text);
  return evaluateValidationRules(rules, toCapturedValues(rows, draft)).map((e) => ({
    ...e,
    readableDetail: humanise(e.detail),
    labels: e.fields.map((f) => labelOf.get(f) ?? f),
  }));
}

/** Every required cell has a value confirmed by a person (OCR drafts never count). */
export function unconfirmedRequired(rows: readonly CaptureRow[]): CaptureRow[] {
  return rows.filter((r) => r.required && !r.observationOnly && (!r.value?.confirmedBy || (r.value.numericValue === null && r.value.textValue === null)));
}

/** Rule types that check figures add up (or stay within a total) rather than that they were entered. */
export const ARITHMETIC_RULE_TYPES: ReadonlySet<string> = new Set(['SUM_EQUALS', 'FIELDS_SUM_EQUALS', 'LESS_OR_EQUAL']);

/**
 * Failed checks that block sending a record forward. Arithmetic failures on
 * figures entered exactly as printed do not block: the record goes to second
 * review held by an arithmetic case (blueprint 8.5). The API decides finally.
 */
export function blockingFailures<T extends { outcome: string; type: string }>(checks: readonly T[]): { blocking: T[]; arithmetic: T[] } {
  const fails = checks.filter((c) => c.outcome === 'FAIL');
  return {
    blocking: fails.filter((c) => !ARITHMETIC_RULE_TYPES.has(c.type)),
    arithmetic: fails.filter((c) => ARITHMETIC_RULE_TYPES.has(c.type)),
  };
}
