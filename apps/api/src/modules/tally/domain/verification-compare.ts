import type { FormFieldSchema } from '@ngao360/shared';
import { cellKey } from './validation-engine';

export interface CapturedCell {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
}

export interface IndependentCell {
  fieldKey: string;
  candidateReferenceId: string | null;
  numericValue: number | null;
}

export interface CellMismatch {
  cell: string;
  fieldKey: string;
  candidateReferenceId: string | null;
  captured: number | null;
  independent: number | null;
  difference: number | null;
}

/**
 * Numeric cells a reviewer must re-enter in independent re-entry mode: every
 * candidate-vote cell and every required numeric field of the template.
 */
export function requiredReentryCells(schema: FormFieldSchema, candidateIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of schema.fields) {
    if (f.observationOnly) continue;
    if (f.kind === 'CANDIDATE_VOTES' && f.perCandidate) {
      for (const c of candidateIds) out.push(cellKey(f.key, c));
    } else if (f.kind === 'INTEGER' && f.required) {
      out.push(f.key);
    }
  }
  return out;
}

/**
 * Compare a second reviewer's independently entered values with the captured
 * values. Pure: neither side is modified. A difference opens a
 * REVIEWER_DISAGREEMENT case; it never overwrites the captured value.
 */
export function compareIndependentValues(
  captured: readonly CapturedCell[],
  independent: readonly IndependentCell[],
): CellMismatch[] {
  const cap = new Map(captured.map((c) => [cellKey(c.fieldKey, c.candidateReferenceId), c] as const));
  const out: CellMismatch[] = [];
  for (const iv of independent) {
    const key = cellKey(iv.fieldKey, iv.candidateReferenceId);
    const c = cap.get(key);
    const capturedValue = c?.numericValue ?? null;
    if (capturedValue !== iv.numericValue) {
      out.push({
        cell: key,
        fieldKey: iv.fieldKey,
        candidateReferenceId: iv.candidateReferenceId,
        captured: capturedValue,
        independent: iv.numericValue,
        difference:
          capturedValue !== null && iv.numericValue !== null ? iv.numericValue - capturedValue : null,
      });
    }
  }
  return out;
}
