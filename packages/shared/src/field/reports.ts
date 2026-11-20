/**
 * Field report DTOs (blueprint 6.1, S11; API contract §19).
 *
 * A report answers one VERSION of a template. Templates are versioned schema
 * JSON (`FieldReportTemplateSchemaSchema`); an ACTIVE template never changes
 * (changes create a new version), so every report can be read against the
 * exact questions it answered. The submitted content of a report is immutable;
 * supervisors review it (accept, return for clarification, escalate, close)
 * and the author answers a return with a new linked report, never an edit.
 *
 * Questions are factual observations. Templates must not ask about voters'
 * political preferences, ethnicity, religion or identity documents
 * (blueprint 15.2); `assertTemplateIsFactual` rejects obvious cases.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { FieldLocationInputSchema, FieldLocationSchema, GeoPointSchema, OfflineMetaSchema } from './common';
import {
  FieldReportReviewStatusSchema,
  FieldReportTemplateStatusSchema,
  FieldReportTypeSchema,
} from './enums';

/* ------------------------------ Template schema ----------------------------- */

export const FIELD_QUESTION_TYPES = [
  'YES_NO',
  'NUMBER',
  'TIME',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'SHORT_TEXT',
  'LONG_TEXT',
] as const;
export const FieldQuestionTypeSchema = z.enum(FIELD_QUESTION_TYPES);
export type FieldQuestionType = z.infer<typeof FieldQuestionTypeSchema>;

const Key = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'lower_snake_case key');

export const FieldQuestionSchema = z
  .object({
    key: Key,
    label: z.string().trim().min(3).max(200),
    helpText: z.string().trim().max(400).optional(),
    type: FieldQuestionTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.object({ value: Key, label: z.string().trim().min(1).max(120) })).max(30).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
  })
  .refine((q) => !['SINGLE_CHOICE', 'MULTI_CHOICE'].includes(q.type) || (q.options?.length ?? 0) >= 2, {
    message: 'Choice questions need at least two options',
    path: ['options'],
  });
export type FieldQuestion = z.infer<typeof FieldQuestionSchema>;

