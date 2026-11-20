/**
 * Structure of FormTemplate.fieldSchema and FormTemplate.validationRules JSON.
 * Validation rules are versioned and traceable to a form or legal reference
 * (blueprint 8.4). The tally validation engine interprets these.
 */
import { z } from 'zod';

export const FORM_FIELD_KINDS = [
  'CANDIDATE_VOTES',
  'INTEGER',
  'TEXT',
  'DATE_TIME',
  'BOOLEAN_OBSERVATION',
] as const;
export const FormFieldKindSchema = z.enum(FORM_FIELD_KINDS);
export type FormFieldKind = z.infer<typeof FormFieldKindSchema>;

export const FORM_FIELD_SECTIONS = [
  'DECLARATION',
  'CANDIDATE_FIGURES',
  'STATION_COUNTS',
  'DISPUTED_VOTES',
  'OBSERVATIONS',
] as const;
export const FormFieldSectionSchema = z.enum(FORM_FIELD_SECTIONS);

export const FormFieldDefinitionSchema = z.object({
  /** Stable key, e.g. `total_valid_votes`, `registered_voters`, `candidate_votes`. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Label exactly as printed on the official form. */
  label: z.string().min(1),
  kind: FormFieldKindSchema,
  section: FormFieldSectionSchema,
  required: z.boolean().default(false),
  /** For CANDIDATE_VOTES: one value per CandidateReference of the contest. */
  perCandidate: z.boolean().default(false),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  /** Human-observed attribute only (e.g. stamp present); never software-verified. */
  observationOnly: z.boolean().default(false),
  helpText: z.string().optional(),
});
export type FormFieldDefinition = z.infer<typeof FormFieldDefinitionSchema>;

export const FormFieldSchemaSchema = z.object({
  schemaVersion: z.literal(1),
  fields: z.array(FormFieldDefinitionSchema).min(1),
});
export type FormFieldSchema = z.infer<typeof FormFieldSchemaSchema>;

export const VALIDATION_RULE_TYPES = [
  /** sum(candidate_votes[*]) == field */
  'SUM_EQUALS',
  /** left <= right */
  'LESS_OR_EQUAL',
  /** a + b + ... == field */
  'FIELDS_SUM_EQUALS',
  'NON_NEGATIVE',
  'REQUIRED_PRESENT',
  'REQUIRED_OBSERVATION',
] as const;
export const ValidationRuleTypeSchema = z.enum(VALIDATION_RULE_TYPES);

export const ValidationRuleSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  version: z.number().int().positive(),
  type: ValidationRuleTypeSchema,
  /** Field keys involved; the first is the target for SUM_EQUALS / FIELDS_SUM_EQUALS. */
  fields: z.array(z.string()).min(1),
  /** Failing a FAIL rule holds the record from verification; WARNING asks for review. */
  severity: z.enum(['WARNING', 'FAIL']),
  message: z.string(),
  /** Form or legal reference this rule is traceable to. */
  reference: z.string(),
});
export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

export const ValidationRulesSchema = z.object({
  rulesVersion: z.number().int().positive(),
  rules: z.array(ValidationRuleSchema),
});
export type ValidationRules = z.infer<typeof ValidationRulesSchema>;

/** Kenyan form numbering (Appendix A): series per office, suffix per level. */
export const FORM_SERIES: Record<
  'PRESIDENT' | 'NATIONAL_ASSEMBLY' | 'COUNTY_ASSEMBLY' | 'GOVERNOR' | 'SENATOR' | 'WOMAN_REPRESENTATIVE',
  { series: string; station: string; collation: string[]; certificate: string }
> = {
  PRESIDENT: { series: '34', station: '34A', collation: ['34B', '34C'], certificate: '34D' },
  NATIONAL_ASSEMBLY: { series: '35', station: '35A', collation: ['35B'], certificate: '35C' },
  COUNTY_ASSEMBLY: { series: '36', station: '36A', collation: ['36B'], certificate: '36C' },
  GOVERNOR: { series: '37', station: '37A', collation: ['37B', '37C'], certificate: '37D' },
  SENATOR: { series: '38', station: '38A', collation: ['38B', '38C'], certificate: '38D' },
  WOMAN_REPRESENTATIVE: { series: '39', station: '39A', collation: ['39B', '39C'], certificate: '39D' },
};
