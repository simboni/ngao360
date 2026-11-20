/**
 * Local queue records (blueprint 13.4; contract §22 "client obligations").
 *
 * Clear metadata (state, timestamps, retry count, error code, server
 * reference, ids) is kept beside the encrypted body: the payload, a short
 * human summary, photo bytes and any server state returned with a conflict
 * are sealed with the queue key (`crypto.ts`).
 */
import type { ClientSubmissionKind, LocalQueueState } from '@ngao360/shared';
import type { Sealed } from './crypto';

export type QueueKind = ClientSubmissionKind;

/** SEND: the item has not been accepted yet. ATTACH_EVIDENCE: a field report was accepted; its photos still need linking. */
export type QueuePhase = 'SEND' | 'ATTACH_EVIDENCE';

export interface StoredAttachment {
  id: string;
  mimeType: string;
  sizeBytes: number;
  /** Set once the bytes were stored with POST /field/evidence (content-addressed, so a retry returns the same id). */
  fileId: string | null;
  /** Encrypted bytes; dropped once the item is confirmed. */
  sealed: Sealed | null;
}

export interface StoredEntry {
  idempotencyKey: string;
  kind: QueueKind;
  state: LocalQueueState;
  phase: QueuePhase;
  createdAt: string;
  retryCount: number;
  lastAttemptAt: string | null;
  /** Earliest time of the next automatic attempt (null = now). */
  nextAttemptAt: string | null;
  lastError: string | null;
  errorCode: string | null;
  serverResultId: string | null;
  serverReference: string | null;
  /** The server already had this item (a retry after a lost response). */
  replayed: boolean;
  confirmedAt: string | null;
  /** Deployment or incident the item acts on (ids only), to stop duplicate taps. */
  targetId: string | null;
  /** `{ payload, summary }`, encrypted. Null once confirmed or acknowledged. */
  sealed: Sealed | null;
  /** Server record returned with a CONFLICT, encrypted (shown to the person). */
  serverState: Sealed | null;
  attachments: StoredAttachment[];
}

/** What the screens show for one entry (summary decrypted). */
export interface QueueEntryView {
  idempotencyKey: string;
  kind: QueueKind;
  state: LocalQueueState;
  phase: QueuePhase;
  createdAt: string;
  retryCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  errorCode: string | null;
  serverReference: string | null;
  serverResultId: string | null;
  replayed: boolean;
  confirmedAt: string | null;
  targetId: string | null;
  summary: string | null;
  attachmentCount: number;
}

export interface QueueCounts {
  /** Saved on this phone, waiting or uploading. */
  pending: number;
  /** Of the pending ones, how many failed at least once and wait for a retry. */
  retrying: number;
  /** Confirmed by the server (receipts kept for a day; payload already deleted). */
  sent: number;
  /** Refused by the server; the person must read and dismiss them. */
  failed: number;
  /** The server record differs; the person must decide. */
  conflict: number;
}

export interface SealedBody {
  payload: Record<string, unknown>;
  summary: string;
}
