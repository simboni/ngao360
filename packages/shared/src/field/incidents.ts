/**
 * Incident DTOs (blueprint 7.3, S17; API contract §20).
 *
 * Incidents are factual records:
 * - the original report (category as reported, time, location, description,
 *   reporter, evidence) is immutable; corrections, notes, triage decisions,
 *   assignments, escalations, referrals and closure are appended as
 *   `IncidentEvent`s;
 * - incidents are never deleted, only closed (and reopened with a reason);
 * - a description is a neutral account of what was observed. Naming a person
 *   or institution is allowed only in the separate, restricted `subject`
 *   record (`field.incidents.view_subject`), never in the description or in
 *   lists, notifications or exports. Nothing is labelled fraudulent or
 *   criminal by the system (blueprint 15.3).
 */
import { z } from 'zod';
import { SensitivityLevelSchema } from '../enums';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { FieldLocationInputSchema, FieldLocationSchema, GeoPointSchema, OfflineMetaSchema } from './common';
import {
  IncidentCategorySchema,
  IncidentEscalationTargetSchema,
  IncidentEventTypeSchema,
  IncidentOutcomeSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
} from './enums';

/** Neutral factual description: 10–4000 characters. */
export const IncidentDescriptionSchema = z.string().trim().min(10).max(4000);

export const IncidentEvidenceSchema = z.object({
  fileId: UuidSchema,
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  addedBy: UserRefSchema,
  addedAt: IsoDateTimeSchema,
  /** True for evidence attached to the original report. */
  original: z.boolean(),
});
export type IncidentEvidence = z.infer<typeof IncidentEvidenceSchema>;

export const IncidentEventSchema = z.object({
  id: UuidSchema,
  type: IncidentEventTypeSchema,
  fromStatus: IncidentStatusSchema.nullable(),
  toStatus: IncidentStatusSchema.nullable(),
  note: z.string().nullable(),
  /** Structured data for the event (e.g. severity change, assignee, escalation target). Never personal data. */
  data: z.record(z.unknown()),
  fileIds: z.array(UuidSchema),
  actor: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type IncidentEvent = z.infer<typeof IncidentEventSchema>;

export const IncidentSummarySchema = z.object({
  id: UuidSchema,
  /** INC-YYYY-NNNNNN */
  reference: z.string(),
  /** Current (triaged) category; `reportedCategory` keeps what the reporter chose. */
  category: IncidentCategorySchema,
  reportedCategory: IncidentCategorySchema,
  /** Severity set by the configured rules at intake (immutable); `severity` is the current, triaged value. */
  initialSeverity: IncidentSeveritySchema,
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  outcome: IncidentOutcomeSchema.nullable(),
  location: FieldLocationSchema,
  occurredAt: IsoDateTimeSchema,
  reportedAt: IsoDateTimeSchema,
  /** First 160 characters of the factual description. */
  descriptionPreview: z.string(),
  reporter: UserRefSchema,
  assignee: UserRefSchema.nullable(),
  escalatedTo: IncidentEscalationTargetSchema.nullable(),
  evidenceHold: z.boolean(),
  evidenceCount: z.number().int(),
  /** Minutes since reported (for queue age in the War Room). */
  ageMinutes: z.number().int(),
  submittedOffline: z.boolean(),
  updatedAt: IsoDateTimeSchema,
  /**
   * True when the incident's sensitivity hides its content from the caller
   * (CONFIDENTIAL needs triage or view_subject, HIGHLY_RESTRICTED needs view_subject):
   * description, notes and evidence are withheld.
   */
  contentRestricted: z.boolean().optional(),
});
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const INCIDENT_ALLOWED_ACTIONS = [
  'triage',
  'assign',
  'escalate',
  'add_note',
  'add_correction',
  'add_evidence',
  'evidence_hold',
  'refer',
  'record_subject',
  'view_subject',
  'resolve',
  'close',
  'reopen',
] as const;
export const IncidentAllowedActionSchema = z.enum(INCIDENT_ALLOWED_ACTIONS);
export type IncidentAllowedAction = z.infer<typeof IncidentAllowedActionSchema>;

export const IncidentDetailSchema = IncidentSummarySchema.extend({
  description: z.string(),
  locationDescription: z.string().nullable(),
  point: GeoPointSchema.nullable(),
  sensitivity: SensitivityLevelSchema,
  evidence: z.array(IncidentEvidenceSchema),
  events: z.array(IncidentEventSchema),
  /** True when a restricted subject record exists (the record itself needs view_subject). */
  hasSubject: z.boolean(),
  resolutionNote: z.string().nullable(),
  resolvedBy: UserRefSchema.nullable(),
  closureNote: z.string().nullable(),
  closedBy: UserRefSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  clientCreatedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int(),
  allowedActions: z.array(IncidentAllowedActionSchema),
});
export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;

export const IncidentQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingStationCode: z.string().trim().max(32).optional(),
  status: z.union([IncidentStatusSchema, z.array(IncidentStatusSchema)]).optional(),
  severity: z.union([IncidentSeveritySchema, z.array(IncidentSeveritySchema)]).optional(),
  category: IncidentCategorySchema.optional(),
  view: z.enum(['mine', 'assigned_to_me', 'open', 'unassigned']).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type IncidentQuery = z.infer<typeof IncidentQuerySchema>;

/** S17 intake. Also the payload of an `INCIDENT` sync item. */
export const CreateIncidentSchema = OfflineMetaSchema.extend({
  electionCycleId: UuidSchema,
  category: IncidentCategorySchema,
  occurredAt: IsoDateTimeSchema,
  location: FieldLocationInputSchema,
  locationDescription: z.string().trim().max(300).nullable().default(null),
  description: IncidentDescriptionSchema,
  point: GeoPointSchema.nullable().default(null),
  /** Files already stored with `POST /field/evidence` (purpose FIELD_EVIDENCE). */
  evidenceFileIds: z.array(UuidSchema).max(10).default([]),
  /** The reporter confirmed the privacy warning (no names unless needed; neutral wording). */
  privacyWarningAcknowledged: z.literal(true),
});
export type CreateIncident = z.infer<typeof CreateIncidentSchema>;

export const TriageIncidentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  severity: IncidentSeveritySchema,
  /** Reclassify (the reported category stays on record). */
  category: IncidentCategorySchema.optional(),
  sensitivity: SensitivityLevelSchema.optional(),
  note: z.string().trim().min(3).max(2000),
});
export type TriageIncident = z.infer<typeof TriageIncidentSchema>;

