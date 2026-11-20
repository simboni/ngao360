/**
 * NGAO TALLY DTOs: submissions, capture, validation, verification,
 * discrepancies, snapshots and exports.
 */
import { z } from 'zod';
import {
  DiscrepancyLinkRoleSchema,
  DiscrepancySeveritySchema,
  DiscrepancyStatusSchema,
  DiscrepancyTypeSchema,
  ExportFormatSchema,
  FormLevelSchema,
  ImageQualitySchema,
  MalwareScanStatusSchema,
  OcrExtractionStatusSchema,
  OfficeTypeSchema,
  ResultValueChangeSourceSchema,
  ScopeTypeSchema,
  SubmissionSourceTypeSchema,
  SubmissionStatusSchema,
  SupervisorActionSchema,
  ValidationOutcomeSchema,
  VerificationDecisionSchema,
} from '../enums';
import {
  IsoDateTimeSchema,
  PaginationQuerySchema,
  ReasonSchema,
  UserRefSchema,
  UuidSchema,
} from './common';

/* ------------------------------- Stored files ------------------------------ */

export const StoredFileSchema = z.object({
  id: UuidSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  originalFilename: z.string(),
  pageCount: z.number().int().nullable(),
  malwareScanStatus: MalwareScanStatusSchema,
  uploadedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type StoredFile = z.infer<typeof StoredFileSchema>;

/** Allowed source-form upload types and size limit (blueprint 15.1 file security). */
export const ALLOWED_SOURCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;
export const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

/* ------------------------------- Submissions ------------------------------- */

export const DeclarationDetailsSchema = z.object({
  formSerial: z.string().max(64).optional(),
  declaredAtAsPrinted: z.string().max(64).optional(),
  presidingOfficerNameAsPrinted: z.string().max(200).optional(),
  /** Human-observed attributes only; software cannot establish authenticity. */
  stampObserved: z.boolean().optional(),
  presidingOfficerSignatureObserved: z.boolean().optional(),
  agentSignaturesObservedCount: z.number().int().min(0).optional(),
  sourceCopyNotes: z.string().max(2000).optional(),
});
export type DeclarationDetails = z.infer<typeof DeclarationDetailsSchema>;

/**
 * Metadata sent with POST /tally/submissions (multipart: `file` + `metadata` JSON
 * string matching this schema). Exactly one of pollingStationId / tallyCentreId
 * must be set, depending on the form level of the template.
 */
export const CreateSubmissionSchema = z
  .object({
    electionCycleId: UuidSchema,
    contestId: UuidSchema,
    formTemplateId: UuidSchema,
    pollingStationId: UuidSchema.nullable().default(null),
    tallyCentreId: UuidSchema.nullable().default(null),
    sourceType: SubmissionSourceTypeSchema,
    /** Client-generated UUID for offline retries; repeat requests return the original. */
    idempotencyKey: UuidSchema,
    declaration: DeclarationDetailsSchema.default({}),
    imageQuality: ImageQualitySchema.optional(),
    pageCount: z.number().int().min(1).max(20).optional(),
  })
  .refine((v) => (v.pollingStationId === null) !== (v.tallyCentreId === null), {
    message: 'Provide exactly one of pollingStationId or tallyCentreId',
    path: ['pollingStationId'],
  });
export type CreateSubmission = z.infer<typeof CreateSubmissionSchema>;

export const SubmissionSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  electionCycleId: UuidSchema,
  contestId: UuidSchema,
  contestName: z.string(),
  officeType: OfficeTypeSchema,
  formNumber: z.string(),
  formLevel: FormLevelSchema,
  formTemplateVersion: z.number().int(),
  pollingStationId: UuidSchema.nullable(),
  pollingStationCode: z.string().nullable(),
  pollingStationName: z.string().nullable(),
  tallyCentreId: UuidSchema.nullable(),
  tallyCentreName: z.string().nullable(),
  wardName: z.string().nullable(),
  constituencyName: z.string().nullable(),
  countyName: z.string().nullable(),
  status: SubmissionStatusSchema,
  sourceType: SubmissionSourceTypeSchema,
  isCanonical: z.boolean(),
  /** True when the file hash or station/form combination matches another submission. */
  duplicateFlag: z.boolean(),
  submitter: UserRefSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  openDiscrepancyCount: z.number().int(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

/** Coverage state of one expected polling station in the parallel tally. */
export const StationCoverageStatusSchema = z.enum(['MISSING', 'RECEIVED', 'VERIFIED', 'FLAGGED', 'EXCLUDED']);
export type StationCoverageStatus = z.infer<typeof StationCoverageStatusSchema>;

/**
 * Row of GET /tally/results/stations. MISSING stations have no submission, so the
 * submission-specific fields are nullable; they stay visible and are never zero-filled.
 */
export const StationCoverageRowSchema = SubmissionSummarySchema.extend({
  id: UuidSchema.nullable(),
  reference: z.string().nullable(),
  formNumber: z.string().nullable(),
  formLevel: FormLevelSchema.nullable(),
  formTemplateVersion: z.number().int().nullable(),
  status: SubmissionStatusSchema.nullable(),
  sourceType: SubmissionSourceTypeSchema.nullable(),
  isCanonical: z.boolean().nullable(),
  duplicateFlag: z.boolean().nullable(),
  submitter: UserRefSchema.nullable(),
  submittedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
  pollingStationId: UuidSchema,
  coverageStatus: StationCoverageStatusSchema,
  /** Votes by candidate id for VERIFIED (included) stations only; null otherwise, never zero-filled. */
  candidateVotes: z.record(z.number().int()).nullable(),
});
export type StationCoverageRow = z.infer<typeof StationCoverageRowSchema>;

export const SubmissionQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  contestId: UuidSchema.optional(),
  formNumber: z.string().optional(),
  status: z
    .union([SubmissionStatusSchema, z.array(SubmissionStatusSchema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  countyId: UuidSchema.optional(),
  constituencyId: UuidSchema.optional(),
  wardId: UuidSchema.optional(),
  pollingStationId: UuidSchema.optional(),
  sourceType: SubmissionSourceTypeSchema.optional(),
  duplicateOnly: z.coerce.boolean().optional(),
  /**
   * `mine` = submitted by current user; `awaiting_me` = verification queue
   * excluding own; `awaiting_supervisor` = verification outcomes with no
   * supervisor action yet, excluding records the caller took part in.
   */
  view: z.enum(['all', 'mine', 'awaiting_me', 'awaiting_supervisor']).default('all'),
});
export type SubmissionQuery = z.infer<typeof SubmissionQuerySchema>;

/* ------------------------------ Result values ------------------------------ */

export const ResultValueSchema = z.object({
  id: UuidSchema,
  fieldKey: z.string(),
  /** Printed label from the form template field schema. */
  label: z.string(),
  candidateReferenceId: UuidSchema.nullable(),
  candidateNameAsPublished: z.string().nullable(),
  numericValue: z.number().int().nullable(),
  textValue: z.string().nullable(),
  /** OCR draft value, never approved on its own. */
  ocrValue: z.string().nullable(),
  ocrConfidence: z.number().min(0).max(1).nullable(),
  confirmedBy: UserRefSchema.nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  changeVersion: z.number().int(),
  validationOutcome: ValidationOutcomeSchema.nullable(),
});
export type ResultValue = z.infer<typeof ResultValueSchema>;

export const ResultValueChangeSchema = z.object({
  id: UuidSchema,
  resultValueId: UuidSchema,
  fieldKey: z.string(),
  changeVersion: z.number().int(),
  oldNumericValue: z.number().int().nullable(),
  newNumericValue: z.number().int().nullable(),
  oldTextValue: z.string().nullable(),
  newTextValue: z.string().nullable(),
  source: ResultValueChangeSourceSchema,
  actor: UserRefSchema,
  reason: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ResultValueChange = z.infer<typeof ResultValueChangeSchema>;

export const CaptureValueInputSchema = z
  .object({
    fieldKey: z.string().min(1),
    candidateReferenceId: UuidSchema.nullable().default(null),
    numericValue: z.number().int().min(0).max(10_000_000).nullable().optional(),
    textValue: z.string().max(2000).nullable().optional(),
    /** Optimistic concurrency: the changeVersion the client last saw (0 for new). */
    expectedChangeVersion: z.number().int().min(0),
  })
  .refine((v) => v.numericValue !== undefined || v.textValue !== undefined, {
    message: 'Provide numericValue or textValue',
  });
export type CaptureValueInput = z.infer<typeof CaptureValueInputSchema>;

/** PUT /tally/submissions/:id/values. Reason is required whenever an existing value changes. */
export const SaveCaptureSchema = z.object({
  values: z.array(CaptureValueInputSchema).min(1).max(500),
  reason: ReasonSchema.optional(),
  declaration: DeclarationDetailsSchema.optional(),
  imageQuality: ImageQualitySchema.optional(),
});
export type SaveCapture = z.infer<typeof SaveCaptureSchema>;

/* ------------------------------- Validation -------------------------------- */

export const ValidationResultSchema = z.object({
  id: UuidSchema,
  runId: UuidSchema,
  ruleKey: z.string(),
  ruleVersion: z.number().int(),
  outcome: ValidationOutcomeSchema,
  /** Exact fields the rule examined (blueprint 17.2: identify exact field/rule). */
  fieldKeys: z.array(z.string()),
  message: z.string(),
  /** e.g. { expected: 1203, actual: 1199, operands: {...} } */
  details: z.record(z.unknown()),
  reference: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ValidationRunSchema = z.object({
  runId: UuidSchema,
  submissionId: UuidSchema,
  rulesVersion: z.number().int(),
  summary: z.object({ pass: z.number().int(), warning: z.number().int(), fail: z.number().int() }),
  results: z.array(ValidationResultSchema),
});
export type ValidationRun = z.infer<typeof ValidationRunSchema>;

/* ------------------------------ Verification ------------------------------- */

export const VerificationChecklistSchema = z.object({
  imageMatchesMetadata: z.boolean(),
  allValuesComparedToSource: z.boolean(),
  stationIdentityConfirmed: z.boolean(),
  stampObserved: z.boolean().nullable(),
  signatureObserved: z.boolean().nullable(),
  legible: z.boolean(),
});
export type VerificationChecklist = z.infer<typeof VerificationChecklistSchema>;

/**
 * POST /tally/submissions/:id/verifications. The verifier independently records
 * the values they read from the source; mismatches with captured values create a
 * REVIEWER_DISAGREEMENT discrepancy. The API rejects the request with
 * SEPARATION_OF_DUTIES when the caller submitted or captured the record.
 */
export const CreateVerificationSchema = z.object({
  decision: VerificationDecisionSchema,
  checklist: VerificationChecklistSchema,
  independentValues: z
    .array(
      z.object({
        fieldKey: z.string(),
        candidateReferenceId: UuidSchema.nullable().default(null),
        numericValue: z.number().int().min(0).nullable(),
      }),
    )
    .default([]),
  fieldComments: z.array(z.object({ fieldKey: z.string(), comment: z.string().max(1000) })).default([]),
  notes: z.string().max(4000).optional(),
});
export type CreateVerification = z.infer<typeof CreateVerificationSchema>;

export const VerificationSchema = z.object({
  id: UuidSchema,
  submissionId: UuidSchema,
  round: z.number().int(),
  reviewer: UserRefSchema,
  decision: VerificationDecisionSchema,
  checklist: VerificationChecklistSchema,
  mismatchedFieldKeys: z.array(z.string()),
  notes: z.string().nullable(),
  reviewedAt: IsoDateTimeSchema,
  supervisorAction: SupervisorActionSchema.nullable(),
  supervisor: UserRefSchema.nullable(),
  supervisorReason: z.string().nullable(),
  supervisorActionAt: IsoDateTimeSchema.nullable(),
});
export type Verification = z.infer<typeof VerificationSchema>;

/** POST /tally/verifications/:id/supervisor-action. Supervisor must not be submitter or verifier. */
export const SupervisorActionRequestSchema = z.object({
  action: SupervisorActionSchema,
  reason: ReasonSchema,
});
export type SupervisorActionRequest = z.infer<typeof SupervisorActionRequestSchema>;

/** Generic status transition request (return, exclude, archive, designate canonical). */
export const SubmissionTransitionSchema = z.object({
  to: SubmissionStatusSchema,
  reason: ReasonSchema,
});
export type SubmissionTransition = z.infer<typeof SubmissionTransitionSchema>;

export const DesignateCanonicalSchema = z.object({ reason: ReasonSchema });
export type DesignateCanonical = z.infer<typeof DesignateCanonicalSchema>;

/* ------------------------------ OCR extraction ----------------------------- */

export const OcrExtractionSchema = z.object({
  id: UuidSchema,
  submissionId: UuidSchema,
  status: OcrExtractionStatusSchema,
  engine: z.string().nullable(),
  engineVersion: z.string().nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
});
export type OcrExtraction = z.infer<typeof OcrExtractionSchema>;

/* ---------------------------- Submission detail ---------------------------- */

export const SubmissionDetailSchema = SubmissionSummarySchema.extend({
  formTemplateId: UuidSchema,
  registryVersionId: UuidSchema.nullable(),
  sourceFile: StoredFileSchema,
  declaration: DeclarationDetailsSchema,
  imageQuality: ImageQualitySchema.nullable(),
  pageCount: z.number().int().nullable(),
  duplicateOfId: UuidSchema.nullable(),
  relatedSubmissionIds: z.array(UuidSchema),
  values: z.array(ResultValueSchema),
  latestValidation: ValidationRunSchema.nullable(),
  verifications: z.array(VerificationSchema),
  ocr: OcrExtractionSchema.nullable(),
  /** Actions the current user may take, computed server-side (permissions + SoD + status). */
  allowedActions: z.array(
    z.enum([
      'CAPTURE',
      'SUBMIT_FOR_REVIEW',
      'RETURN',
      'VERIFY',
      'SUPERVISOR_ACTION',
      'FLAG_DISCREPANCY',
      'EXCLUDE',
      'DESIGNATE_CANONICAL',
      'DOWNLOAD_SOURCE',
    ]),
  ),
});
export type SubmissionDetail = z.infer<typeof SubmissionDetailSchema>;

/** GET /tally/submissions/:id/source-url → short-lived signed URL (audited). */
export const SignedUrlResponseSchema = z.object({
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
  sha256: z.string(),
});
export type SignedUrlResponse = z.infer<typeof SignedUrlResponseSchema>;

/* ------------------------------ Discrepancies ------------------------------ */

export const DiscrepancyCaseSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  electionCycleId: UuidSchema,
  contestId: UuidSchema.nullable(),
  varianceType: DiscrepancyTypeSchema,
  severity: DiscrepancySeveritySchema,
  status: DiscrepancyStatusSchema,
  title: z.string(),
  assignedTo: UserRefSchema.nullable(),
  openedBy: UserRefSchema,
  submissionIds: z.array(UuidSchema),
  ageHours: z.number(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type DiscrepancyCaseSummary = z.infer<typeof DiscrepancyCaseSummarySchema>;

export const DiscrepancyCaseActionSchema = z.object({
  id: UuidSchema,
  action: z.string(),
  note: z.string().nullable(),
  actor: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type DiscrepancyCaseAction = z.infer<typeof DiscrepancyCaseActionSchema>;

export const DiscrepancyCaseDetailSchema = DiscrepancyCaseSummarySchema.extend({
  description: z.string(),
  /** Field-level comparison, e.g. [{ fieldKey, sourceA, sourceB, difference }]. */
  details: z.record(z.unknown()),
  links: z.array(
    z.object({ submissionId: UuidSchema, role: DiscrepancyLinkRoleSchema, reference: z.string() }),
  ),
  requiredHandling: z.string(),
  resolution: z.string().nullable(),
  resolvedBy: UserRefSchema.nullable(),
  closureApprover: UserRefSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  actions: z.array(DiscrepancyCaseActionSchema),
});
export type DiscrepancyCaseDetail = z.infer<typeof DiscrepancyCaseDetailSchema>;

export const DiscrepancyQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  contestId: UuidSchema.optional(),
  status: DiscrepancyStatusSchema.optional(),
  varianceType: DiscrepancyTypeSchema.optional(),
  severity: DiscrepancySeveritySchema.optional(),
  assignedToMe: z.coerce.boolean().optional(),
  submissionId: UuidSchema.optional(),
});
export type DiscrepancyQuery = z.infer<typeof DiscrepancyQuerySchema>;

export const CreateDiscrepancySchema = z.object({
  varianceType: DiscrepancyTypeSchema,
  severity: DiscrepancySeveritySchema.default('MEDIUM'),
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().min(3).max(4000),
  links: z
    .array(z.object({ submissionId: UuidSchema, role: DiscrepancyLinkRoleSchema }))
    .min(1)
    .max(20),
  details: z.record(z.unknown()).default({}),
});
export type CreateDiscrepancy = z.infer<typeof CreateDiscrepancySchema>;

export const AssignDiscrepancySchema = z.object({
  assignedToId: UuidSchema.nullable(),
  note: z.string().max(2000).optional(),
});
export type AssignDiscrepancy = z.infer<typeof AssignDiscrepancySchema>;

export const DiscrepancyCommentSchema = z.object({ note: z.string().trim().min(1).max(4000) });
export type DiscrepancyComment = z.infer<typeof DiscrepancyCommentSchema>;

export const DiscrepancyTransitionSchema = z.object({
  to: DiscrepancyStatusSchema,
  reason: ReasonSchema,
});
export type DiscrepancyTransition = z.infer<typeof DiscrepancyTransitionSchema>;

/** Resolution never overwrites source records; it records the decision and next actions. */
export const ResolveDiscrepancySchema = z.object({
  resolution: z.string().trim().min(10).max(4000),
  canonicalSubmissionId: UuidSchema.optional(),
  excludeSubmissionIds: z.array(UuidSchema).default([]),
});
export type ResolveDiscrepancy = z.infer<typeof ResolveDiscrepancySchema>;

/** Closure requires an approver distinct from the resolver. */
export const CloseDiscrepancySchema = z.object({ closureNote: ReasonSchema });
export type CloseDiscrepancy = z.infer<typeof CloseDiscrepancySchema>;

/* --------------------------- Aggregates & snapshots ------------------------ */

export const CoverageSchema = z.object({
  /** Denominator from the approved station registry version. */
  expectedStations: z.number().int(),
  received: z.number().int(),
  transcribed: z.number().int(),
  awaitingReview: z.number().int(),
  verified: z.number().int(),
  flagged: z.number().int(),
  excluded: z.number().int(),
  /** Stations with no submission; never shown as zero votes. */
  missing: z.number().int(),
  verifiedPercent: z.number(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const CandidateTotalSchema = z.object({
  candidateReferenceId: UuidSchema,
  candidateNameAsPublished: z.string(),
  partyLabel: z.string().nullable(),
  ballotOrder: z.number().int(),
  verifiedVotes: z.number().int(),
  /** Share of verified valid votes only. */
  shareOfVerifiedValidVotes: z.number(),
});
export type CandidateTotal = z.infer<typeof CandidateTotalSchema>;

export const AggregateQuerySchema = z.object({
  electionCycleId: UuidSchema,
  contestId: UuidSchema,
  geographyScopeType: ScopeTypeSchema.default('ORGANISATION'),
  geographicUnitId: UuidSchema.optional(),
});
export type AggregateQuery = z.infer<typeof AggregateQuerySchema>;

/** GET /tally/results/live: computed on demand, not persisted. */
export const LiveAggregateSchema = z.object({
  electionCycleId: UuidSchema,
  contestId: UuidSchema,
  geographyScopeType: ScopeTypeSchema,
  geographicUnitId: UuidSchema.nullable(),
  calculationVersion: z.string(),
  computedAt: IsoDateTimeSchema,
  coverage: CoverageSchema,
  totalVerifiedValidVotes: z.number().int(),
  rejectedBallots: z.number().int(),
  candidates: z.array(CandidateTotalSchema),
  includedStationCount: z.number().int(),
  openDiscrepancyCount: z.number().int(),
  latestSnapshotId: UuidSchema.nullable(),
  disclaimer: z.string(),
});
export type LiveAggregate = z.infer<typeof LiveAggregateSchema>;

export const GeographyBreakdownRowSchema = z.object({
  geographicUnitId: UuidSchema.nullable(),
  pollingStationId: UuidSchema.nullable(),
  code: z.string(),
  name: z.string(),
  coverage: CoverageSchema,
  candidates: z.array(z.object({ candidateReferenceId: UuidSchema, verifiedVotes: z.number().int() })),
});
export type GeographyBreakdownRow = z.infer<typeof GeographyBreakdownRowSchema>;

export const GeographyBreakdownSchema = z.object({
  parentUnitId: UuidSchema.nullable(),
  rows: z.array(GeographyBreakdownRowSchema),
  disclaimer: z.string(),
});
export type GeographyBreakdown = z.infer<typeof GeographyBreakdownSchema>;

export const CreateSnapshotSchema = AggregateQuerySchema.extend({
  note: z.string().max(2000).optional(),
});
export type CreateSnapshot = z.infer<typeof CreateSnapshotSchema>;

export const TallySnapshotSchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  electionCycleId: UuidSchema,
  contestId: UuidSchema,
  geographyScopeType: ScopeTypeSchema,
  geographicUnitId: UuidSchema.nullable(),
  calculationVersion: z.string(),
  includedSubmissionIds: z.array(UuidSchema),
  totals: z.object({
    totalVerifiedValidVotes: z.number().int(),
    rejectedBallots: z.number().int(),
    candidates: z.array(CandidateTotalSchema),
  }),
  coverage: CoverageSchema,
  registryVersionId: UuidSchema.nullable(),
  /** SHA-256 over the canonical snapshot content. */
  contentHash: z.string(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  releasedAt: IsoDateTimeSchema.nullable(),
  releasedBy: UserRefSchema.nullable(),
  disclaimer: z.string(),
});
export type TallySnapshot = z.infer<typeof TallySnapshotSchema>;

export const SnapshotQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  contestId: UuidSchema.optional(),
  releasedOnly: z.coerce.boolean().optional(),
});
export type SnapshotQuery = z.infer<typeof SnapshotQuerySchema>;

export const ReleaseSnapshotSchema = z.object({ reason: ReasonSchema });
export type ReleaseSnapshot = z.infer<typeof ReleaseSnapshotSchema>;

/* --------------------------------- Exports --------------------------------- */

export const CreateExportSchema = z.object({
  snapshotId: UuidSchema,
  format: ExportFormatSchema,
  includeStationRows: z.boolean().default(true),
});
export type CreateExport = z.infer<typeof CreateExportSchema>;

export const TallyExportSchema = z.object({
  id: UuidSchema,
  snapshotId: UuidSchema,
  format: ExportFormatSchema,
  fileId: UuidSchema,
  sha256: z.string(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type TallyExport = z.infer<typeof TallyExportSchema>;
