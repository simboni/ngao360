/**
 * Agent registry DTOs (blueprint 6.3, S13; API contract §16).
 *
 * Personal data is minimised and split in two:
 * - `AgentSummary` / `AgentDetail` hold names, home ward, languages, status and
 *   MASKED contact and ID values only (`phoneMasked`, `nationalIdMasked`);
 * - full values (national ID number, phone, M-Pesa number, next of kin) live in
 *   a separate table and are returned only by `POST /field/agents/:id/reveal`,
 *   which needs `field.agents.reveal_sensitive`, a reason and re-authentication,
 *   and writes an audit event naming the fields revealed.
 * No list, export, notification or log line carries unmasked values.
 */
import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../schemas/common';
import { KenyanMsisdnSchema, NationalIdNumberSchema, UnitRefSchema } from './common';
import {
  AccreditationStatusSchema,
  AgentAvailabilitySchema,
  AgentGenderSchema,
  AgentStatusSchema,
  DeploymentRoleSchema,
  DeploymentShiftSchema,
  DeploymentStatusSchema,
  TrainingStatusSchema,
} from './enums';

const Name = z.string().trim().min(1).max(80);
/** ISO 639-1/-3 code or a short language name, e.g. "sw", "en", "Lubukusu". */
const Language = z.string().trim().min(2).max(40);

/* --------------------------------- Agent ---------------------------------- */

export const AgentAccreditationSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  status: AccreditationStatusSchema,
  /** Reference issued by the accrediting body, where lawfully held. */
  accreditationReference: z.string().nullable(),
  evidenceFileId: UuidSchema.nullable(),
  submittedAt: IsoDateTimeSchema.nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
  expiresOn: IsoDateSchema.nullable(),
  notes: z.string().nullable(),
  updatedBy: UserRefSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type AgentAccreditation = z.infer<typeof AgentAccreditationSchema>;

export const AgentTrainingSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema.nullable(),
  /** Module or session name, e.g. "Polling-day procedures". */
  title: z.string(),
  status: TrainingStatusSchema,
  scheduledOn: IsoDateSchema.nullable(),
  materialsIssued: z.boolean(),
  attendedAt: IsoDateTimeSchema.nullable(),
  /** 0–100 when an assessment was given. */
  assessmentScore: z.number().int().min(0).max(100).nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  refresherDueOn: IsoDateSchema.nullable(),
  notes: z.string().nullable(),
  recordedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AgentTraining = z.infer<typeof AgentTrainingSchema>;

