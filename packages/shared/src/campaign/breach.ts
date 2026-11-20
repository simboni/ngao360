/**
 * Data breach register (blueprint 15.4): detect → contain → preserve evidence
 * → assess scope and risk → notify the controller and affected parties /
 * regulator where legally required → remediate → document lessons, with an
 * append-only, exportable timeline. Drills are recorded and labelled as
 * drills. The register holds no copies of affected personal data, only
 * categories and counts. API contract §30.
 */
import { z } from 'zod';
import { ExportFormatSchema } from '../enums';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema, CampaignFileSchema } from './common';
import { BreachEventTypeSchema, BreachSeveritySchema, BreachStatusSchema } from './enums';

/** Categories of data involved (never the data itself). */
export const BREACH_DATA_CATEGORIES = [
  'STAFF_CONTACT',
  'AGENT_PERSONAL_DATA',
  'CITIZEN_CASE_DATA',
  'FINANCE_RECORDS',
  'CONTRIBUTOR_DATA',
  'RESULT_FORM_EVIDENCE',
  'CREDENTIALS',
  'OTHER',
] as const;
export const BreachDataCategorySchema = z.enum(BREACH_DATA_CATEGORIES);

export const BreachSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  title: z.string(),
  isDrill: z.boolean(),
  status: BreachStatusSchema,
  severity: BreachSeveritySchema,
  detectedAt: IsoDateTimeSchema,
  owner: UserRefSchema.nullable(),
  regulatorNotifiedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int(),
});
export type BreachSummary = z.infer<typeof BreachSummarySchema>;

export const BreachEventSchema = z.object({
  id: UuidSchema,
  type: BreachEventTypeSchema,
  fromStatus: BreachStatusSchema.nullable(),
  toStatus: BreachStatusSchema.nullable(),
  note: z.string(),
  /** When the step happened (may be earlier than when it was recorded). */
  occurredAt: IsoDateTimeSchema,
  actor: UserRefSchema,
  evidence: CampaignFileSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type BreachEvent = z.infer<typeof BreachEventSchema>;

export const BreachDetailSchema = BreachSummarySchema.extend({
  description: z.string(),
  dataCategories: z.array(BreachDataCategorySchema),
  /** Estimated number of people affected (null = unknown yet). */
  estimatedSubjects: z.number().int().nullable(),
  systemsAffected: z.string().nullable(),
  containmentSummary: z.string().nullable(),
  riskAssessment: z.string().nullable(),
  /** Decision on notification with its legal basis (e.g. "not likely to result in risk", or the duty relied on). */
  notificationDecision: z.string().nullable(),
  controllerNotifiedAt: IsoDateTimeSchema.nullable(),
  subjectsNotifiedAt: IsoDateTimeSchema.nullable(),
  remediationSummary: z.string().nullable(),
  lessonsLearned: z.string().nullable(),
  reportedBy: UserRefSchema,
  closedBy: UserRefSchema.nullable(),
  timeline: z.array(BreachEventSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(['EDIT', 'ADD_EVENT', 'ADVANCE', 'CLOSE', 'REOPEN', 'EXPORT'])),
});
export type BreachDetail = z.infer<typeof BreachDetailSchema>;

export const BreachQuerySchema = PaginationQuerySchema.extend({
  status: BreachStatusSchema.optional(),
  severity: BreachSeveritySchema.optional(),
  includeDrills: QueryBooleanSchema.default(true),
});
export type BreachQuery = z.infer<typeof BreachQuerySchema>;

export const CreateBreachSchema = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(10).max(10000),
  isDrill: z.boolean().default(false),
  severity: BreachSeveritySchema,
  detectedAt: IsoDateTimeSchema,
  dataCategories: z.array(BreachDataCategorySchema).max(BREACH_DATA_CATEGORIES.length).default([]),
  estimatedSubjects: z.number().int().min(0).nullable().optional(),
  systemsAffected: z.string().trim().max(2000).nullable().optional(),
  ownerId: UuidSchema.nullable().optional(),
});
export type CreateBreach = z.infer<typeof CreateBreachSchema>;

export const UpdateBreachSchema = CreateBreachSchema.omit({ isDrill: true, detectedAt: true })
  .partial()
  .extend({
    containmentSummary: z.string().trim().max(5000).nullable().optional(),
    riskAssessment: z.string().trim().max(5000).nullable().optional(),
    notificationDecision: z.string().trim().max(5000).nullable().optional(),
    remediationSummary: z.string().trim().max(5000).nullable().optional(),
    lessonsLearned: z.string().trim().max(5000).nullable().optional(),
    expectedVersion: CampaignExpectedVersionSchema,
  });
export type UpdateBreach = z.infer<typeof UpdateBreachSchema>;

/**
 * Timeline entry. Status-moving types follow BREACH_STATUS_TRANSITIONS:
 * CONTAINED → CONTAINED, EVIDENCE_PRESERVED → EVIDENCE_PRESERVED, ASSESSED →
 * ASSESSED, *_NOTIFIED → NOTIFIED, NOTIFICATION_NOT_REQUIRED → (stays
 * ASSESSED, then REMEDIATED allowed), REMEDIATED → REMEDIATED, CLOSED →
 * CLOSED (lessons required; closer ≠ reporter), REOPENED → ASSESSED. NOTE and
 * LESSONS_RECORDED do not move the status.
 */
export const AddBreachEventSchema = z.object({
  type: BreachEventTypeSchema.exclude(['DETECTED']),
  note: z.string().trim().min(3).max(5000),
  occurredAt: IsoDateTimeSchema.optional(),
  evidenceFileId: UuidSchema.nullable().optional(),
  expectedVersion: CampaignExpectedVersionSchema,
});
export type AddBreachEvent = z.infer<typeof AddBreachEventSchema>;

/** Exportable incident timeline (security.breach.export + re-auth; audited). */
export const ExportBreachTimelineSchema = z.object({ format: ExportFormatSchema.exclude(['XLSX']).default('PDF'), reason: ReasonSchema });
export type ExportBreachTimeline = z.infer<typeof ExportBreachTimelineSchema>;

/** Status a timeline entry moves the record to (null = no move). */
export function breachStatusFor(type: z.infer<typeof BreachEventTypeSchema>): z.infer<typeof BreachStatusSchema> | null {
  switch (type) {
    case 'CONTAINED':
      return 'CONTAINED';
    case 'EVIDENCE_PRESERVED':
      return 'EVIDENCE_PRESERVED';
    case 'ASSESSED':
    case 'REOPENED':
      return 'ASSESSED';
    case 'CONTROLLER_NOTIFIED':
    case 'REGULATOR_NOTIFIED':
    case 'SUBJECTS_NOTIFIED':
      return 'NOTIFIED';
    case 'REMEDIATED':
      return 'REMEDIATED';
    case 'CLOSED':
      return 'CLOSED';
    default:
      return null;
  }
}
