/** S23 Correspondence inbox DTOs (blueprint 9.1). API §9 in docs/API_CONTRACT.md. */
import { z } from 'zod';
import { SensitivityLevelSchema } from '../enums';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { ExpectedVersionSchema, OfficeFileSchema, RecordRefSchema } from './common';
import {
  CorrespondenceCategorySchema,
  CorrespondenceChannelSchema,
  CorrespondenceDirectionSchema,
  CorrespondenceStatusSchema,
} from './enums';

export const CORRESPONDENCE_ACTIONS = ['edit', 'assign', 'transition', 'attach', 'link_case'] as const;
export const CorrespondenceActionSchema = z.enum(CORRESPONDENCE_ACTIONS);

export const CorrespondenceAttachmentSchema = z.object({
  id: UuidSchema,
  label: z.string().nullable(),
  file: OfficeFileSchema,
  addedBy: UserRefSchema,
  addedAt: IsoDateTimeSchema,
});
export type CorrespondenceAttachment = z.infer<typeof CorrespondenceAttachmentSchema>;

export const CorrespondenceSummarySchema = z.object({
  id: UuidSchema,
  /** Office reference, e.g. "COR-IN-2026-000042" or "COR-OUT-2026-000007". */
  reference: z.string(),
  direction: CorrespondenceDirectionSchema,
  channel: CorrespondenceChannelSchema,
  category: CorrespondenceCategorySchema,
  sensitivity: SensitivityLevelSchema,
  subject: z.string(),
  /** Sender for incoming items, recipient for outgoing items. */
  counterpartName: z.string(),
  counterpartOrganisation: z.string().nullable(),
  documentDate: IsoDateSchema.nullable(),
  receivedAt: IsoDateTimeSchema.nullable(),
  sentAt: IsoDateTimeSchema.nullable(),
  responseDueDate: IsoDateSchema.nullable(),
  /** Due date passed and status not RESPONDED/SENT/FILED/ARCHIVED. */
  overdue: z.boolean(),
  status: CorrespondenceStatusSchema,
  assignedTo: UserRefSchema.nullable(),
  attachmentCount: z.number().int(),
  linkedCaseId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CorrespondenceSummary = z.infer<typeof CorrespondenceSummarySchema>;

export const CorrespondenceDetailSchema = CorrespondenceSummarySchema.extend({
  senderName: z.string().nullable(),
  senderOrganisation: z.string().nullable(),
  recipientName: z.string().nullable(),
  recipientOrganisation: z.string().nullable(),
  /** The sender's own reference number, as printed. */
  externalReference: z.string().nullable(),
  summary: z.string().nullable(),
  linkedCase: RecordRefSchema.nullable(),
  /** For a reply: the item it answers. */
  inReplyTo: RecordRefSchema.nullable(),
  replies: z.array(RecordRefSchema),
  attachments: z.array(CorrespondenceAttachmentSchema),
  createdBy: UserRefSchema,
  allowedActions: z.array(CorrespondenceActionSchema),
  version: z.number().int(),
});
export type CorrespondenceDetail = z.infer<typeof CorrespondenceDetailSchema>;

const CorrespondenceBaseSchema = z.object({
  direction: CorrespondenceDirectionSchema,
  channel: CorrespondenceChannelSchema,
  category: CorrespondenceCategorySchema,
  /** CONFIDENTIAL and HIGHLY_RESTRICTED need `office.correspondence.confidential`. */
  sensitivity: SensitivityLevelSchema.default('INTERNAL'),
  subject: z.string().trim().min(3).max(300),
  senderName: z.string().trim().max(200).optional(),
  senderOrganisation: z.string().trim().max(200).optional(),
  recipientName: z.string().trim().max(200).optional(),
  recipientOrganisation: z.string().trim().max(200).optional(),
  externalReference: z.string().trim().max(100).optional(),
  documentDate: IsoDateSchema.optional(),
  receivedAt: IsoDateTimeSchema.optional(),
  sentAt: IsoDateTimeSchema.optional(),
  responseDueDate: IsoDateSchema.optional(),
  assignedToId: UuidSchema.optional(),
  summary: z.string().trim().max(4000).optional(),
  linkedCaseId: UuidSchema.optional(),
  inReplyToId: UuidSchema.optional(),
});

/**
 * Incoming items need a sender and `receivedAt` (status RECEIVED, or ASSIGNED
 * when `assignedToId` is set). Outgoing items need a recipient (status DRAFT).
 */
export const CreateCorrespondenceSchema = CorrespondenceBaseSchema.superRefine((v, ctx) => {
  if (v.direction === 'INCOMING') {
    if (!v.senderName && !v.senderOrganisation) ctx.addIssue({ code: 'custom', path: ['senderName'], message: 'Enter the sender' });
    if (!v.receivedAt) ctx.addIssue({ code: 'custom', path: ['receivedAt'], message: 'Enter the date received' });
  } else if (!v.recipientName && !v.recipientOrganisation) {
    ctx.addIssue({ code: 'custom', path: ['recipientName'], message: 'Enter the recipient' });
  }
});
export type CreateCorrespondence = z.infer<typeof CreateCorrespondenceSchema>;

/** Direction cannot change; create a new item instead. */
export const UpdateCorrespondenceSchema = CorrespondenceBaseSchema.omit({ direction: true, assignedToId: true })
  .partial()
  .extend({ expectedVersion: ExpectedVersionSchema, reason: ReasonSchema.optional() });
export type UpdateCorrespondence = z.infer<typeof UpdateCorrespondenceSchema>;

export const AssignCorrespondenceSchema = z.object({
  /** Null unassigns. The assignee must hold `office.correspondence.view` (and `.confidential` for restricted items). */
  assignedToId: UuidSchema.nullable(),
  responseDueDate: IsoDateSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type AssignCorrespondence = z.infer<typeof AssignCorrespondenceSchema>;

export const CorrespondenceTransitionSchema = z.object({
  to: CorrespondenceStatusSchema,
  /** Required for FILED without a response and for ARCHIVED. */
  reason: ReasonSchema.optional(),
  /** For SENT: when it was dispatched (defaults to now). */
  sentAt: IsoDateTimeSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
});
export type CorrespondenceTransition = z.infer<typeof CorrespondenceTransitionSchema>;

/** Multipart field `metadata` (JSON) sent with the `file` part. */
export const AddCorrespondenceAttachmentSchema = z.object({
  label: z.string().trim().max(200).optional(),
});
export type AddCorrespondenceAttachment = z.infer<typeof AddCorrespondenceAttachmentSchema>;

export const CorrespondenceQuerySchema = PaginationQuerySchema.extend({
  direction: CorrespondenceDirectionSchema.optional(),
  status: CorrespondenceStatusSchema.optional(),
  category: CorrespondenceCategorySchema.optional(),
  sensitivity: SensitivityLevelSchema.optional(),
  assignedToId: UuidSchema.optional(),
  /** mine = assigned to the caller; overdue = past responseDueDate and still open. */
  view: z.enum(['all', 'mine', 'overdue', 'unassigned']).default('all'),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});
export type CorrespondenceQuery = z.infer<typeof CorrespondenceQuerySchema>;
