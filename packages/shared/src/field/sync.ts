/**
 * Offline sync (blueprint 13.4; API contract §22).
 *
 * The mobile PWA queues records locally (encrypted IndexedDB, see
 * docs/ARCHITECTURE.md §13) and uploads them with `POST /field/sync`. Each item
 * carries a client-generated idempotency key. The server keeps a ledger
 * (`client_submissions`) keyed by (tenant, user, key):
 *
 * - first time: the item is applied and its result recorded → `ACCEPTED`;
 * - same key and same payload again → the recorded result, `replayed: true`
 *   (never a second record);
 * - same key with a DIFFERENT payload → `CONFLICT` with code
 *   `IDEMPOTENCY_KEY_REUSED` (nothing applied);
 * - the server record changed since the client read it (e.g. a check-in for a
 *   deployment that was replaced or cancelled, or a stale `expectedVersion`)
 *   → `CONFLICT` with the current server state, for the person to review.
 *   The client never overwrites server data silently;
 * - invalid or out-of-scope items → `REJECTED` with the error code.
 *
 * Items are independent: one failure never rolls back the others. The client
 * removes a local item only after a terminal outcome (ACCEPTED or a REJECTED
 * the person has seen), and keeps CONFLICT items until the person resolves them.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../schemas/common';
import { ClientSubmissionKindSchema, ClientSubmissionOutcomeSchema } from './enums';
import { CreateFieldReportSchema } from './reports';
import { CreateIncidentSchema, AddIncidentEventSchema } from './incidents';
import { CheckInSchema, ConfirmDeploymentSchema } from './deployment';

export const SYNC_MAX_ITEMS = 50;

const itemBase = z.object({
  /** Same value as the payload's clientIdempotencyKey (for INCIDENT_NOTE, generated per note). */
  idempotencyKey: UuidSchema,
  deviceId: z.string().trim().min(8).max(64),
  clientCreatedAt: IsoDateTimeSchema,
});

export const SyncItemSchema = z.discriminatedUnion('kind', [
  itemBase.extend({ kind: z.literal('FIELD_REPORT'), payload: CreateFieldReportSchema }),
  itemBase.extend({ kind: z.literal('INCIDENT'), payload: CreateIncidentSchema }),
  itemBase.extend({
    kind: z.literal('INCIDENT_NOTE'),
    payload: z.object({ incidentId: UuidSchema, event: AddIncidentEventSchema }),
  }),
  itemBase.extend({ kind: z.literal('CHECK_IN'), payload: CheckInSchema.extend({ deploymentId: UuidSchema }) }),
  itemBase.extend({
    kind: z.literal('ASSIGNMENT_CONFIRMATION'),
    payload: ConfirmDeploymentSchema.extend({ deploymentId: UuidSchema }),
  }),
]);
export type SyncItem = z.infer<typeof SyncItemSchema>;

export const SyncRequestSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(SYNC_MAX_ITEMS),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncItemResultSchema = z.object({
  idempotencyKey: UuidSchema,
  kind: ClientSubmissionKindSchema,
  outcome: ClientSubmissionOutcomeSchema,
  /** True when the server already had this item (a retry). */
  replayed: z.boolean(),
  resultType: z.string().nullable(),
  resultId: UuidSchema.nullable(),
  reference: z.string().nullable(),
  /** For REJECTED/CONFLICT: an ERROR_CODES value or IDEMPOTENCY_KEY_REUSED / STALE / SERVER_CHANGED. */
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  /** For CONFLICT: the current server record (DTO of the target), shown to the person. */
  serverState: z.record(z.unknown()).nullable(),
});
export type SyncItemResult = z.infer<typeof SyncItemResultSchema>;

export const SyncResponseSchema = z.object({
  results: z.array(SyncItemResultSchema),
  serverTime: IsoDateTimeSchema,
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

/** Sync-specific error codes (in addition to ERROR_CODES). */
export const SYNC_ERROR_CODES = {
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The item was saved on the device longer ago than FieldModuleConfig.offlineMaxAgeHours. */
  STALE: 'STALE',
  /** The server record changed since the device read it (stale version, replaced or cancelled deployment, retired template). */
  SERVER_CHANGED: 'SERVER_CHANGED',
} as const;

/** GET /field/sync/status: what the server has recorded for this device (queue screen). */
export const SyncStatusQuerySchema = z.object({ deviceId: z.string().trim().min(8).max(64) });
export type SyncStatusQuery = z.infer<typeof SyncStatusQuerySchema>;

export const SyncStatusSchema = z.object({
  deviceId: z.string(),
  lastReceivedAt: IsoDateTimeSchema.nullable(),
  accepted: z.number().int(),
  conflicts: z.array(SyncItemResultSchema),
  serverTime: IsoDateTimeSchema,
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * Canonical JSON used for the payload hash (keys sorted, no whitespace). The
 * server stores SHA-256 of this; a retry with the same key must hash the same.
 */
export function canonicalPayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalPayload(v)}`).join(',')}}`;
}

/* ------------------------- Local queue (client side) ------------------------ */

/** Local state of a queued item on the device (blueprint 13.4). */
export const LOCAL_QUEUE_STATES = ['SAVED_LOCALLY', 'UPLOADING', 'CONFIRMED', 'REJECTED', 'CONFLICT'] as const;
export const LocalQueueStateSchema = z.enum(LOCAL_QUEUE_STATES);
export type LocalQueueState = z.infer<typeof LocalQueueStateSchema>;

/** Shape of one queued record's metadata (the payload itself is stored encrypted). */
export const LocalQueueEntrySchema = z.object({
  idempotencyKey: UuidSchema,
  kind: ClientSubmissionKindSchema,
  state: LocalQueueStateSchema,
  createdAt: IsoDateTimeSchema,
  retryCount: z.number().int().min(0),
  lastAttemptAt: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  serverResultId: UuidSchema.nullable(),
  serverReference: z.string().nullable(),
});
export type LocalQueueEntry = z.infer<typeof LocalQueueEntrySchema>;
