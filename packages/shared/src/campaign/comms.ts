/**
 * Communications content workflow DTOs (blueprint 5.4): draft → editorial
 * review → authorised approval → publication → archive, with an append-only
 * revision and correction history. API contract §26.
 *
 * Boundary: content items are notices, press releases, bulletins, website
 * updates and event information published to broad audience CATEGORIES.
 * There is no recipient list, no voter data, no per-person targeting and no
 * bulk SMS / e-mail to the public. Publication records that an item went out
 * on a channel; it does not send messages.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema, DepartmentRefSchema } from './common';
import { ContentAudienceSchema, ContentRevisionKindSchema, ContentStatusSchema, ContentTypeSchema } from './enums';

export const ContentSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  type: ContentTypeSchema,
  title: z.string(),
  status: ContentStatusSchema,
  audience: ContentAudienceSchema,
  department: DepartmentRefSchema.nullable(),
  author: UserRefSchema,
  editor: UserRefSchema.nullable(),
  approver: UserRefSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  /** Body revision number (1 = first draft). */
  revision: z.number().int(),
  correctionCount: z.number().int(),
  updatedAt: IsoDateTimeSchema,
  version: z.number().int(),
});
export type ContentSummary = z.infer<typeof ContentSummarySchema>;

export const ContentRevisionSchema = z.object({
  id: UuidSchema,
  kind: ContentRevisionKindSchema,
  revision: z.number().int(),
  title: z.string(),
  body: z.string(),
  bodySha256: z.string(),
  fromStatus: ContentStatusSchema.nullable(),
  toStatus: ContentStatusSchema.nullable(),
  /** Correction note (shown publicly with a corrected item) or review note. */
  note: z.string().nullable(),
  actor: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type ContentRevision = z.infer<typeof ContentRevisionSchema>;

export const CONTENT_ALLOWED_ACTIONS = ['EDIT', 'SUBMIT', 'EDITORIAL_APPROVE', 'RETURN', 'APPROVE', 'PUBLISH', 'CORRECT', 'ARCHIVE', 'WITHDRAW'] as const;

export const ContentDetailSchema = ContentSummarySchema.extend({
  summary: z.string().nullable(),
  body: z.string(),
  eventId: UuidSchema.nullable(),
  scheduledFor: IsoDateTimeSchema.nullable(),
  publishedBy: UserRefSchema.nullable(),
  archivedAt: IsoDateTimeSchema.nullable(),
  revisions: z.array(ContentRevisionSchema),
  createdAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(CONTENT_ALLOWED_ACTIONS)),
});
export type ContentDetail = z.infer<typeof ContentDetailSchema>;

export const ContentQuerySchema = PaginationQuerySchema.extend({
  status: z.union([ContentStatusSchema, z.array(ContentStatusSchema)]).optional(),
  type: ContentTypeSchema.optional(),
  audience: ContentAudienceSchema.optional(),
  departmentId: UuidSchema.optional(),
  view: z.enum(['all', 'mine', 'awaiting_me']).default('all'),
});
export type ContentQuery = z.infer<typeof ContentQuerySchema>;

export const CreateContentSchema = z.object({
  type: ContentTypeSchema,
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(500).nullable().optional(),
  body: z.string().trim().min(1).max(50000),
  audience: ContentAudienceSchema,
  departmentId: UuidSchema.nullable().optional(),
  eventId: UuidSchema.nullable().optional(),
  scheduledFor: IsoDateTimeSchema.nullable().optional(),
});
export type CreateContent = z.infer<typeof CreateContentSchema>;

/** Edits in DRAFT (author, comms.content.draft) or EDITORIAL_REVIEW (editor, comms.content.edit). Each body change appends a revision. */
export const UpdateContentSchema = CreateContentSchema.omit({ type: true }).partial().extend({
  expectedVersion: CampaignExpectedVersionSchema,
  note: z.string().trim().max(1000).optional(),
});
export type UpdateContent = z.infer<typeof UpdateContentSchema>;

/**
 * Workflow actions:
 * - SUBMIT: DRAFT → EDITORIAL_REVIEW (author; with editorial review off, → AWAITING_APPROVAL)
 * - EDITORIAL_APPROVE: EDITORIAL_REVIEW → AWAITING_APPROVAL (comms.content.edit; records editor)
 * - RETURN: EDITORIAL_REVIEW | AWAITING_APPROVAL | APPROVED → DRAFT (note required)
 * - APPROVE: AWAITING_APPROVAL → APPROVED (comms.content.approve; approver ≠ author, DB check)
 * - PUBLISH: APPROVED → PUBLISHED (comms.content.publish; records publication time and channel)
 * - ARCHIVE: PUBLISHED → ARCHIVED
 * - WITHDRAW: PUBLISHED → WITHDRAWN (reason required; comms.content.approve)
 */
export const ContentTransitionSchema = z
  .object({
    action: z.enum(['SUBMIT', 'EDITORIAL_APPROVE', 'RETURN', 'APPROVE', 'PUBLISH', 'ARCHIVE', 'WITHDRAW']),
    note: z.string().trim().max(2000).optional(),
    expectedVersion: CampaignExpectedVersionSchema,
  })
  .refine((v) => !['RETURN', 'WITHDRAW'].includes(v.action) || (v.note?.length ?? 0) >= 3, {
    message: 'Give a note for returns and withdrawals',
    path: ['note'],
  });
export type ContentTransition = z.infer<typeof ContentTransitionSchema>;

/**
 * Correction of a PUBLISHED item: new body revision with a public correction
 * note; the previous text stays in the history (comms.content.edit, then the
 * correction itself needs comms.content.approve by someone other than the
 * person who wrote it when `requiresApproval`; v1: corrections are recorded
 * by an approver directly).
 */
export const CorrectContentSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(1).max(50000),
  correctionNote: ReasonSchema,
  expectedVersion: CampaignExpectedVersionSchema,
});
export type CorrectContent = z.infer<typeof CorrectContentSchema>;

/** The API refuses content fields that look like recipient lists (no bulk outreach). */
export const CONTENT_FORBIDDEN_FIELDS = ['recipients', 'phoneNumbers', 'voterIds', 'targetList', 'smsBlast'] as const;
