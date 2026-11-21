/**
 * Display holds and redacted copies over HTTP (API contract §35; today CLI only). Owner: field-pin.
 * A held original is never served; viewers get the redacted copy once attached.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, ReasonSchema, UserRefSchema, UuidSchema } from '../schemas/common';

export const DISPLAY_HOLD_STATES = ['AWAITING_REDACTION', 'DECLARED_REDACTED', 'REDACTED_COPY_ATTACHED'] as const;
export type DisplayHoldState = (typeof DISPLAY_HOLD_STATES)[number];
export const DisplayHoldStateSchema = z.enum(DISPLAY_HOLD_STATES);

export const DisplayHoldSummarySchema = z.object({
  id: UuidSchema,
  storedFileId: UuidSchema,
  /** The submission the scan belongs to, when there is one in the caller's scope. */
  submissionId: UuidSchema.nullable(),
  submissionReference: z.string().nullable(),
  pollingStationCode: z.string().nullable(),
  state: DisplayHoldStateSchema,
  reason: z.string(),
  createdBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  redactedBy: UserRefSchema.nullable(),
  redactedAt: IsoDateTimeSchema.nullable(),
  /** SHA-256 of the redacted copy (never of a served original). */
  redactedSha256: z.string().nullable(),
  /** Parallel-tally disclaimer and, for demo tenants, the HISTORICAL DEMO label. */
  dataLabel: z.string().nullable(),
});
export type DisplayHoldSummary = z.infer<typeof DisplayHoldSummarySchema>;

export const DisplayHoldQuerySchema = z.object({
  state: DisplayHoldStateSchema.optional(),
  electionCycleId: UuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type DisplayHoldQuery = z.infer<typeof DisplayHoldQuerySchema>;

/** Confirm an operator's "already redacted" declaration (second person, re-auth). */
export const ConfirmDeclaredRedactionSchema = z.object({ reason: ReasonSchema });
export type ConfirmDeclaredRedaction = z.infer<typeof ConfirmDeclaredRedactionSchema>;
