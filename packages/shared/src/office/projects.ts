/**
 * S26 Project register and S27 Project detail DTOs (blueprint 9.3). API §12
 * in docs/API_CONTRACT.md.
 *
 * Accountability controls built into the contract:
 * - every project names its responsible institution (the body legally
 *   responsible) and the source of the commitment; the office is never shown
 *   as controlling a project another body is responsible for;
 * - status distinguishes commitment / approved / reported complete / verified
 *   complete (`PROJECT_STAGE_KIND`);
 * - completion is verified only with verified non-photographic evidence
 *   (`completionEvidenceSufficient`): a photograph alone is not proof.
 */
import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import {
  ExpectedVersionSchema,
  InstitutionRefSchema,
  MoneySchema,
  OfficeFileSchema,
  OfficeLocationInputSchema,
  OfficeLocationSchema,
} from './common';
import {
  CommitmentSourceSchema,
  FundingSourceSchema,
  MilestoneStatusSchema,
  ProjectCategorySchema,
  ProjectEvidenceTypeSchema,
  ProjectStageKindSchema,
  ProjectStatusSchema,
  VerificationStatusSchema,
} from './enums';

/* ------------------------------ Public fields ------------------------------ */

/**
 * Optional fields a public-information editor may approve for the public view.
 * The mandatory fields (`PROJECT_PUBLIC_MANDATORY_FIELDS`) are always shown
 * on a published project and cannot be switched off.
 */
export const PROJECT_PUBLIC_FIELD_KEYS = [
  'description',
  'implementingAgency',
  'projectOwner',
  'fundingSource',
  'approvedAllocation',
  'contractAmount',
  'expenditure',
  'schedule',
  'milestones',
  'evidence',
  'mapLocation',
] as const;
export type ProjectPublicField = (typeof PROJECT_PUBLIC_FIELD_KEYS)[number];
export const ProjectPublicFieldSchema = z.enum(PROJECT_PUBLIC_FIELD_KEYS);

export const PROJECT_PUBLIC_MANDATORY_FIELDS = [
  'name',
  'category',
  'location',
  'status',
  'stageKind',
  'responsibleInstitution',
  'commitmentSource',
  'completionVerification',
] as const;

/** Shown on every public project page and export. */
export const PROJECT_PUBLIC_DISCLAIMER =
  'This page names the institution legally responsible for each project and the source of the commitment. ' +
  'A commitment is not an approved or funded project. Completion is shown as verified only after an independent ' +
  'check of documentary evidence; a photograph alone is not proof of completion.';

/* -------------------------------- Milestones ------------------------------- */

export const ProjectMilestoneSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  sequence: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  plannedDate: IsoDateSchema.nullable(),
  actualDate: IsoDateSchema.nullable(),
  status: MilestoneStatusSchema,
  verificationStatus: VerificationStatusSchema,
  verifiedBy: UserRefSchema.nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
  verificationNote: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type ProjectMilestone = z.infer<typeof ProjectMilestoneSchema>;

export const CreateProjectMilestoneSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  /** Defaults to the next sequence number. */
  sequence: z.number().int().min(1).max(999).optional(),
  plannedDate: IsoDateSchema.optional(),
});
export type CreateProjectMilestone = z.infer<typeof CreateProjectMilestoneSchema>;

/** Changing status or actualDate resets verificationStatus to UNVERIFIED. */
export const UpdateProjectMilestoneSchema = CreateProjectMilestoneSchema.partial().extend({
  status: MilestoneStatusSchema.optional(),
  actualDate: IsoDateSchema.nullable().optional(),
});
export type UpdateProjectMilestone = z.infer<typeof UpdateProjectMilestoneSchema>;

export const ProjectMilestoneParamSchema = z.object({ id: UuidSchema, milestoneId: UuidSchema });
export type ProjectMilestoneParam = z.infer<typeof ProjectMilestoneParamSchema>;

/* --------------------------------- Evidence -------------------------------- */

export const ProjectEvidenceSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  milestoneId: UuidSchema.nullable(),
  type: ProjectEvidenceTypeSchema,
  description: z.string(),
  /** Date the photo was taken or the document issued (source time, not upload time). */
  capturedOn: IsoDateSchema.nullable(),
  /** Who issued the document or took the photo, e.g. "County Public Works inspectorate". */
  sourceDescription: z.string().nullable(),
  file: OfficeFileSchema,
  uploadedBy: UserRefSchema,
  uploadedAt: IsoDateTimeSchema,
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  verificationStatus: VerificationStatusSchema,
  verifiedBy: UserRefSchema.nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
  verificationNote: z.string().nullable(),
  /** Approved for the public view (needs `office.projects.publish`). */
  isPublic: z.boolean(),
});
export type ProjectEvidence = z.infer<typeof ProjectEvidenceSchema>;