export const FieldReportTemplateSchemaSchema = z
  .object({
    sections: z
      .array(
        z.object({
          key: Key,
          title: z.string().trim().min(2).max(120),
          questions: z.array(FieldQuestionSchema).min(1).max(60),
        }),
      )
      .min(1)
      .max(20),
    /** Allow photo or PDF evidence on this report type. */
    allowEvidence: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const sec of s.sections) {
      for (const q of sec.questions) {
        if (seen.has(q.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate question key ${q.key}`, path: ['sections'] });
        seen.add(q.key);
      }
    }
  });
export type FieldReportTemplateSchema = z.infer<typeof FieldReportTemplateSchemaSchema>;
/** Request-side shape (defaults such as `required: false` optional). */
export type FieldReportTemplateSchemaInput = z.input<typeof FieldReportTemplateSchemaSchema>;

/** Words that mark a question as asking for data the product must not collect (blueprint 15.2). */
const FORBIDDEN_QUESTION_WORDS = [/\bvoted for\b/i, /\bwho .* vote\b/i, /\bethnic/i, /\btribe\b/i, /\breligio/i, /\bid (card )?number\b/i, /\bpolitical (preference|support)\b/i];

/** Labels of questions that look like they collect forbidden personal data. */
export function findNonFactualQuestions(schema: FieldReportTemplateSchema): string[] {
  const out: string[] = [];
  for (const sec of schema.sections) {
    for (const q of sec.questions) {
      if (FORBIDDEN_QUESTION_WORDS.some((re) => re.test(`${q.label} ${q.helpText ?? ''}`))) out.push(q.key);
    }
  }
  return out;
}

/** Answer value by question type. */
export const FieldAnswerValueSchema = z.union([z.boolean(), z.number(), z.string().max(4000), z.array(z.string().max(64)).max(30), z.null()]);
export type FieldAnswerValue = z.infer<typeof FieldAnswerValueSchema>;
export const FieldAnswersSchema = z.record(Key, FieldAnswerValueSchema);
export type FieldAnswers = z.infer<typeof FieldAnswersSchema>;

export interface FieldAnswerIssue {
  questionKey: string;
  message: string;
}

/** Check answers against a template version. Never alters the answers. */
export function validateFieldAnswers(schema: FieldReportTemplateSchema, answers: FieldAnswers): FieldAnswerIssue[] {
  const issues: FieldAnswerIssue[] = [];
  const questions = schema.sections.flatMap((s) => s.questions);
  const known = new Set(questions.map((q) => q.key));
  for (const key of Object.keys(answers)) if (!known.has(key)) issues.push({ questionKey: key, message: 'Not a question of this template version' });
  for (const q of questions) {
    const v = answers[q.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (q.required) issues.push({ questionKey: q.key, message: 'Required' });
      continue;
    }
    const opts = new Set((q.options ?? []).map((o) => o.value));
    switch (q.type) {
      case 'YES_NO':
        if (typeof v !== 'boolean') issues.push({ questionKey: q.key, message: 'Answer yes or no' });
        break;
      case 'NUMBER':
        if (typeof v !== 'number' || !Number.isInteger(v)) issues.push({ questionKey: q.key, message: 'Enter a whole number' });
        else if ((q.min !== undefined && v < q.min) || (q.max !== undefined && v > q.max)) {
          issues.push({ questionKey: q.key, message: `Enter a number between ${q.min ?? '…'} and ${q.max ?? '…'}` });
        }
        break;
      case 'TIME':
        if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) issues.push({ questionKey: q.key, message: 'Enter a time as HH:MM' });
        break;
      case 'SINGLE_CHOICE':
        if (typeof v !== 'string' || !opts.has(v)) issues.push({ questionKey: q.key, message: 'Choose one of the options' });
        break;
      case 'MULTI_CHOICE':
        if (!Array.isArray(v) || v.some((x) => !opts.has(x))) issues.push({ questionKey: q.key, message: 'Choose from the options' });
        break;
      case 'SHORT_TEXT':
      case 'LONG_TEXT': {
        const limit = q.maxLength ?? (q.type === 'SHORT_TEXT' ? 200 : 4000);
        if (typeof v !== 'string') issues.push({ questionKey: q.key, message: 'Enter text' });
        else if (v.length > limit) issues.push({ questionKey: q.key, message: `At most ${limit} characters` });
        break;
      }
    }
  }
  return issues;
}

/* --------------------------------- Templates -------------------------------- */

export const FieldReportTemplateDtoSchema = z.object({
  id: UuidSchema,
  /** Stable key across versions, e.g. "opening-of-polls". */
  key: z.string(),
  version: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  reportType: FieldReportTypeSchema,
  status: FieldReportTemplateStatusSchema,
  schema: FieldReportTemplateSchemaSchema,
  /** Null = usable in every cycle. */
  electionCycleId: UuidSchema.nullable(),
  createdBy: UserRefSchema,
  activatedBy: UserRefSchema.nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type FieldReportTemplateDto = z.infer<typeof FieldReportTemplateDtoSchema>;

export const FieldReportTemplateQuerySchema = PaginationQuerySchema.extend({
  status: FieldReportTemplateStatusSchema.optional(),
  reportType: FieldReportTypeSchema.optional(),
  key: z.string().max(64).optional(),
  electionCycleId: UuidSchema.optional(),
});
export type FieldReportTemplateQuery = z.infer<typeof FieldReportTemplateQuerySchema>;

export const CreateFieldReportTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).nullable().default(null),
  reportType: FieldReportTypeSchema,
  electionCycleId: UuidSchema.nullable().default(null),
  schema: FieldReportTemplateSchemaSchema,
});
export type CreateFieldReportTemplate = z.infer<typeof CreateFieldReportTemplateSchema>;

/** DRAFT → ACTIVE (by someone other than the creator) and ACTIVE → RETIRED. */
export const FieldReportTemplateTransitionSchema = z.object({
  to: z.enum(['ACTIVE', 'RETIRED']),
  reason: ReasonSchema,
});
export type FieldReportTemplateTransition = z.infer<typeof FieldReportTemplateTransitionSchema>;

/* ---------------------------------- Reports --------------------------------- */

export const FieldReportSummarySchema = z.object({
  id: UuidSchema,
  /** FRP-YYYY-NNNNNN */
  reference: z.string(),
  templateId: UuidSchema,
  templateKey: z.string(),
  templateVersion: z.number().int(),
  reportType: FieldReportTypeSchema,
  location: FieldLocationSchema,
  /** When the observed event happened (device time, as reported). */
  eventAt: IsoDateTimeSchema,
  /** When the server received the report. */
  receivedAt: IsoDateTimeSchema,
  author: UserRefSchema,
  reviewStatus: FieldReportReviewStatusSchema,
  submittedOffline: z.boolean(),
  evidenceCount: z.number().int(),
  /** A report answering a "returned for clarification" report. */
  supersedesReportId: UuidSchema.nullable(),
});
export type FieldReportSummary = z.infer<typeof FieldReportSummarySchema>;

export const FIELD_REPORT_ALLOWED_ACTIONS = ['accept', 'return', 'escalate', 'close', 'add_evidence'] as const;
export const FieldReportAllowedActionSchema = z.enum(FIELD_REPORT_ALLOWED_ACTIONS);

export const FieldReportDetailSchema = FieldReportSummarySchema.extend({
  answers: FieldAnswersSchema,
  notes: z.string().nullable(),
  /** Present only when the author attached one and the caller may see it. */
  point: GeoPointSchema.nullable(),
  evidence: z.array(
    z.object({ fileId: UuidSchema, mimeType: z.string(), sizeBytes: z.number().int(), sha256: z.string(), addedAt: IsoDateTimeSchema }),
  ),
  clientCreatedAt: IsoDateTimeSchema.nullable(),
  reviewer: UserRefSchema.nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int(),
  allowedActions: z.array(FieldReportAllowedActionSchema),
});
export type FieldReportDetail = z.infer<typeof FieldReportDetailSchema>;

export const FieldReportQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingStationCode: z.string().trim().max(32).optional(),
  reportType: FieldReportTypeSchema.optional(),
  reviewStatus: z.union([FieldReportReviewStatusSchema, z.array(FieldReportReviewStatusSchema)]).optional(),
  view: z.enum(['mine', 'awaiting_review']).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type FieldReportQuery = z.infer<typeof FieldReportQuerySchema>;

/**
 * Body of POST /field/reports (JSON; evidence is uploaded separately to
 * `POST /field/reports/:id/evidence` or included in a sync batch as
 * already-uploaded file ids). The same body is a `FIELD_REPORT` sync item.
 */
export const CreateFieldReportSchema = OfflineMetaSchema.extend({
  templateId: UuidSchema,
  electionCycleId: UuidSchema,
  location: FieldLocationInputSchema,
  eventAt: IsoDateTimeSchema,
  answers: FieldAnswersSchema,
  notes: z.string().trim().max(4000).nullable().default(null),
  point: GeoPointSchema.nullable().default(null),
  /** Answering a RETURNED report. */
  supersedesReportId: UuidSchema.nullable().default(null),
});
export type CreateFieldReport = z.infer<typeof CreateFieldReportSchema>;

export const ReviewFieldReportSchema = z.object({
  expectedVersion: z.number().int().min(1),
  to: z.enum(['ACCEPTED', 'RETURNED', 'ESCALATED', 'CLOSED']),
  note: z.string().trim().min(3).max(2000),
});
export type ReviewFieldReport = z.infer<typeof ReviewFieldReportSchema>;
