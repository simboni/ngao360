import { HttpStatus } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import {
  ALLOWED_SOURCE_MIME_TYPES,
  AUDIT_ACTIONS,
  type AuditEvent,
  ERROR_CODES,
  type FieldModuleConfig,
  MAX_SOURCE_FILE_BYTES,
  type PermissionGrant,
  type PermissionKey,
  type SignedUrlResponse,
} from '@ngao360/shared';
import { z } from 'zod';
import type { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { type GeoLocation, scopeAllows, scopeFromGrants } from '../../../rbac/scope';
import { sniffMimeType } from '../../../storage/file-sniff';
import type { StorageService } from '../../../storage/storage.service';

/**
 * Small helpers shared by the field sub-modules (agents, deployment,
 * readiness, reports, incidents, War Room, sync). Pure functions or functions
 * that take the caller's tenant transaction; nothing here opens a transaction.
 */

export const USER_REF = { select: { id: true, displayName: true } } as const;

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** YYYY-MM-DD of a DATE column. */
export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function dateOnly(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  return v === null ? null : new Date(`${v}T00:00:00.000Z`);
}

export function paging(q: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** 409 IMMUTABLE_RECORD for records whose state forbids the change. */
export function immutableRecord(message: string): AppException {
  return new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, message);
}

/**
 * 409 CONFLICT for a stale `expectedVersion` (or a record that changed state
 * since the device read it). Carries the current DTO so the person can review
 * it; the server never overwrites silently.
 */
export function serverChanged(currentVersion: number, serverState: unknown, message = 'This record was changed since you last loaded it. Review the current version and try again.'): AppException {
  return AppException.conflict(message, { reason: 'SERVER_CHANGED', currentVersion, serverState });
}

/** An offline item outside the accepted age window (sync maps it to REJECTED + STALE). */
export class StaleItemException extends AppException {
  constructor(message: string) {
    super(ERROR_CODES.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message, [{ path: ['clientCreatedAt'], message }]);
  }
}

/**
 * Offline age rule (API contract §15): items saved on the device more than
 * `offlineMaxAgeHours` ago, or more than 5 minutes in the future, are refused.
 */
export function assertOfflineAge(config: FieldModuleConfig, at: string | Date, now = new Date()): void {
  const t = typeof at === 'string' ? new Date(at) : at;
  if (t.getTime() > now.getTime() + 5 * 60_000) {
    throw new StaleItemException('The time on this item is in the future. Check the date and time on the device.');
  }
  if (now.getTime() - t.getTime() > config.offlineMaxAgeHours * 3_600_000) {
    throw new StaleItemException(`This item was saved more than ${config.offlineMaxAgeHours} hours ago and can no longer be accepted.`);
  }
}

/**
 * Files a caller may attach: stored by the caller (stored_files.uploaded_by_id)
 * for field evidence. Any other id answers 400 (never reveals other files).
 */
export async function loadOwnEvidenceFiles(
  tx: TenantTx,
  auth: AuthContext,
  fileIds: readonly string[],
  path: (string | number)[] = ['fileIds'],
): Promise<Array<{ id: string; mimeType: string; sizeBytes: bigint; sha256: string }>> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return [];
  const files = await tx.storedFile.findMany({
    where: { id: { in: ids }, uploadedById: auth.userId, purpose: 'FIELD_EVIDENCE' },
    select: { id: true, mimeType: true, sizeBytes: true, sha256: true },
  });
  if (files.length !== ids.length) {
    throw AppException.validation('Attach only evidence files you uploaded yourself', [{ path, message: 'Unknown file or not uploaded by you' }]);
  }
  return files;
}

/** In-app notifications (blueprint 10.3). Bodies carry references and labels only, never personal data. */
export async function notifyUsers(
  tx: TenantTx,
  tenantId: string,
  userIds: Iterable<string>,
  n: { module: 'field' | 'warroom'; type: string; title: string; body: string; link: string | null },
): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  await tx.notification.createMany({
    data: ids.map((userId) => ({ tenantId, userId, channel: 'IN_APP' as const, module: n.module, type: n.type, title: n.title, body: n.body, link: n.link })),
  });
  return ids.length;
}

/**
 * ACTIVE users of the tenant holding `permission` with a grant covering
 * `location` (geography, station code and cycle rules as in RbacGuard).
 */
