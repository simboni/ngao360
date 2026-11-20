import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, ERROR_CODES } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { isSanitizableImage, sanitizeImage } from '../../../storage/image-sanitize';
import { StorageService } from '../../../storage/storage.service';
import { ENTITY } from '../tally.constants';
import type { UploadedSourceFile } from './submissions.service';

/** Hold reason prefix for a scan an operator declared already redacted (still held until a second person confirms). */
export const DECLARED_REDACTED_PREFIX = 'Operator declared this scan already redacted';

export const declaredRedactedReason = (declarer: string) =>
  `${DECLARED_REDACTED_PREFIX} (${declarer}). It stays not for display until a different person with tally.approve checks it and confirms or attaches a redacted copy; the stored original is never altered.`;

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

  /**
   * Record, in the audit stream, that `auth` declared a stored scan already
   * redacted. The declaration never releases the hold by itself.
   */
  async recordDeclarationInTx(tx: TenantTx, auth: AuthContext, storedFileId: string, holdId: string, statement: string): Promise<void> {
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.FILE_REDACTION_DECLARED,
        entityType: ENTITY.STORED_FILE,
        entityId: storedFileId,
        after: { holdId, declaredById: auth.userId, declaredBy: auth.email, statement },
        reason: statement,
      },
      tx,
    );
  }

  /**
   * Second-person release of a scan the operator declared already redacted:
   * a different person with tally.approve checked it, and the server stores a
   * re-encoded copy without metadata as the displayable copy (PDFs need a
   * redacted copy attached instead). Audited with the reviewer and reason.
   */
  async confirmDeclaredRedaction(auth: AuthContext, submissionId: string, reason: string): Promise<{ holdId: string; redactedSha256: string }> {
    if (reason.trim().length < 10) throw AppException.validation('Give a reason (at least 10 characters) for confirming the redaction');
    const { sub, hold, original } = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.loadHeld(tx, auth, submissionId);
      return { ...s, original: await tx.storedFile.findUniqueOrThrow({ where: { id: s.sub.sourceFileId } }) };
    });
    if (!hold.reason.startsWith(DECLARED_REDACTED_PREFIX)) {
      throw AppException.conflict('This scan was not declared redacted at import; attach a redacted copy instead');
    }
    if (!isSanitizableImage(original.mimeType)) {
      throw AppException.validation(`A ${original.mimeType} scan cannot be re-encoded; attach a redacted copy instead`);
    }
    const copy = await sanitizeImage(await this.storage.readVerified(original), original.mimeType, 20_000);
    return this.attach(auth, sub.id, { buffer: copy.buffer, mimetype: copy.mimeType, originalname: `confirmed-redacted.${copy.extension}`, size: copy.buffer.length }, `Declared redaction confirmed by a second person: ${reason.trim()}`);
  }

  /** Attach the redacted copy of a held submission source image (once), by someone other than the uploader or declarer. */
  async attachRedactedCopy(auth: AuthContext, submissionId: string, file: UploadedSourceFile, reason?: string): Promise<{ holdId: string; redactedSha256: string }> {
    return this.attach(auth, submissionId, file, reason?.trim() ? `Redacted copy attached: ${reason.trim()}` : 'Redacted copy attached; the original stays stored unaltered');
  }

  /** The held submission, refusing the person who uploaded the scan or placed (declared) the hold. */
  private async loadHeld(tx: TenantTx, auth: AuthContext, submissionId: string) {
    const sub = await tx.resultSubmission.findUnique({ where: { id: submissionId }, select: { id: true, sourceFileId: true, submitterId: true, sourceFile: { select: { uploadedById: true } } } });
    if (!sub) throw AppException.notFound('Submission not found');
    const hold = await tx.storedFileDisplayHold.findUnique({
      where: { tenantId_storedFileId: { tenantId: auth.tenantId, storedFileId: sub.sourceFileId } },
    });
    if (!hold) throw AppException.conflict('This source image is not held for redaction');
    if (hold.redactedFileId) throw AppException.conflict('A redacted copy is already attached; holds change only once');
    if ([hold.createdById, sub.submitterId, sub.sourceFile.uploadedById].includes(auth.userId)) {
      throw new AppException(ERROR_CODES.SEPARATION_OF_DUTIES, HttpStatus.FORBIDDEN, 'The person who uploaded a scan or declared it redacted cannot release its display hold', { holdId: hold.id });
    }
    return { sub, hold };
  }

  private async attach(auth: AuthContext, submissionId: string, file: UploadedSourceFile, auditReason: string): Promise<{ holdId: string; redactedSha256: string }> {
    return this.prisma.tenantTx(async (tx) => {
      const { sub, hold } = await this.loadHeld(tx, auth, submissionId);
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
          reason: auditReason,
        },
        tx,
      );
      return { holdId: hold.id, redactedSha256: stored.sha256 };
    });
  }
}
