import { Inject, Injectable } from '@nestjs/common';
import { sha256Hex, type StoredFile, type StoredFilePurpose, type TenantTx } from '@ngao360/db';
import { ALLOWED_SOURCE_MIME_TYPES, AUDIT_ACTIONS, MAX_SOURCE_FILE_BYTES } from '@ngao360/shared';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/app-config';
import { AppException } from '../common/http/app-exception';
import { sniffMimeType } from './file-sniff';
import { STORAGE_DRIVER, type StorageDriver } from './storage.types';

export interface StoreFileInput {
  tenantId: string;
  uploadedById: string;
  buffer: Buffer;
  declaredMimeType: string;
  originalFilename: string;
  purpose: StoredFilePurpose;
  pageCount?: number | null;
}

export interface StoreFileResult {
  file: StoredFile;
  /** True when an identical file (same SHA-256) already existed for this tenant. */
  duplicate: boolean;
}

/**
 * Immutable original-file storage. Files are content-addressed by SHA-256 and
 * never overwritten or deleted; the `stored_files` row is protected by a DB trigger.
 * A matching hash returns the existing row with `duplicate: true` so callers can
 * flag potential duplicates for review (never silently discard).
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  get driverKind(): 'LOCAL' | 'S3' {
    return this.driver.kind;
  }

  static keyFor(tenantId: string, sha256: string): string {
    return `tenants/${tenantId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
  }

  validateUpload(input: Pick<StoreFileInput, 'buffer' | 'declaredMimeType' | 'purpose'>): string {
    if (input.buffer.length === 0) throw AppException.validation('The file is empty');
    if (input.buffer.length > MAX_SOURCE_FILE_BYTES) {
      throw AppException.validation(`Files must be ${MAX_SOURCE_FILE_BYTES / (1024 * 1024)} MB or smaller`);
    }
    if (input.purpose === 'RESULT_FORM' || input.purpose === 'EVIDENCE') {
      const sniffed = sniffMimeType(input.buffer);
      if (!sniffed || !(ALLOWED_SOURCE_MIME_TYPES as readonly string[]).includes(sniffed)) {
        throw AppException.validation('Upload a JPEG, PNG, WebP, HEIC image or a PDF');
      }
      return sniffed;
    }
    return input.declaredMimeType;
  }

  /** Store a file (inside the caller's tenant transaction) and audit it. */
  async storeImmutable(input: StoreFileInput, tx: TenantTx): Promise<StoreFileResult> {
    const mimeType = this.validateUpload(input);
    const sha256 = sha256Hex(input.buffer);
    const existing = await tx.storedFile.findUnique({
      where: { tenantId_sha256: { tenantId: input.tenantId, sha256 } },
    });
    if (existing) return { file: existing, duplicate: true };

    const storageKey = StorageService.keyFor(input.tenantId, sha256);
    await this.driver.putIfAbsent(storageKey, input.buffer, mimeType);
    const file = await tx.storedFile.create({
      data: {
        tenantId: input.tenantId,
        sha256,
        mimeType,
        sizeBytes: BigInt(input.buffer.length),
        originalFilename: input.originalFilename.slice(0, 255),
        purpose: input.purpose,
        storageDriver: this.driver.kind,
        storageKey,
        pageCount: input.pageCount ?? null,
        malwareScanStatus: 'PENDING',
        uploadedById: input.uploadedById,
      },
    });
    await this.audit.record(
      {
        tenantId: input.tenantId,
        actorId: input.uploadedById,
        action: AUDIT_ACTIONS.FILE_STORED,
        entityType: 'StoredFile',
        entityId: file.id,
        after: { sha256, mimeType, sizeBytes: input.buffer.length, purpose: input.purpose },
      },
      tx,
    );
    return { file, duplicate: false };
  }

  /** Read a stored file and verify its SHA-256 still matches (integrity check). */
  async readVerified(file: Pick<StoredFile, 'storageKey' | 'sha256'>): Promise<Buffer> {
    const buf = await this.driver.get(file.storageKey);
    if (sha256Hex(buf) !== file.sha256) {
      throw new Error(`Integrity check failed for ${file.storageKey}`);
    }
    return buf;
  }

  /** Short-lived signed URL. Callers must check permission and audit FILE_SOURCE_ACCESSED. */
  signedUrl(
    file: Pick<StoredFile, 'storageKey' | 'originalFilename' | 'mimeType'>,
    disposition: 'inline' | 'attachment' = 'inline',
  ): Promise<{ url: string; expiresAt: Date }> {
    const ttl = this.config.values.SIGNED_URL_TTL_SECONDS;
    return this.driver
      .signedUrl(file.storageKey, {
        ttlSeconds: ttl,
        filename: file.originalFilename,
        mimeType: file.mimeType,
        disposition,
      })
      .then((url) => ({ url, expiresAt: new Date(Date.now() + ttl * 1000) }));
  }

  healthCheck(): Promise<void> {
    return this.driver.healthCheck();
  }
}