/** Multipart field `metadata` (JSON) sent with the `file` part. Location is optional and only when appropriate. */
export const CreateProjectEvidenceSchema = z
  .object({
    type: ProjectEvidenceTypeSchema,
    milestoneId: UuidSchema.optional(),
    description: z.string().trim().min(3).max(2000),
    capturedOn: IsoDateSchema.optional(),
    sourceDescription: z.string().trim().max(300).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'Give both latitude and longitude, or neither',
    path: ['longitude'],
  });
export type CreateProjectEvidence = z.infer<typeof CreateProjectEvidenceSchema>;

/** The verifier must not be the uploader (403 SEPARATION_OF_DUTIES). */
export const VerifyRecordSchema = z.object({
  status: z.enum(['VERIFIED', 'DISPUTED']),
  note: z.string().trim().min(3).max(4000),
});
export type VerifyRecord = z.infer<typeof VerifyRecordSchema>;

export const ProjectEvidenceParamSchema = z.object({ id: UuidSchema, evidenceId: UuidSchema });
export type ProjectEvidenceParam = z.infer<typeof ProjectEvidenceParamSchema>;

/* --------------------------------- Projects -------------------------------- */

export const PROJECT_ACTIONS = [
  'edit',
  'transition',
  'add_milestone',
  'add_evidence',
  'verify_evidence',
  'verify_expenditure',
  'verify_completion',
  'publish',
] as const;
export const ProjectActionSchema = z.enum(PROJECT_ACTIONS);