export const AssignIncidentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  assigneeId: UuidSchema,
  note: z.string().trim().max(2000).nullable().default(null),
});
export type AssignIncident = z.infer<typeof AssignIncidentSchema>;

export const EscalateIncidentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  target: IncidentEscalationTargetSchema,
  /** Optional reviewer for the escalated matter (must hold field.incidents.triage over the location). */
  assigneeId: UuidSchema.nullable().default(null),
  reason: ReasonSchema,
});
export type EscalateIncident = z.infer<typeof EscalateIncidentSchema>;

/** Notes and corrections are append-only; a correction never alters the original report. */
export const AddIncidentEventSchema = z.object({
  type: z.enum(['NOTE', 'CORRECTION', 'REFERRED', 'EVIDENCE_HOLD_PLACED', 'EVIDENCE_HOLD_RELEASED']),
  note: z.string().trim().min(3).max(4000),
  /** CORRECTION: what the reporter or reviewer now states (e.g. corrected time); free of personal data. */
  correction: z
    .object({
      occurredAt: IsoDateTimeSchema.optional(),
      pollingStationCode: z.string().trim().max(32).optional(),
      locationDescription: z.string().trim().max(300).optional(),
    })
    .optional(),
  /** REFERRED: body referred to (institution name, never a person). */
  referredTo: z.string().trim().max(200).optional(),
});
export type AddIncidentEvent = z.infer<typeof AddIncidentEventSchema>;

export const ResolveIncidentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  outcome: IncidentOutcomeSchema,
  resolutionNote: z.string().trim().min(10).max(4000),
  /** DUPLICATE: the incident this duplicates. */
  duplicateOfId: UuidSchema.nullable().default(null),
});
export type ResolveIncident = z.infer<typeof ResolveIncidentSchema>;

/** Closure needs a note and a reviewer other than the reporter and the resolver. */
export const CloseIncidentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  closureNote: z.string().trim().min(10).max(4000),
});
export type CloseIncident = z.infer<typeof CloseIncidentSchema>;

export const ReopenIncidentSchema = z.object({ expectedVersion: z.number().int().min(1), reason: ReasonSchema });
export type ReopenIncident = z.infer<typeof ReopenIncidentSchema>;

/**
 * Restricted subject record: who or what the incident concerns, when that is
 * necessary for referral. Stated as an allegation reported by a named source,
 * never as a finding. Needs `field.incidents.view_subject` to read or write.
 */
export const IncidentSubjectSchema = z.object({
  incidentId: UuidSchema,
  description: z.string(),
  recordedBy: UserRefSchema,
  recordedAt: IsoDateTimeSchema,
});
export type IncidentSubject = z.infer<typeof IncidentSubjectSchema>;

export const RecordIncidentSubjectSchema = z.object({
  description: z.string().trim().min(3).max(1000),
  reason: ReasonSchema,
});
export type RecordIncidentSubject = z.infer<typeof RecordIncidentSubjectSchema>;
