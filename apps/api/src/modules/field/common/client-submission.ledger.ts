import { Injectable } from '@nestjs/common';
import { sha256Hex, type TenantTx } from '@ngao360/db';
import { canonicalPayload, type ClientSubmissionKind, type ClientSubmissionOutcome } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';

/** A ledger row as the sync service needs it. */
export interface LedgerRecord {
  id: string;
  kind: ClientSubmissionKind;
  outcome: ClientSubmissionOutcome;
  payloadHash: string;
  resultType: string | null;
  resultId: string | null;
  resultReference: string | null;
  errorCode: string | null;
  attempts: number;
}

export interface LedgerItem {
  idempotencyKey: string;
  deviceId: string;
  kind: ClientSubmissionKind;
  clientCreatedAt: string | null;
  payload: unknown;
}

/**
 * - NEW: first time this key is seen; apply the item, then `record()`.
 * - REPLAY: the key was ACCEPTED with the same payload; return the recorded result, apply nothing.
 * - RETRY: the key was REJECTED or CONFLICT with the same payload; apply again, then `record()`.
 * - KEY_REUSED: the key exists with a different payload or kind; apply nothing (CONFLICT).
 */
export type LedgerCheck =
  | { state: 'NEW'; payloadHash: string }
  | { state: 'RETRY'; payloadHash: string; record: LedgerRecord }
  | { state: 'REPLAY'; payloadHash: string; record: LedgerRecord }
  | { state: 'KEY_REUSED'; payloadHash: string; record: LedgerRecord };

const SELECT = {
  id: true,
  kind: true,
  outcome: true,
  payloadHash: true,
  resultType: true,
  resultId: true,
  resultReference: true,
  errorCode: true,
  attempts: true,
} as const;

/**
 * Offline-sync idempotency ledger (`client_submissions`, blueprint 13.4).
 * Keys are scoped to (tenant, user): a key from another user never matches.
 * `check()` takes a transaction-level advisory lock on the key, so concurrent
 * retries of one item are serialised and only one of them applies it.
 *
 * Direct (online) endpoints that accept `clientIdempotencyKey` use the same
 * ledger, so an item first sent online and later replayed from the offline
 * queue is recorded once.
 */
@Injectable()
export class ClientSubmissionLedger {
  static payloadHash(payload: unknown): string {
    return sha256Hex(Buffer.from(canonicalPayload(payload), 'utf8'));
  }

  async check(tx: TenantTx, auth: AuthContext, item: LedgerItem): Promise<LedgerCheck> {
    const payloadHash = ClientSubmissionLedger.payloadHash(item.payload);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${auth.tenantId}:${auth.userId}:${item.idempotencyKey}`}, 0))`;
    const existing = await tx.clientSubmission.findUnique({
      where: { tenantId_userId_idempotencyKey: { tenantId: auth.tenantId, userId: auth.userId, idempotencyKey: item.idempotencyKey } },
      select: SELECT,
    });
    if (!existing) return { state: 'NEW', payloadHash };
    await tx.clientSubmission.update({
      where: { id: existing.id },
      data: { attempts: { increment: 1 }, lastSeenAt: new Date() },
    });
    const record = { ...existing, attempts: existing.attempts + 1 };
    if (existing.payloadHash !== payloadHash || existing.kind !== item.kind) return { state: 'KEY_REUSED', payloadHash, record };
    if (existing.outcome === 'ACCEPTED') return { state: 'REPLAY', payloadHash, record };
    return { state: 'RETRY', payloadHash, record };
  }

  /** Record the outcome of a NEW or RETRY item (same transaction as the applied change). */
  async record(
    tx: TenantTx,
    auth: AuthContext,
    item: LedgerItem,
    payloadHash: string,
    result: {
      outcome: ClientSubmissionOutcome;
      resultType?: string | null;
      resultId?: string | null;
      resultReference?: string | null;
      errorCode?: string | null;
    },
  ): Promise<void> {
    const data = {
      outcome: result.outcome,
      resultType: result.resultType ?? null,
      resultId: result.resultId ?? null,
      resultReference: result.resultReference ?? null,
      errorCode: result.errorCode ?? null,
      lastSeenAt: new Date(),
    };
    await tx.clientSubmission.upsert({
      where: { tenantId_userId_idempotencyKey: { tenantId: auth.tenantId, userId: auth.userId, idempotencyKey: item.idempotencyKey } },
      create: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        deviceId: item.deviceId,
        idempotencyKey: item.idempotencyKey,
        kind: item.kind,
        payloadHash,
        clientCreatedAt: item.clientCreatedAt ? new Date(item.clientCreatedAt) : null,
        ...data,
      },
      update: data,
    });
  }
}