export const ProjectSummarySchema = z.object({
  id: UuidSchema,
  /** e.g. "PRJ-2026-000012". */
  reference: z.string(),
  name: z.string(),
  category: ProjectCategorySchema,
  status: ProjectStatusSchema,
  stageKind: ProjectStageKindSchema,
  location: OfficeLocationSchema,
  responsibleInstitution: InstitutionRefSchema,
  implementingAgency: InstitutionRefSchema.nullable(),
  commitmentSource: CommitmentSourceSchema,
  fundingSource: FundingSourceSchema,
  currency: z.string(),
  approvedAllocation: MoneySchema.nullable(),
  expenditureReported: MoneySchema.nullable(),
  expenditureVerificationStatus: VerificationStatusSchema,
  expectedCompletionDate: IsoDateSchema.nullable(),
  currentMilestone: z.object({ id: UuidSchema, title: z.string() }).nullable(),
  evidenceCount: z.number().int(),
  verifiedEvidenceCount: z.number().int(),
  isPublic: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  description: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** Named public official or office accountable for delivery, as published by the responsible body. */
  ownerName: z.string().nullable(),
  /** Internal officer tracking the record in this workspace. */
  trackingOfficer: UserRefSchema.nullable(),
  approvalAuthority: z.string().nullable(),
  commitmentSourceDetail: z.string().nullable(),
  fundingSourceDetail: z.string().nullable(),
  allocationSource: z.string().nullable(),
  contractAmount: MoneySchema.nullable(),
  /** Whether the contract amount is a matter of public record (only then can it be published). */
  contractAmountIsPublic: z.boolean(),
  expenditureSource: z.string().nullable(),
  expenditureAsOf: IsoDateSchema.nullable(),
  expenditureVerifiedBy: UserRefSchema.nullable(),
  expenditureVerifiedAt: IsoDateTimeSchema.nullable(),
  startDate: IsoDateSchema.nullable(),
  actualCompletionDate: IsoDateSchema.nullable(),
  delayReason: z.string().nullable(),
  completion: z.object({
    reportedBy: UserRefSchema.nullable(),
    reportedAt: IsoDateTimeSchema.nullable(),
    verifiedBy: UserRefSchema.nullable(),
    verifiedAt: IsoDateTimeSchema.nullable(),
    verificationNote: z.string().nullable(),
  }),
  publication: z.object({
    isPublic: z.boolean(),
    publicFields: z.array(ProjectPublicFieldSchema),
    publicSummary: z.string().nullable(),
    publishedBy: UserRefSchema.nullable(),
    publishedAt: IsoDateTimeSchema.nullable(),
  }),
  milestones: z.array(ProjectMilestoneSchema),
  evidence: z.array(ProjectEvidenceSchema),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  allowedActions: z.array(ProjectActionSchema),
  version: z.number().int(),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

const ProjectBaseSchema = OfficeLocationInputSchema.extend({
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().max(8000).optional(),
  category: ProjectCategorySchema,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /** Required: the body legally responsible for the project. */
  responsibleInstitutionId: UuidSchema,
  implementingAgencyId: UuidSchema.optional(),
  ownerName: z.string().trim().max(200).optional(),
  trackingOfficerId: UuidSchema.optional(),
  approvalAuthority: z.string().trim().max(200).optional(),
  commitmentSource: CommitmentSourceSchema,
  commitmentSourceDetail: z.string().trim().max(1000).optional(),
  fundingSource: FundingSourceSchema.default('NOT_YET_IDENTIFIED'),
  fundingSourceDetail: z.string().trim().max(1000).optional(),
  currency: z.string().length(3).default('KES'),
  approvedAllocation: MoneySchema.optional(),
  allocationSource: z.string().trim().max(500).optional(),
  contractAmount: MoneySchema.optional(),
  contractAmountIsPublic: z.boolean().default(false),
  /** Changing the reported expenditure resets its verification to UNVERIFIED. */
  expenditureReported: MoneySchema.optional(),
  expenditureSource: z.string().trim().max(500).optional(),
  expenditureAsOf: IsoDateSchema.optional(),
  startDate: IsoDateSchema.optional(),
  expectedCompletionDate: IsoDateSchema.optional(),
});

/** Created as PROPOSED, or COMMITTED when the commitment source is a pledge or statement. */
export const CreateProjectSchema = ProjectBaseSchema.extend({
  initialStatus: z.enum(['PROPOSED', 'COMMITTED', 'APPROVED']).default('PROPOSED'),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = ProjectBaseSchema.partial().extend({
  delayReason: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersionSchema,
  reason: ReasonSchema.optional(),
});
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

/**
 * Any allowed transition except VERIFIED_COMPLETED (use verify-completion).
 * DELAYED needs `delayReason`; COMPLETED needs `actualCompletionDate` and
 * records the reporter; CANCELLED and withdrawing a verification need `reason`.
 */
export const ProjectTransitionSchema = z.object({
  to: ProjectStatusSchema.exclude(['VERIFIED_COMPLETED']),
  reason: ReasonSchema,
  delayReason: z.string().trim().max(2000).optional(),
  actualCompletionDate: IsoDateSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type ProjectTransition = z.infer<typeof ProjectTransitionSchema>;

/**
 * COMPLETED → VERIFIED_COMPLETED. Needs `office.projects.verify` (reauth), a
 * verifier other than the completion reporter and other than the uploader of
 * every cited evidence item, and cited evidence that satisfies
 * `completionEvidenceSufficient`.
 */
export const VerifyProjectCompletionSchema = z.object({
  evidenceIds: z.array(UuidSchema).min(1),
  note: z.string().trim().min(10).max(4000),
  expectedVersion: ExpectedVersionSchema,
});
export type VerifyProjectCompletion = z.infer<typeof VerifyProjectCompletionSchema>;

export const VerifyProjectExpenditureSchema = VerifyRecordSchema.extend({
  expectedVersion: ExpectedVersionSchema,
});
export type VerifyProjectExpenditure = z.infer<typeof VerifyProjectExpenditureSchema>;

/**
 * Publication settings. Publishing (isPublic true) needs `office.projects.publish`
 * (reauth). `contractAmount` can be approved only when contractAmountIsPublic.
 * `publicEvidenceIds` must be VERIFIED evidence of the project.
 */
export const UpdateProjectPublicationSchema = z.object({
  isPublic: z.boolean(),
  publicFields: z.array(ProjectPublicFieldSchema).default([]),
  publicSummary: z.string().trim().max(4000).optional(),
  publicEvidenceIds: z.array(UuidSchema).default([]),
  reason: ReasonSchema,
  expectedVersion: ExpectedVersionSchema,
});
export type UpdateProjectPublication = z.infer<typeof UpdateProjectPublicationSchema>;

export const ProjectQuerySchema = PaginationQuerySchema.extend({
  status: ProjectStatusSchema.optional(),
  stageKind: ProjectStageKindSchema.optional(),
  category: ProjectCategorySchema.optional(),
  geographicUnitId: UuidSchema.optional(),
  responsibleInstitutionId: UuidSchema.optional(),
  verification: VerificationStatusSchema.optional(),
  isPublic: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ProjectQuery = z.infer<typeof ProjectQuerySchema>;
