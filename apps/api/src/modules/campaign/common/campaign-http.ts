/**
 * Request-level helpers shared by the campaign sub-modules: response mapping
 * (geography, files, users), optimistic concurrency, geographic body checks,
 * conditional re-authentication and campaign uploads.
 */
import type { Prisma, StoredFile, TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  CAMPAIGN_UPLOAD_MIME_TYPES,
  type CampaignFile,
  type CampaignGeo,
  ERROR_CODES,
  type GeoRef,
  MAX_CAMPAIGN_FILE_BYTES,
  type PaginationQuery,
  type SignedUrlResponse,
} from '@ngao360/shared';
import { HttpStatus } from '@nestjs/common';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import type { AuditService } from '../../../audit/audit.service';
import { type PermissionScope, pathToUnitIds, scopeAllows } from '../../../rbac/scope';
import { sniffMimeType } from '../../../storage/file-sniff';
import type { StorageService } from '../../../storage/storage.service';

/** Default re-authentication window (seconds), matching REAUTH_WINDOW_SECONDS' default. */
export const CAMPAIGN_REAUTH_WINDOW_SECONDS = Number(process.env.REAUTH_WINDOW_SECONDS ?? 600) || 600;

export interface CampaignUpload {
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

export const GEO_SELECT = { select: { id: true, officialName: true, type: true, path: true } } as const;

export function geoRef(u: { id: string; officialName: string; type: string } | null | undefined): GeoRef | null {
  return u ? ({ id: u.id, name: u.officialName, type: u.type } as GeoRef) : null;
}

/** Geography with ancestors (county first) for detail views. */
export async function campaignGeo(tx: TenantTx, unit: { id: string; officialName: string; type: string; path: string } | null): Promise<CampaignGeo> {
  if (!unit) return { unit: null, ancestors: [] };
  const ids = pathToUnitIds(unit.path).filter((id) => id !== unit.id);
  const rows = ids.length ? await tx.geographicUnit.findMany({ where: { id: { in: ids } }, select: { id: true, officialName: true, type: true } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { unit: geoRef(unit), ancestors: ids.map((id) => geoRef(byId.get(id))).filter((g): g is GeoRef => !!g) };
}

export const FILE_INCLUDE = { include: { uploadedBy: { select: { id: true, displayName: true } } } } as const;

export function campaignFile(f: StoredFile & { uploadedBy: { id: string; displayName: string } }): CampaignFile {
  return {
    id: f.id,
    originalFilename: f.originalFilename,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    sha256: f.sha256,
    malwareScanStatus: f.malwareScanStatus,
    uploadedBy: { id: f.uploadedBy.id, displayName: f.uploadedBy.displayName },
    createdAt: f.createdAt.toISOString(),
  };
}

export function pageArgs(q: Pick<PaginationQuery, 'page' | 'pageSize'>): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

/** 409 CONFLICT with the current version and server state (stale `expectedVersion`). */
export function staleVersion(currentVersion: number, serverState: unknown): AppException {
  return AppException.conflict('This record was changed by someone else. Reload and try again.', { currentVersion, serverState });
}

/** Throws 409 when `expected` differs from `current`. */
export function checkVersion(current: { version: number }, expected: number | undefined, serverState?: unknown): void {
  if (expected !== undefined && current.version !== expected) throw staleVersion(current.version, serverState ?? current);
}

/** Optimistic update result check: 0 rows → 409 with the fresh state. */
export function assertUpdated(count: number, currentVersion: number, serverState?: unknown): void {
  if (count === 0) throw staleVersion(currentVersion, serverState);
}

export function immutable(message: string): AppException {
  return new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, message);
}

/** Conditional re-authentication (sensitive exports): 401 REAUTH_REQUIRED, like the guard. */
export function assertRecentReauth(auth: AuthContext, windowSeconds = CAMPAIGN_REAUTH_WINDOW_SECONDS): Date {
  const now = Math.floor(Date.now() / 1000);
  if (auth.reauthAt === null || now - auth.reauthAt > windowSeconds) {
    throw new AppException(ERROR_CODES.REAUTH_REQUIRED, HttpStatus.UNAUTHORIZED, 'Please confirm your password to continue');
  }
  return new Date(auth.reauthAt * 1000);
}

/** A unit named in a body must exist (400) and be inside the grant (403 OUT_OF_SCOPE). */
export async function assertUnitInScope(tx: TenantTx, scope: PermissionScope, unitId: string | null | undefined, path = 'geographicUnitId'): Promise<void> {
  if (!unitId) return;
  const unit = await tx.geographicUnit.findUnique({ where: { id: unitId }, select: { path: true } });
  if (!unit) throw AppException.validation('Unknown geographic unit', [{ path: [path], message: 'Pick an area of this organisation' }]);
  if (!scopeAllows(scope, { unitIds: pathToUnitIds(unit.path), stationId: null })) throw AppException.outOfScope();
}

/** Prisma filter: rows whose unit is `unitId` or below it. */
export function underUnitWhere(unitId: string): { geographicUnit: { path: { contains: string } } } {
  return { geographicUnit: { path: { contains: `/${unitId}/` } } };
}

/**
 * Store a campaign upload (images and PDFs, ≤ 25 MB, sniffed) with its purpose.
 * Returns the CampaignFile and whether the bytes already existed.
 */
export async function storeCampaignUpload(
  storage: StorageService,
  tx: TenantTx,
  auth: AuthContext,
  file: CampaignUpload | undefined,
  purpose: 'TASK_ATTACHMENT' | 'EVENT_DOCUMENT' | 'FINANCE_DOCUMENT' | 'BREACH_EVIDENCE',
): Promise<{ file: CampaignFile; duplicate: boolean }> {
  if (!file || !file.buffer?.length) throw AppException.validation('Attach a file', [{ path: ['file'], message: 'Required' }]);
  if (file.size > MAX_CAMPAIGN_FILE_BYTES || file.buffer.length > MAX_CAMPAIGN_FILE_BYTES) throw AppException.validation('Files must be 25 MB or smaller');
  const sniffed = sniffMimeType(file.buffer);
  if (!sniffed || !(CAMPAIGN_UPLOAD_MIME_TYPES as readonly string[]).includes(sniffed)) {
    throw AppException.validation('Upload a JPEG, PNG or WebP image or a PDF', [{ path: ['file'], message: 'Unsupported file type' }]);
  }
  const stored = await storage.storeImmutable(
    { tenantId: auth.tenantId, uploadedById: auth.userId, buffer: file.buffer, declaredMimeType: sniffed, originalFilename: file.originalname || 'upload', purpose },
    tx,
  );
  let row = stored.file;
  // Content-addressed storage returns the first uploader's row for identical bytes; the
  // caller can attach it only when they uploaded it with this purpose (assertOwnFiles).
  if (stored.duplicate && (row.uploadedById !== auth.userId || row.purpose !== purpose)) {
    throw AppException.conflict('These exact bytes were already uploaded for another record. Attach a different copy or ask the uploader.', { fileId: row.id });
  }
  const withUser = await tx.storedFile.findUniqueOrThrow({ where: { id: row.id }, ...FILE_INCLUDE });
  row = withUser;
  return { file: campaignFile(withUser), duplicate: stored.duplicate };
}

/** Signed URL for a file attached to a campaign record, audited as FILE_SOURCE_ACCESSED. */
export async function auditedSignedUrl(
  storage: StorageService,
  audit: AuditService,
  tx: TenantTx,
  auth: AuthContext,
  file: Pick<StoredFile, 'id' | 'storageKey' | 'originalFilename' | 'mimeType' | 'sha256'>,
  entity: { type: string; id: string },
  disposition: 'inline' | 'attachment' = 'attachment',
): Promise<SignedUrlResponse> {
  const { url, expiresAt } = await storage.signedUrl(file, disposition);
  await audit.record(
    {
      tenantId: auth.tenantId,
      action: AUDIT_ACTIONS.FILE_SOURCE_ACCESSED,
      entityType: entity.type,
      entityId: entity.id,
      after: { fileId: file.id, sha256: file.sha256, disposition },
    },
    tx,
  );
  return { url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
}

/** Plain JSON for Prisma JSON columns. */
export function asJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
}
