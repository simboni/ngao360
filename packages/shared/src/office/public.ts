/**
 * Public portal DTOs (S24 submit, tracking, public project pages). API §13 in
 * docs/API_CONTRACT.md. These endpoints need no account. They never return
 * internal notes, staff names, requester contact details or other people's data.
 */
import { z } from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { MoneySchema, PhoneSchema } from './common';
import {
  CaseCategorySchema,
  CitizenFeedbackResponseSchema,
  ContactPreferenceSchema,
  ProjectCategorySchema,
  ProjectStageKindSchema,
  ProjectStatusSchema,
  PublicCaseStageSchema,
} from './enums';
import { PrivacyNoticeSchema } from './privacy';

/** Name of the honeypot field. Real users never see or fill it. */
export const PUBLIC_HONEYPOT_FIELD = 'website';

/** Anti-abuse fields carried by every public write. */
const AbuseFieldsSchema = z.object({
  /** Honeypot: must be empty or absent. A filled value returns a generic 400 `ABUSE_CHECK_FAILED`. */
  website: z.string().max(500).optional(),
  /** Captcha token when the tenant configures a provider (hook; 'none' by default). */
  captchaToken: z.string().max(4000).optional(),
});

export const PublicTenantParamSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
});
export type PublicTenantParam = z.infer<typeof PublicTenantParamSchema>;

export const PublicProjectParamSchema = PublicTenantParamSchema.extend({ id: UuidSchema });
export type PublicProjectParam = z.infer<typeof PublicProjectParamSchema>;

export const PublicEvidenceParamSchema = PublicProjectParamSchema.extend({ evidenceId: UuidSchema });
export type PublicEvidenceParam = z.infer<typeof PublicEvidenceParamSchema>;

/* ------------------------------- Portal info ------------------------------- */

export const PublicPortalInfoSchema = z.object({
  tenantSlug: z.string(),
  displayName: z.string(),
  privacyNotice: PrivacyNoticeSchema,
  categories: z.array(z.object({ key: CaseCategorySchema, label: z.string() })),
  constituencies: z.array(z.object({ id: UuidSchema, name: z.string() })),
  wards: z.array(z.object({ id: UuidSchema, name: z.string(), constituencyId: UuidSchema })),
  captcha: z.object({ provider: z.enum(['none', 'turnstile', 'hcaptcha']), siteKey: z.string().nullable() }),
  honeypotField: z.literal(PUBLIC_HONEYPOT_FIELD),
  maxPhotoBytes: z.number().int(),
  acceptedPhotoTypes: z.array(z.string()),
  projectsEnabled: z.boolean(),
});
export type PublicPortalInfo = z.infer<typeof PublicPortalInfoSchema>;

/* ------------------------------ Case submission ----------------------------- */

/**
 * S24 submission. Sent as multipart: `payload` (JSON of this schema) and an
 * optional `photo` (JPEG/PNG/WebP/HEIC, ≤ 8 MB). Contact fields are optional;
 * with preference NONE they are ignored and not stored.
 */
export const PublicCaseSubmissionSchema = AbuseFieldsSchema.extend({
  category: CaseCategorySchema,
  description: z.string().trim().min(20, 'Describe the issue in at least 20 characters').max(4000),
  /** Ward (preferred) or constituency inside the portal county. */
  geographicUnitId: UuidSchema.optional(),
  locationDescription: z.string().trim().max(300).optional(),
  contactPreference: ContactPreferenceSchema.default('NONE'),
  name: z.string().trim().max(200).optional(),
  phone: PhoneSchema.optional(),
  email: z.string().trim().email().max(200).optional(),
  /** Explicit consent to be contacted about this request. */
  consentToContact: z.boolean().default(false),
  /** Must equal the version returned by GET /public/:tenantSlug/portal. */
  privacyNoticeVersion: z.string().min(1).max(64),
  /** The person confirms they read the notice. */
  privacyNoticeAcknowledged: z.literal(true, { errorMap: () => ({ message: 'Please confirm you have read the privacy notice' }) }),
}).superRefine((v, ctx) => {
  if ((v.contactPreference === 'PHONE' || v.contactPreference === 'SMS') && !v.phone) {
    ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a phone number, or choose "Do not contact me"' });
  }
  if (v.contactPreference === 'EMAIL' && !v.email) {
    ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter an email address, or choose "Do not contact me"' });
  }
  if (v.contactPreference !== 'NONE' && !v.consentToContact) {
    ctx.addIssue({ code: 'custom', path: ['consentToContact'], message: 'Tick the box to let us contact you' });
  }
});
export type PublicCaseSubmission = z.infer<typeof PublicCaseSubmissionSchema>;

