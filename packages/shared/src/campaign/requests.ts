/**
 * Small request shapes shared by several campaign endpoints (API contract
 * §25, §27, §28; docs/CHANGE_REQUESTS.md, Campaign API request 3).
 */
import { z } from 'zod';
import { IsoDateSchema, PaginationQuerySchema, ReasonSchema, UuidSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema } from './common';
import { SaveFinanceAccountSchema } from './finance/ledger';

/** `{ reason }`: withdraw, cancel, reject and similar reasoned actions. */
export const ReasonBodySchema = z.object({ reason: ReasonSchema });
export type ReasonBody = z.infer<typeof ReasonBodySchema>;

/** `{ expectedVersion }`: optimistic-concurrency actions without other input. */
export const ExpectedVersionBodySchema = z.object({ expectedVersion: CampaignExpectedVersionSchema });
export type ExpectedVersionBody = z.infer<typeof ExpectedVersionBodySchema>;

/** `{ expectedVersion, reason }`. */
export const VersionReasonBodySchema = z.object({ expectedVersion: CampaignExpectedVersionSchema, reason: ReasonSchema });
export type VersionReasonBody = z.infer<typeof VersionReasonBodySchema>;

/** POST /events/:id/attendance/export. Contact details are never included. */
export const AttendanceExportSchema = z.object({ format: z.enum(['CSV', 'PDF']), reason: ReasonSchema });
export type AttendanceExport = z.infer<typeof AttendanceExportSchema>;

/** GET /finance/budget-lines. */
export const BudgetLineQuerySchema = z.object({
  departmentId: UuidSchema.optional(),
  eventId: UuidSchema.optional(),
  electionCycleId: UuidSchema.optional(),
});
export type BudgetLineQuery = z.infer<typeof BudgetLineQuerySchema>;

/** GET /finance/contribution-sources. */
export const ContributionSourceQuerySchema = PaginationQuerySchema.extend({
  electionCycleId: UuidSchema.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
});
export type ContributionSourceQuery = z.infer<typeof ContributionSourceQuerySchema>;

/** PATCH /finance/accounts/:id. */
export const UpdateFinanceAccountSchema = SaveFinanceAccountSchema.extend({ expectedVersion: CampaignExpectedVersionSchema });
export type UpdateFinanceAccount = z.infer<typeof UpdateFinanceAccountSchema>;

/** `/:id/attachments/:attachmentId` and `/:id/documents/:documentId`. */
export const AttachmentParamSchema = z.object({ id: UuidSchema, attachmentId: UuidSchema });
export type AttachmentParam = z.infer<typeof AttachmentParamSchema>;
export const DocumentParamSchema = z.object({ id: UuidSchema, documentId: UuidSchema });
export type DocumentParam = z.infer<typeof DocumentParamSchema>;
