/**
 * S25 Case workspace DTOs (blueprint 9.2). API §11 in docs/API_CONTRACT.md.
 *
 * Requester contact details are stored apart from the case body
 * (`citizen_case_contacts`) and returned only by the contact endpoint, which
 * needs `office.cases.contact.view` and writes an audit event on every read.
 */
import { z } from 'zod';
import { SensitivityLevelSchema } from '../enums';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import {
  ExpectedVersionSchema,
  InstitutionRefSchema,
  OfficeFileSchema,
  OfficeLocationInputSchema,
  OfficeLocationSchema,
  PhoneSchema,
  RecordRefSchema,
} from './common';
import {
  CaseCategorySchema,
  CaseClosureReasonSchema,
  CaseEventActorTypeSchema,
  CaseEventTypeSchema,
  CaseEventVisibilitySchema,
  CasePrioritySchema,
  CaseSourceSchema,
  CaseStatusSchema,
  ContactPreferenceSchema,
  ReferralStatusSchema,
} from './enums';

export const CASE_ACTIONS = [
  'edit',
  'triage',
  'assign',
  'add_note',
  'add_public_update',
  'add_evidence',
  'refer',
  'propose_resolution',
  'close',
  'reopen',
  'view_contact',
] as const;
export const CaseActionSchema = z.enum(CASE_ACTIONS);
export type CaseAction = z.infer<typeof CaseActionSchema>;

/* --------------------------------- Contact --------------------------------- */

/** Minimal requester contact. Every field is optional; preference NONE means "do not contact". */
export const CaseContactInputSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    phone: PhoneSchema.optional(),
    email: z.string().trim().email().max(200).optional(),
    preference: ContactPreferenceSchema.default('NONE'),
    preferredLanguage: z.enum(['en', 'sw']).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.preference === 'PHONE' || v.preference === 'SMS') && !v.phone) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a phone number, or choose another contact preference' });
    }
    if (v.preference === 'EMAIL' && !v.email) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter an email address, or choose another contact preference' });
    }
  });
export type CaseContactInput = z.infer<typeof CaseContactInputSchema>;