export const PublicCaseReceiptSchema = z.object({
  /** e.g. "BGM-7K3F-9Q2X". */
  publicReference: z.string(),
  /** Shown once. Needed with the reference to track the request; only its hash is stored. */
  trackingCode: z.string(),
  submittedAt: IsoDateTimeSchema,
  acknowledgement: z.string(),
  privacyNoticeVersion: z.string(),
  /** Web path of the tracking page, e.g. "/p/bungoma-governor/track". */
  trackPath: z.string(),
});
export type PublicCaseReceipt = z.infer<typeof PublicCaseReceiptSchema>;

/* --------------------------------- Tracking --------------------------------- */

/** POST (not GET) so the tracking code never appears in URLs or access logs. */
export const PublicTrackRequestSchema = AbuseFieldsSchema.extend({
  publicReference: z.string().trim().toUpperCase().min(6).max(32),
  trackingCode: z.string().trim().toUpperCase().min(6).max(16),
});
export type PublicTrackRequest = z.infer<typeof PublicTrackRequestSchema>;

export const PublicCaseStatusSchema = z.object({
  publicReference: z.string(),
  category: CaseCategorySchema,
  categoryLabel: z.string(),
  locationName: z.string().nullable(),
  stage: PublicCaseStageSchema,
  stageLabel: z.string(),
  submittedAt: IsoDateTimeSchema,
  lastUpdatedAt: IsoDateTimeSchema,
  /** PUBLIC timeline events only, oldest first. No staff names. */
  updates: z.array(z.object({ at: IsoDateTimeSchema, message: z.string() })),
  /** Institutions the request was referred to (names only). */
  referredTo: z.array(z.string()),
  /** True in RESOLUTION_PROPOSED / CITIZEN_FEEDBACK. */
  feedbackAllowed: z.boolean(),
});
export type PublicCaseStatus = z.infer<typeof PublicCaseStatusSchema>;

export const PublicCitizenFeedbackSchema = PublicTrackRequestSchema.extend({
  response: CitizenFeedbackResponseSchema,
  message: z.string().trim().max(2000).optional(),
});
export type PublicCitizenFeedback = z.infer<typeof PublicCitizenFeedbackSchema>;

/* ------------------------------ Public projects ----------------------------- */

export const PublicProjectQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).optional(),
  category: ProjectCategorySchema.optional(),
  stageKind: ProjectStageKindSchema.optional(),
  geographicUnitId: UuidSchema.optional(),
});
export type PublicProjectQuery = z.infer<typeof PublicProjectQuerySchema>;

export const PublicProjectSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  category: ProjectCategorySchema,
  categoryLabel: z.string(),
  locationName: z.string().nullable(),
  status: ProjectStatusSchema,
  statusLabel: z.string(),
  stageKind: ProjectStageKindSchema,
  stageKindLabel: z.string(),
  responsibleInstitution: z.object({ name: z.string(), typeLabel: z.string() }),
  commitmentSourceLabel: z.string(),
  /** "Completion verified" / "Reported complete — awaiting independent verification" / "Not complete". */
  completionVerificationLabel: z.string(),
  lastUpdatedAt: IsoDateTimeSchema,
});
export type PublicProjectSummary = z.infer<typeof PublicProjectSummarySchema>;

/** Optional sections are present only when the field was approved for publication. */
export const PublicProjectDetailSchema = PublicProjectSummarySchema.extend({
  commitmentSourceDetail: z.string().nullable(),
  description: z.string().nullable().optional(),
  implementingAgency: z.object({ name: z.string(), typeLabel: z.string() }).nullable().optional(),
  projectOwner: z.string().nullable().optional(),
  fundingSourceLabel: z.string().optional(),
  currency: z.string(),
  approvedAllocation: MoneySchema.nullable().optional(),
  contractAmount: MoneySchema.nullable().optional(),
  expenditure: z
    .object({
      reported: MoneySchema.nullable(),
      asOf: IsoDateSchema.nullable(),
      source: z.string().nullable(),
      verificationLabel: z.string(),
    })
    .optional(),
  schedule: z
    .object({
      startDate: IsoDateSchema.nullable(),
      expectedCompletionDate: IsoDateSchema.nullable(),
      actualCompletionDate: IsoDateSchema.nullable(),
      delayReason: z.string().nullable(),
    })
    .optional(),
  milestones: z
    .array(
      z.object({
        title: z.string(),
        statusLabel: z.string(),
        plannedDate: IsoDateSchema.nullable(),
        actualDate: IsoDateSchema.nullable(),
        verificationLabel: z.string(),
      }),
    )
    .optional(),
  evidence: z
    .array(
      z.object({
        id: UuidSchema,
        typeLabel: z.string(),
        description: z.string(),
        capturedOn: IsoDateSchema.nullable(),
        verificationLabel: z.string(),
        /** Present for images and PDFs: GET /public/:tenantSlug/projects/:id/evidence/:evidenceId/file. */
        filePath: z.string().nullable(),
      }),
    )
    .optional(),
  mapLocation: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional(),
  disclaimer: z.string(),
});
export type PublicProjectDetail = z.infer<typeof PublicProjectDetailSchema>;