export async function usersWithPermission(
  tx: TenantTx,
  permission: PermissionKey,
  location: GeoLocation,
  opts: { only?: string[]; limit?: number } = {},
): Promise<string[]> {
  const now = new Date();
  const rows = await tx.roleAssignment.findMany({
    where: {
      revokedAt: null,
      validFrom: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      role: { permissions: { some: { permissionKey: permission } } },
      user: { status: 'ACTIVE' },
      ...(opts.only ? { userId: { in: opts.only } } : {}),
    },
    select: {
      userId: true,
      scopeType: true,
      geographicUnitId: true,
      pollingStationId: true,
      pollingStationCode: true,
      electionCycleId: true,
      expiresAt: true,
      pollingStation: { select: { code: true, electionCycleId: true } },
    },
    take: 5000,
  });
  const byUser = new Map<string, PermissionGrant[]>();
  for (const a of rows) {
    const grants = byUser.get(a.userId) ?? [];
    grants.push({
      permission,
      scopeType: a.scopeType,
      geographicUnitId: a.geographicUnitId,
      pollingStationId: a.pollingStationId,
      pollingStationCode: a.pollingStation ? (a.pollingStationCode ?? a.pollingStation.code) : null,
      pollingStationCycleId: a.pollingStation?.electionCycleId ?? null,
      electionCycleId: a.electionCycleId,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    });
    byUser.set(a.userId, grants);
  }
  const out: string[] = [];
  for (const [userId, grants] of byUser) {
    if (scopeAllows(scopeFromGrants(grants, permission), location)) out.push(userId);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/** Audit history of a set of entity ids, oldest first (request metadata only for audit.view holders). */
export async function auditEventsFor(tx: TenantTx, entityIds: string[], auth: Pick<AuthContext, 'permissions'>): Promise<AuditEvent[]> {
  const showRequestMetadata = auth.permissions.has('audit.view');
  const events = await tx.auditEvent.findMany({
    where: { entityId: { in: entityIds } },
    include: { actor: USER_REF },
    orderBy: { seq: 'asc' },
    take: 2000,
  });
  return events.map((e) => ({
    id: e.id,
    seq: e.seq.toString(),
    actor: e.actor,
    actorType: e.actorType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeHash: e.beforeHash,
    afterHash: e.afterHash,
    before: e.before,
    after: e.after,
    reason: e.reason,
    sourceIp: showRequestMetadata ? e.sourceIp : null,
    userAgent: showRequestMetadata ? e.userAgent : null,
    requestId: e.requestId,
    eventHash: e.eventHash,
    occurredAt: e.occurredAt.toISOString(),
  }));
}

/** Short-lived signed URL for a field file, audited as FILE_SOURCE_ACCESSED on the field record. */
export async function issueFieldFileUrl(
  tx: TenantTx,
  deps: { storage: StorageService; audit: AuditService },
  input: {
    tenantId: string;
    file: { id: string; storageKey: string; originalFilename: string; mimeType: string; sha256: string };
    entityType: string;
    entityId: string;
    download: boolean;
  },
): Promise<SignedUrlResponse> {
  const disposition = input.download ? 'attachment' : 'inline';
  const { url, expiresAt } = await deps.storage.signedUrl(input.file, disposition);
  await deps.audit.record(
    {
      tenantId: input.tenantId,
      action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
      entityType: input.entityType,
      entityId: input.entityId,
      after: { storedFileId: input.file.id, sha256: input.file.sha256, disposition },
    },
    tx,
  );
  return { url, expiresAt: expiresAt.toISOString(), sha256: input.file.sha256 };
}

export const DownloadQuerySchema = z.object({
  download: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

/** Case-insensitive contains filter (Prisma). */
export function contains(q: string): Prisma.StringFilter {
  return { contains: q, mode: 'insensitive' };
}

/** Polls close at 17:00 Africa/Nairobi (14:00 UTC) on election day (blueprint 7.2 "form expected"). */
export function pollsClosed(electionDate: Date, now = new Date()): boolean {
  const close = new Date(Date.UTC(electionDate.getUTCFullYear(), electionDate.getUTCMonth(), electionDate.getUTCDate(), 14, 0, 0));
  return now.getTime() >= close.getTime();
}

/** Multer upload (memory storage). */
export interface FieldUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Store a field file (evidence or accreditation letter): sniffed images and
 * PDFs only (whatever the declared type), ≤ 25 MB, content-addressed and
 * immutable. Photos are stored as uploaded (gap: EXIF is not stripped yet).
 */
export async function storeFieldFile(
  storage: StorageService,
  tx: TenantTx,
  auth: AuthContext,
  file: FieldUpload | undefined,
  purpose: 'FIELD_EVIDENCE' | 'AGENT_DOCUMENT',
): Promise<{ file: { id: string; sha256: string; mimeType: string; sizeBytes: bigint; uploadedById: string }; duplicate: boolean }> {
  if (!file || !file.buffer || file.buffer.length === 0) throw AppException.validation('Attach a file', [{ path: ['file'], message: 'Required' }]);
  if (file.buffer.length > MAX_SOURCE_FILE_BYTES) throw AppException.validation('Files must be 25 MB or smaller');
  const sniffed = sniffMimeType(file.buffer);
  if (!sniffed || !(ALLOWED_SOURCE_MIME_TYPES as readonly string[]).includes(sniffed)) {
    throw AppException.validation('Upload a JPEG, PNG, WebP, HEIC image or a PDF');
  }
  return storage.storeImmutable(
    { tenantId: auth.tenantId, uploadedById: auth.userId, buffer: file.buffer, declaredMimeType: sniffed, originalFilename: file.originalname || 'upload', purpose },
    tx,
  );
}
