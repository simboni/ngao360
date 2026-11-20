import { HttpStatus } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, ERROR_CODES, type AuditEvent, type OfficeFile, type PermissionKey, type SignedUrlResponse } from '@ngao360/shared';
import { z } from 'zod';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import type { AuditService } from '../../../audit/audit.service';
import type { PermissionService } from '../../../rbac/permission.service';
import { type GeoLocation, scopeAllows, scopeFromGrants } from '../../../rbac/scope';
import type { StorageService } from '../../../storage/storage.service';

/** Prisma select for a UserRef. */
export const USER_REF = { select: { id: true, displayName: true } } as const;

/** Uploaded multipart file (multer memory storage). */
export interface OfficeUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export function iso(d: Date): string;
export function iso(d: Date | null | undefined): string | null;
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** `@db.Date` column → "YYYY-MM-DD". */
export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** "YYYY-MM-DD" → Date at UTC midnight (for `@db.Date` columns). Undefined stays undefined (no change). */
export function toDbDate(s: string): Date;
export function toDbDate(s: string | null | undefined): Date | null | undefined;
export function toDbDate(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  if (s === null) return null;
  return new Date(`${s}T00:00:00.000Z`);
}

/** Today's date in Africa/Nairobi as "YYYY-MM-DD" (office deadlines are local dates). */
export function nairobiToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Add whole months to a date (UTC), clamping to the month end. */
export function addMonths(d: Date, months: number): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return out;
}

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Decimal column → Money string ("1250000.00" → "1250000.00"), null stays null. */
export function money(v: { toString(): string } | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = v.toString();
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : Number(s).toFixed(2);
}

export function decimalToNumber(v: { toString(): string } | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v.toString());
}

/** Parse a multipart JSON text field with a zod schema (ZodError → 400 VALIDATION_FAILED). */
export function parseJsonField<S extends z.ZodTypeAny>(raw: unknown, schema: S, field: string): z.infer<S> {
  let value: unknown = raw ?? {};
  if (typeof raw === 'string') {
    try {
      value = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      throw AppException.validation(`\`${field}\` must be a JSON string`, [{ path: [field], message: 'Invalid JSON' }]);
    }
  }
  return schema.parse(value);
}

/** Throw 409 CONFLICT when an optimistic update matched no row. */
export function assertUpdated(result: { count: number }, what = 'record'): void {
  if (result.count === 0) {
    throw AppException.conflict(`This ${what} was changed by someone else. Reload and try again.`);
  }
}

/** Prisma select for a stored file as Office screens see it. */
export const OFFICE_FILE_SELECT = {
  select: {
    id: true,
    originalFilename: true,
    mimeType: true,
    sizeBytes: true,
    sha256: true,
    malwareScanStatus: true,
    createdAt: true,
    uploadedById: true,
    uploadedBy: USER_REF,
  },
} as const;

type OfficeFileRow = {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  malwareScanStatus: OfficeFile['malwareScanStatus'];
  createdAt: Date;
  uploadedById: string;
  uploadedBy: { id: string; displayName: string };
};

/** Files received through the public portal (owned by the portal service account) show no uploader. */
export function toOfficeFile(f: OfficeFileRow, portalServiceUserId?: string | null): OfficeFile {
  return {
    id: f.id,
    originalFilename: f.originalFilename,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    sha256: f.sha256,
    malwareScanStatus: f.malwareScanStatus,
    uploadedBy: portalServiceUserId && f.uploadedById === portalServiceUserId ? null : { id: f.uploadedBy.id, displayName: f.uploadedBy.displayName },
    createdAt: f.createdAt.toISOString(),
  };
}

/**
 * Whether `userId` (an ACTIVE user of the tenant of `tx`) holds `permission`,
 * optionally covering `location` (office records: unit ancestry). Used to check
 * assignees before work is routed to them.
 */
export async function userHoldsPermission(
  tx: TenantTx,
  permissions: PermissionService,
  userId: string,
  permission: PermissionKey,
  location?: GeoLocation,
): Promise<boolean> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user || user.status !== 'ACTIVE') return false;
  const { grants } = await permissions.loadGrants(tx, userId);
  const scope = scopeFromGrants(grants, permission);
  if (!scope.held) return false;
  return location ? scopeAllows(scope, location) : true;
}

/** True when the caller's grant of `permission` covers `location`. */
export function callerCovers(permissions: PermissionService, auth: AuthContext, permission: PermissionKey, location: GeoLocation): boolean {
  return scopeAllows(permissions.scopeFor(auth, permission), location);
}

/** In-app notification for an Office user (contains no requester personal data). */
export async function notifyUser(
  tx: TenantTx,
  input: { tenantId: string; userId: string; type: string; title: string; body: string; link: string },
): Promise<void> {
  await tx.notification.create({
    data: { tenantId: input.tenantId, userId: input.userId, channel: 'IN_APP', module: 'office', type: input.type, title: input.title, body: input.body, link: input.link },
  });
}

/** Audit events for a set of entity ids, oldest first (record history endpoints). */
export async function auditEventsFor(tx: TenantTx, entityIds: string[]): Promise<AuditEvent[]> {
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
    sourceIp: e.sourceIp,
    userAgent: e.userAgent,
    requestId: e.requestId,
    eventHash: e.eventHash,
    occurredAt: e.occurredAt.toISOString(),
  }));
}

/** Issue a signed URL for an Office file and audit FILE_SOURCE_ACCESSED (entityType = the Office record). */
export async function issueOfficeFileUrl(
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

/** Changed scalar fields between a row and a patch (for audit snapshots of changed fields only). */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<Record<keyof T, unknown>>,
): { before: Record<string, unknown>; after: Record<string, unknown>; keys: string[] } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' && 'toFixed' in (v as object) ? String(v) : v);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prev = norm(before[k]);
    const next = norm(v);
    if (JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null)) {
      b[k] = prev ?? null;
      a[k] = next ?? null;
    }
  }
  return { before: b, after: a, keys: Object.keys(a) };
}

/** Pagination arithmetic shared by list endpoints. */
export function paging(q: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export const DownloadQuerySchema = z.object({
  download: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

/** 409 IMMUTABLE_RECORD for records whose state forbids changes. */
export function immutableRecord(message: string): AppException {
  return new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, message);
}