export const AgentSummarySchema = z.object({
  id: UuidSchema,
  /** AGT-NNNNNN */
  reference: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  displayName: z.string(),
  status: AgentStatusSchema,
  availability: AgentAvailabilitySchema,
  homeWard: UnitRefSchema.nullable(),
  homeConstituency: UnitRefSchema.nullable(),
  languages: z.array(z.string()),
  /** Masked by default, e.g. "+254 ••• ••• 678". */
  phoneMasked: z.string().nullable(),
  /** Accreditation status for the requested (or field-module) cycle. */
  accreditationStatus: AccreditationStatusSchema.nullable(),
  /** Completed trainings / recorded trainings. */
  trainingCompleted: z.number().int(),
  trainingTotal: z.number().int(),
  /** Number of active deployments (ASSIGNED, CONFIRMED or CHECKED_IN) in that cycle. */
  activeDeployments: z.number().int(),
  /** True when the agent has a sign-in account (mobile PWA). */
  hasUserAccount: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentDeploymentRefSchema = z.object({
  id: UuidSchema,
  electionCycleId: UuidSchema,
  pollingStationCode: z.string(),
  pollingStationName: z.string().nullable(),
  role: DeploymentRoleSchema,
  shift: DeploymentShiftSchema,
  status: DeploymentStatusSchema,
});
export type AgentDeploymentRef = z.infer<typeof AgentDeploymentRefSchema>;

export const AgentStatusEventSchema = z.object({
  id: UuidSchema,
  fromStatus: AgentStatusSchema.nullable(),
  toStatus: AgentStatusSchema,
  reason: z.string().nullable(),
  actor: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type AgentStatusEvent = z.infer<typeof AgentStatusEventSchema>;

export const AGENT_ALLOWED_ACTIONS = [
  'edit',
  'change_status',
  'record_training',
  'record_accreditation',
  'reveal_sensitive',
  'edit_sensitive',
  'link_user',
] as const;
export const AgentAllowedActionSchema = z.enum(AGENT_ALLOWED_ACTIONS);

export const AgentDetailSchema = AgentSummarySchema.extend({
  otherNames: z.string().nullable(),
  gender: AgentGenderSchema.nullable(),
  homeCounty: UnitRefSchema.nullable(),
  /** Masked by default, e.g. "••••• 678". */
  nationalIdMasked: z.string().nullable(),
  hasMpesaNumber: z.boolean(),
  hasNextOfKin: z.boolean(),
  notes: z.string().nullable(),
  /** Privacy notice version read to / accepted by the agent and when. */
  privacyNoticeVersion: z.string().nullable(),
  privacyNoticeAcknowledgedAt: IsoDateTimeSchema.nullable(),
  userId: UuidSchema.nullable(),
  accreditations: z.array(AgentAccreditationSchema),
  trainings: z.array(AgentTrainingSchema),
  deployments: z.array(AgentDeploymentRefSchema),
  statusHistory: z.array(AgentStatusEventSchema),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  version: z.number().int(),
  allowedActions: z.array(AgentAllowedActionSchema),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

export const AgentQuerySchema = PaginationQuerySchema.extend({
  status: z.union([AgentStatusSchema, z.array(AgentStatusSchema)]).optional(),
  availability: AgentAvailabilitySchema.optional(),
  accreditationStatus: AccreditationStatusSchema.optional(),
  electionCycleId: UuidSchema.optional(),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  /** Agents with no active deployment in the cycle. */
  undeployedOnly: QueryBooleanSchema.optional(),
  language: z.string().trim().max(40).optional(),
});
export type AgentQuery = z.infer<typeof AgentQuerySchema>;

/** Sensitive values on create/update (all optional; only what the role needs). */
export const AgentSensitiveInputSchema = z.object({
  nationalIdNumber: NationalIdNumberSchema.nullable().optional(),
  phone: KenyanMsisdnSchema.nullable().optional(),
  /** Payment number for agent facilitation, when it differs from `phone`. */
  mpesaNumber: KenyanMsisdnSchema.nullable().optional(),
  nextOfKinName: z.string().trim().min(2).max(120).nullable().optional(),
  nextOfKinPhone: KenyanMsisdnSchema.nullable().optional(),
  nextOfKinRelationship: z.string().trim().min(2).max(60).nullable().optional(),
});
export type AgentSensitiveInput = z.infer<typeof AgentSensitiveInputSchema>;

export const CreateAgentSchema = z.object({
  givenName: Name,
  familyName: Name,
  otherNames: z.string().trim().max(120).nullable().default(null),
  gender: AgentGenderSchema.nullable().default(null),
  /** Ward unit (any cycle's geography). */
  homeWardId: UuidSchema,
  languages: z.array(Language).max(8).default([]),
  availability: AgentAvailabilitySchema.default('AVAILABLE'),
  notes: z.string().trim().max(2000).nullable().default(null),
  /** The agent was shown the privacy notice (version from FieldModuleConfig); required. */
  privacyNoticeAcknowledged: z.literal(true),
  sensitive: AgentSensitiveInputSchema.default({}),
});
export type CreateAgent = z.infer<typeof CreateAgentSchema>;

export const UpdateAgentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  givenName: Name.optional(),
  familyName: Name.optional(),
  otherNames: z.string().trim().max(120).nullable().optional(),
  gender: AgentGenderSchema.nullable().optional(),
  homeWardId: UuidSchema.optional(),
  languages: z.array(Language).max(8).optional(),
  availability: AgentAvailabilitySchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;

export const AgentStatusChangeSchema = z.object({
  expectedVersion: z.number().int().min(1),
  to: AgentStatusSchema,
  reason: ReasonSchema,
});
export type AgentStatusChange = z.infer<typeof AgentStatusChangeSchema>;

/** PUT /field/agents/:id/sensitive — needs reveal permission + reauth; values replace. */
export const UpdateAgentSensitiveSchema = AgentSensitiveInputSchema.extend({ reason: ReasonSchema });
export type UpdateAgentSensitive = z.infer<typeof UpdateAgentSensitiveSchema>;

export const AGENT_SENSITIVE_FIELDS = ['nationalIdNumber', 'phone', 'mpesaNumber', 'nextOfKin'] as const;
export const AgentSensitiveFieldSchema = z.enum(AGENT_SENSITIVE_FIELDS);
export type AgentSensitiveField = z.infer<typeof AgentSensitiveFieldSchema>;

/** POST /field/agents/:id/reveal — ask for the fields actually needed. */
export const RevealAgentSensitiveSchema = z.object({
  fields: z.array(AgentSensitiveFieldSchema).min(1),
  reason: ReasonSchema,
});
export type RevealAgentSensitive = z.infer<typeof RevealAgentSensitiveSchema>;

export const AgentSensitiveRevealSchema = z.object({
  agentId: UuidSchema,
  nationalIdNumber: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  mpesaNumber: z.string().nullable().optional(),
  nextOfKin: z
    .object({ name: z.string().nullable(), phone: z.string().nullable(), relationship: z.string().nullable() })
    .nullable()
    .optional(),
  /** The UI hides the values again after this time. */
  revealedAt: IsoDateTimeSchema,
});
export type AgentSensitiveReveal = z.infer<typeof AgentSensitiveRevealSchema>;

export const RecordTrainingSchema = z.object({
  electionCycleId: UuidSchema.nullable().default(null),
  title: z.string().trim().min(3).max(160),
  status: TrainingStatusSchema,
  scheduledOn: IsoDateSchema.nullable().default(null),
  materialsIssued: z.boolean().default(false),
  attendedAt: IsoDateTimeSchema.nullable().default(null),
  assessmentScore: z.number().int().min(0).max(100).nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  refresherDueOn: IsoDateSchema.nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type RecordTraining = z.infer<typeof RecordTrainingSchema>;

export const UpdateTrainingSchema = RecordTrainingSchema.partial().extend({ reason: ReasonSchema });
export type UpdateTraining = z.infer<typeof UpdateTrainingSchema>;

export const SetAccreditationSchema = z.object({
  electionCycleId: UuidSchema,
  status: AccreditationStatusSchema,
  accreditationReference: z.string().trim().max(80).nullable().default(null),
  submittedAt: IsoDateTimeSchema.nullable().default(null),
  decidedAt: IsoDateTimeSchema.nullable().default(null),
  expiresOn: IsoDateSchema.nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  reason: ReasonSchema,
});
export type SetAccreditation = z.infer<typeof SetAccreditationSchema>;

/** POST /field/agents/:id/user — link an existing user account (mobile sign-in). */
export const LinkAgentUserSchema = z.object({ userId: UuidSchema.nullable(), reason: ReasonSchema });
export type LinkAgentUser = z.infer<typeof LinkAgentUserSchema>;
