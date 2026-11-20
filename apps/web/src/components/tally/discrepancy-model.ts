/**
 * Normalise the field-level comparison stored on a discrepancy case's
 * `details` into source A / source B rows for S22. Shapes written by the
 * tally module:
 *   REVIEWER_DISAGREEMENT  details.comparison[] { cell, fieldKey, candidateReferenceId, captured, independent, difference }
 *   CROSS_STAGE_MISMATCH   details.comparison[] { fieldKey, candidateReferenceId, sourceA, sourceB, difference }
 *   ARITHMETIC             details.failures[]   { ruleKey, fieldKeys, expected?, actual?, ... }
 * Anything else is shown as raw key/value details. Nothing is overwritten.
 */
import type { DiscrepancyCaseDetail, DiscrepancyStatus } from '@ngao360/shared';

export interface ComparisonRow {
  key: string;
  fieldKey: string;
  candidateReferenceId: string | null;
  sourceA: number | null;
  sourceB: number | null;
  difference: number | null;
}

export interface Comparison {
  labelA: string;
  labelB: string;
  rows: ComparisonRow[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function normaliseComparison(c: Pick<DiscrepancyCaseDetail, 'varianceType' | 'details'>): Comparison | null {
  const raw = (c.details as Record<string, unknown>).comparison;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const isReviewer = raw.some((r) => r && typeof r === 'object' && 'independent' in r);
  const rows = raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r, i) => {
      const fieldKey = str(r.fieldKey) ?? str(r.cell) ?? `field ${i + 1}`;
      const candidateReferenceId = str(r.candidateReferenceId);
      const a = isReviewer ? num(r.captured) : num(r.sourceA);
      const b = isReviewer ? num(r.independent) : num(r.sourceB);
      return {
        key: str(r.cell) ?? (candidateReferenceId ? `${fieldKey}:${candidateReferenceId}` : `${fieldKey}#${i}`),
        fieldKey,
        candidateReferenceId,
        sourceA: a,
        sourceB: b,
        difference: num(r.difference) ?? (a !== null && b !== null ? b - a : null),
      };
    });
  return isReviewer
    ? { labelA: 'Captured value', labelB: 'Second reviewer', rows }
    : { labelA: 'Source A (verified station forms)', labelB: 'Source B (collation form)', rows };
}

export interface ArithmeticFailure {
  ruleKey: string;
  fieldKeys: string[];
  extra: Record<string, unknown>;
}

export function arithmeticFailures(c: Pick<DiscrepancyCaseDetail, 'details'>): ArithmeticFailure[] {
  const raw = (c.details as Record<string, unknown>).failures;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      const { ruleKey, fieldKeys, ...extra } = r;
      return { ruleKey: str(ruleKey) ?? 'rule', fieldKeys: Array.isArray(fieldKeys) ? fieldKeys.map(String) : [], extra };
    });
}

/** Case transitions a manager can make by hand (resolve/close have dedicated actions). */
export function manualTransitions(status: DiscrepancyStatus): DiscrepancyStatus[] {
  switch (status) {
    case 'OPEN':
      return ['UNDER_REVIEW', 'ESCALATED'];
    case 'UNDER_REVIEW':
      return ['ESCALATED'];
    case 'ESCALATED':
      return ['UNDER_REVIEW'];
    default:
      return [];
  }
}
