import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, ERROR_CODES } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../storage/storage.service';
import { ENTITY } from '../tally.constants';
import type { UploadedSourceFile } from './submissions.service';

export const NOT_FOR_DISPLAY_REASON =
  'Real result-form scan: presiding officers’ and agents’ names and signatures are personal data (Data Protection Act 2019). ' +
  'Not for display until a redacted copy is attached; the stored original is never altered.';

/**
 * "Not for display until redacted" holds on stored result-form images
 * (docs/DEMO_2022.md). A held original is never served; once a redacted copy
 * is attached (stored immutably, SHA-256), viewers get the copy instead.
 */
@Injectable()
export class DisplayHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /** Mark a stored file "not for display until redacted" (idempotent). */
  async holdInTx(tx: TenantTx, auth: AuthContext, storedFileId: string, reason = NOT_FOR_DISPLAY_REASON): Promise<{ id: string; created: boolean }> {
    const existing = await tx.storedFileDisplayHold.findUnique({
      where: { tenantId_storedFileId: { tenantId: auth.tenantId, storedFileId } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
    const hold = await tx.storedFileDisplayHold.create({
      data: { tenantId: auth.tenantId, storedFileId, reason, createdById: auth.userId },
      select: { id: true },
    });
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.FILE_DISPLAY_HOLD_CREATED,
        entityType: ENTITY.STORED_FILE,
        entityId: storedFileId,
        after: { holdId: hold.id, reason },
        reason,
      },
      tx,
    );
    return { id: hold.id, created: true };
  }

  /**
   * The file a viewer may see for `storedFileId`: the file itself, its redacted
   * copy, or a refusal while the original is held without one.
   */
  async displayableInTx(tx: TenantTx, tenantId: string, storedFileId: string) {
    const hold = await tx.storedFileDisplayHold.findUnique({
      where: { tenantId_storedFileId: { tenantId, storedFileId } },
      include: { redactedFile: true },
    });
    if (!hold) return { file: null, redactedCopy: false } as const;
    if (!hold.redactedFile) {
      throw new AppException(
        ERROR_CODES.NOT_FOR_DISPLAY_UNTIL_REDACTED,
        HttpStatus.FORBIDDEN,
        'This scan may show officers’ and agents’ names and signatures, so it is not shown until a redacted copy is attached.',
        { storedFileId, holdId: hold.id },
      );
    }
    return { file: hold.redactedFile, redactedCopy: true } as const;
  }

  /** Attach the redacted copy of a held submission source image (once). */
  async attachRedactedCopy(auth: AuthContext, submissionId: string, file: UploadedSourceFile): Promise<{ holdId: string; redactedSha256: string }> {
    return this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({ where: { id: submissionId }, select: { id: true, sourceFileId: true } });
      if (!sub) throw AppException.notFound('Submission not found');
      const hold = await tx.storedFileDisplayHold.findUnique({
        where: { tenantId_storedFileId: { tenantId: auth.tenantId, storedFileId: sub.sourceFileId } },
      });
      if (!hold) throw AppException.conflict('This source image is not held for redaction');
      if (hold.redactedFileId) throw AppException.conflict('A redacted copy is already attached; holds change only once');
      const { file: stored } = await this.storage.storeImmutable(
        {
          tenantId: auth.tenantId,
          uploadedById: auth.userId,
          buffer: file.buffer,
          declaredMimeType: file.mimetype,
          originalFilename: file.originalname,
          purpose: 'RESULT_FORM',
        },
        tx,
      );
      if (stored.id === sub.sourceFileId) throw AppException.validation('The redacted copy is identical to the original');
      await tx.storedFileDisplayHold.update({
        where: { id: hold.id },
        data: { redactedFileId: stored.id, redactedById: auth.userId, redactedAt: new Date() },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.FILE_REDACTED_COPY_ATTACHED,
          entityType: ENTITY.STORED_FILE,
          entityId: sub.sourceFileId,
          before: { redactedFileId: null },
          after: { holdId: hold.id, redactedFileId: stored.id, redactedSha256: stored.sha256, submissionId },
          reason: 'Redacted copy attached; the original stays stored unaltered',
        },
        tx,
      );
      return { holdId: hold.id, redactedSha256: stored.sha256 };
    });
  }
}
