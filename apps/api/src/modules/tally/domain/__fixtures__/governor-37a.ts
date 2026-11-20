/** Synthetic Governor template fixtures (blueprint Appendix A.1), taken from the seeded catalogue. */
import { buildFormTemplateDefinition, findFormCatalogueEntry, type FormFieldSchema, type ValidationRules } from '@ngao360/shared';

export const CANDIDATES = [
  'c0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000003',
] as const;

/**
 * Built from the same shared catalogue the seed uses, so tests exercise the
 * production field schema and rules (including FAIL-severity arithmetic),
 * never a hand-written copy that can drift.
 */
function catalogueTemplate(formNumber: '37A' | '37B' | '37C'): { fieldSchema: FormFieldSchema; validationRules: ValidationRules } {
  const entry = findFormCatalogueEntry(formNumber);
  if (!entry) throw new Error(`Form ${formNumber} missing from the shared catalogue`);
  const def = buildFormTemplateDefinition(entry);
  return { fieldSchema: def.fieldSchema, validationRules: def.validationRules };
}

const T37A = catalogueTemplate('37A');
const T37B = catalogueTemplate('37B');
const T37C = catalogueTemplate('37C');

export const FIELD_SCHEMA_37A: FormFieldSchema = T37A.fieldSchema;
export const RULES_37A: ValidationRules = T37A.validationRules;
export const FIELD_SCHEMA_37B: FormFieldSchema = T37B.fieldSchema;
export const RULES_37B: ValidationRules = T37B.validationRules;
export const FIELD_SCHEMA_37C: FormFieldSchema = T37C.fieldSchema;
export const RULES_37C: ValidationRules = T37C.validationRules;

export function values(v: {
  candidates?: Array<number | null>;
  total_valid_votes?: number | null;
  rejected_ballots?: number | null;
  total_votes_cast?: number | null;
  registered_voters?: number | null;
  stamp_present?: number | null;
  po_signature_present?: number | null;
}) {
  const out: Array<{ fieldKey: string; candidateReferenceId: string | null; numericValue: number | null; textValue: string | null }> = [];
  (v.candidates ?? []).forEach((n, i) => {
    out.push({ fieldKey: 'candidate_votes', candidateReferenceId: CANDIDATES[i]!, numericValue: n, textValue: null });
  });
  for (const k of ['total_valid_votes', 'rejected_ballots', 'total_votes_cast', 'registered_voters', 'stamp_present', 'po_signature_present'] as const) {
    if (v[k] !== undefined) out.push({ fieldKey: k, candidateReferenceId: null, numericValue: v[k] ?? null, textValue: null });
  }
  return out;
}