export const CaseContactSchema = z.object({
  caseId: UuidSchema,
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  preference: ContactPreferenceSchema,
  preferredLanguage: z.string().nullable(),
  consentToContact: z.boolean(),
  /** Contact is deleted after this date (office retention setting). */
  retentionUntil: IsoDateSchema.nullable(),
  /** Set when the details were erased (retention or a data-subject request). */
  erasedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type CaseContact = z.infer<typeof CaseContactSchema>;

export const UpdateCaseContactSchema = z.object({
  contact: CaseContactInputSchema,
  consentToContact: z.boolean(),
  reason: ReasonSchema,
});
export type UpdateCaseContact = z.infer<typeof UpdateCaseContactSchema>;

/** Erase contact details (data-subject request or retention). The case body stays. */
export const EraseCaseContactSchema = z.object({ reason: ReasonSchema });
export type EraseCaseContact = z.infer<typeof EraseCaseContactSchema>;

/* ------------------------------ Timeline events ----------------------------- */

export const CaseEventSchema = z.object({
  id: UuidSchema,
  type: CaseEventTypeSchema,
  visibility: CaseEventVisibilitySchema,
  actorType: CaseEventActorTypeSchema,
  /** Null for requester and system events. */
  actor: UserRefSchema.nullable(),
  body: z.string().nullable(),
  fromStatus: CaseStatusSchema.nullable(),
  toStatus: CaseStatusSchema.nullable(),
  file: OfficeFileSchema.nullable(),
  referralId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type CaseEvent = z.infer<typeof CaseEventSchema>;

/**
 * NOTE → INTERNAL (needs `office.cases.internal_notes`); PUBLIC_UPDATE → PUBLIC
 * (shown to the requester on the tracking page); CONTACT_ATTEMPT → INTERNAL.
 * The visibility is derived from the type and cannot be chosen.
 */
export const AddCaseEventSchema = z.object({
  type: z.enum(['NOTE', 'PUBLIC_UPDATE', 'CONTACT_ATTEMPT']),
  body: z.string().trim().min(2).max(4000),
});
export type AddCaseEvent = z.infer<typeof AddCaseEventSchema>;

/** Multipart field `metadata` (JSON) sent with the `file` part. */
export const AddCaseEvidenceSchema = z.object({
  description: z.string().trim().min(2).max(1000),
  /** PUBLIC evidence is listed (without download) on the tracking page. Default INTERNAL. */
  visibility: CaseEventVisibilitySchema.default('INTERNAL'),
});
export type AddCaseEvidence = z.infer<typeof AddCaseEvidenceSchema>;

/* --------------------------------- Referrals -------------------------------- */

export const CaseReferralSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  institution: InstitutionRefSchema,
  referredAt: IsoDateSchema,
  /** Officer or desk at the institution (an office contact, not the requester). */
  contactPerson: z.string().nullable(),
  contactDetail: z.string().nullable(),
  institutionReference: z.string().nullable(),
  followUpDate: IsoDateSchema.nullable(),
  status: ReferralStatusSchema,
  responseSummary: z.string().nullable(),
  /** True when requester contact details were passed on (only with consent). */
  requesterContactShared: z.boolean(),
  referredBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CaseReferral = z.infer<typeof CaseReferralSchema>;

export const CreateCaseReferralSchema = z.object({
  institutionId: UuidSchema,
  referredAt: IsoDateSchema,
  contactPerson: z.string().trim().max(200).optional(),
  contactDetail: z.string().trim().max(300).optional(),
  institutionReference: z.string().trim().max(100).optional(),
  followUpDate: IsoDateSchema.optional(),
  /** Refused (400) unless the requester consented to contact. */
  shareRequesterContact: z.boolean().default(false),
  /** Internal note on the referral event. */
  note: z.string().trim().min(3).max(4000),
  /** Optional requester-visible message; defaults to "Referred to <institution>". */
  publicMessage: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type CreateCaseReferral = z.infer<typeof CreateCaseReferralSchema>;

export const UpdateCaseReferralSchema = z.object({
  status: ReferralStatusSchema.optional(),
  followUpDate: IsoDateSchema.nullable().optional(),
  institutionReference: z.string().trim().max(100).optional(),
  responseSummary: z.string().trim().max(4000).optional(),
  note: z.string().trim().min(3).max(4000),
});
export type UpdateCaseReferral = z.infer<typeof UpdateCaseReferralSchema>;

export const CaseReferralParamSchema = z.object({ id: UuidSchema, referralId: UuidSchema });
export type CaseReferralParam = z.infer<typeof CaseReferralParamSchema>;

/* ----------------------------------- Cases ---------------------------------- */

export const CaseSummarySchema = z.object({
  id: UuidSchema,
  /** Internal sequential reference, e.g. "CASE-2026-000123". */
  reference: z.string(),
  /** Non-sequential reference given to the requester, e.g. "BGM-7K3F-9Q2X". */
  publicReference: z.string(),
  title: z.string(),
  category: CaseCategorySchema,
  priority: CasePrioritySchema,
  source: CaseSourceSchema,
  status: CaseStatusSchema,
  location: OfficeLocationSchema,
  assignee: UserRefSchema.nullable(),
  nextReviewDate: IsoDateSchema.nullable(),
  /** nextReviewDate passed and the case is not CLOSED. */
  reviewOverdue: z.boolean(),
  /** Whether contact details exist (the details themselves are never in this DTO). */
  hasContact: z.boolean(),
  submittedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseDetailSchema = CaseSummarySchema.extend({
  description: z.string(),
  sensitivity: SensitivityLevelSchema,
  privacyNoticeVersion: z.string(),
  consentToContact: z.boolean(),
  triagedBy: UserRefSchema.nullable(),
  triagedAt: IsoDateTimeSchema.nullable(),
  resolution: z
    .object({ summary: z.string(), proposedBy: UserRefSchema, proposedAt: IsoDateTimeSchema })
    .nullable(),
  closure: z
    .object({
      reason: CaseClosureReasonSchema,
      note: z.string().nullable(),
      closedBy: UserRefSchema,
      closedAt: IsoDateTimeSchema,
    })
    .nullable(),
  duplicateOf: RecordRefSchema.nullable(),
  linkedCorrespondence: z.array(RecordRefSchema),
  referrals: z.array(CaseReferralSchema),
  /** Internal NOTE events are omitted unless the caller holds `office.cases.internal_notes`. */
  events: z.array(CaseEventSchema),
  /** Tenant setting: the closer must differ from the resolution proposer. */
  closeRequiresSecondPerson: z.boolean(),
  allowedActions: z.array(CaseActionSchema),
  version: z.number().int(),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

/** POST /office/cases response: the tracking code is shown once, for the officer to give the requester. */
export const CreateCaseResponseSchema = CaseDetailSchema.extend({ trackingCode: z.string() });
export type CreateCaseResponse = z.infer<typeof CreateCaseResponseSchema>;

/** Staff-recorded case (walk-in, phone, letter…). Portal cases use `PublicCaseSubmission`. */
export const CreateCaseSchema = OfficeLocationInputSchema.extend({
  source: CaseSourceSchema.exclude(['PORTAL']),
  category: CaseCategorySchema,
  priority: CasePrioritySchema.default('MEDIUM'),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(8000),
  sensitivity: SensitivityLevelSchema.default('INTERNAL'),
  contact: CaseContactInputSchema.optional(),
  consentToContact: z.boolean().default(false),
  /** Must equal CURRENT_PORTAL_PRIVACY_NOTICE_VERSION (read to the requester). */
  privacyNoticeVersion: z.string().min(1).max(64),
  assigneeId: UuidSchema.optional(),
  linkedCorrespondenceId: UuidSchema.optional(),
});
export type CreateCase = z.infer<typeof CreateCaseSchema>;

export const UpdateCaseSchema = OfficeLocationInputSchema.extend({
  category: CaseCategorySchema.optional(),
  priority: CasePrioritySchema.optional(),
  title: z.string().trim().min(3).max(160).optional(),
  sensitivity: SensitivityLevelSchema.optional(),
  nextReviewDate: IsoDateSchema.nullable().optional(),
  duplicateOfId: UuidSchema.nullable().optional(),
  expectedVersion: ExpectedVersionSchema,
  reason: ReasonSchema,
});
export type UpdateCase = z.infer<typeof UpdateCaseSchema>;

export const AssignCaseSchema = z.object({
  /** Must hold `office.cases.manage` within the case geography. */
  assigneeId: UuidSchema,
  nextReviewDate: IsoDateSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type AssignCase = z.infer<typeof AssignCaseSchema>;

/**
 * Generic transition for SUBMITTED→TRIAGE, TRIAGE/REOPENED→ASSIGNED,
 * →IN_PROGRESS, RESOLUTION_PROPOSED→CITIZEN_FEEDBACK. REFERRED,
 * RESOLUTION_PROPOSED, CLOSED and REOPENED have their own endpoints.
 */
export const CaseTransitionSchema = z.object({
  to: z.enum(['TRIAGE', 'ASSIGNED', 'IN_PROGRESS', 'CITIZEN_FEEDBACK']),
  reason: ReasonSchema,
  /** Adds a PUBLIC_UPDATE event in the same transaction. */
  publicMessage: z.string().trim().max(2000).optional(),
  nextReviewDate: IsoDateSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type CaseTransition = z.infer<typeof CaseTransitionSchema>;

export const ProposeCaseResolutionSchema = z.object({
  /** Shown to the requester. Describe the action taken and the evidence for it. */
  summary: z.string().trim().min(10).max(4000),
  internalNote: z.string().trim().max(4000).optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type ProposeCaseResolution = z.infer<typeof ProposeCaseResolutionSchema>;

export const CloseCaseSchema = z.object({
  closureReason: CaseClosureReasonSchema,
  note: z.string().trim().min(3).max(4000),
  publicMessage: z.string().trim().max(2000).optional(),
  /** Required when closureReason is DUPLICATE. */
  duplicateOfId: UuidSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type CloseCase = z.infer<typeof CloseCaseSchema>;

export const ReopenCaseSchema = z.object({
  reason: ReasonSchema,
  publicMessage: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type ReopenCase = z.infer<typeof ReopenCaseSchema>;

export const CaseQuerySchema = PaginationQuerySchema.extend({
  status: CaseStatusSchema.optional(),
  category: CaseCategorySchema.optional(),
  priority: CasePrioritySchema.optional(),
  source: CaseSourceSchema.optional(),
  assigneeId: UuidSchema.optional(),
  /** Any unit (county, constituency or ward); matches cases inside it. */
  geographicUnitId: UuidSchema.optional(),
  view: z.enum(['all', 'mine', 'unassigned', 'triage', 'review_due', 'closed']).default('all'),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});
export type CaseQuery = z.infer<typeof CaseQuerySchema>;
