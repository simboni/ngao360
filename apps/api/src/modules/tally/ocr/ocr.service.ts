import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@ngao360/db';
import { AUDIT_ACTIONS, FormFieldSchemaSchema, type OcrExtraction } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { OcrQueueService } from '../../../queue/ocr-queue.service';
import { StorageService } from '../../../storage/storage.service';
import { toOcr } from '../services/mappers';
import { TallyWorkflowService } from '../services/tally-workflow.service';
import { ENTITY } from '../tally.constants';
import { OCR_PROVIDER, type OcrProvider } from './ocr-provider';

/** Audit action for recording an OCR draft. */
export const OCR_RECORDED_ACTION = AUDIT_ACTIONS.OCR_RECORDED;

/**
 * Runs OCR draft extraction through the configured provider. Output is written
 * only to ResultValue.ocrValue / ocrConfidence and is never a confirmed value.
 * Jobs go to the OCR queue; when queues are disabled the extraction runs in
 * process after the submission transaction commits.
 */
@Injectable()
export class TallyOcrService {
  private readonly logger = new Logger(TallyOcrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: OcrQueueService,
    private readonly audit: AuditService,
    private readonly workflow: TallyWorkflowService,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
  ) {}

  /** Call after the creating transaction has committed. */
  async dispatch(tenantId: string, submissionId: string, extractionId: string): Promise<void> {
    try {
      const { enqueued } = await this.queue.enqueue({ tenantId, submissionId, extractionId });
      if (!enqueued) await this.process(tenantId, extractionId);
    } catch (err) {
      this.logger.error(`OCR dispatch failed for ${extractionId}: ${(err as Error).message}`);
    }
  }

  /** Execute one extraction (queue worker entry point; see docs/CHANGE_REQUESTS.md). */
  async process(tenantId: string, extractionId: string): Promise<void> {
    const ext = await this.prisma.withTenant(tenantId, (tx) =>
      tx.ocrExtraction.findUnique({
        where: { id: extractionId },
        include: {
          submission: {
            select: {
              id: true,
              tenantId: true,
              status: true,
              version: true,
              sourceFile: { select: { storageKey: true, sha256: true, mimeType: true } },
              formTemplate: { select: { fieldSchema: true } },
              contest: { select: { candidates: { select: { id: true }, orderBy: { ballotOrder: 'asc' } } } },
            },
          },
        },
      }),
    );
    if (!ext || ext.status === 'COMPLETED' || ext.status === 'NOT_CONFIGURED') return;

    if (!this.provider.configured) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.ocrExtraction.update({
          where: { id: extractionId },
          data: {
            status: 'NOT_CONFIGURED',
            engine: this.provider.name,
            completedAt: new Date(),
            error: 'No OCR engine configured; manual capture required',
          },
        }),
      );
      return;
    }

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.ocrExtraction.update({ where: { id: extractionId }, data: { status: 'RUNNING', startedAt: new Date() } }),
    );
    try {
      const sub = ext.submission;
      const buffer = await this.storage.readVerified(sub.sourceFile);
      const result = await this.provider.extract({
        submissionId: sub.id,
        file: { sha256: sub.sourceFile.sha256, mimeType: sub.sourceFile.mimeType, buffer },
        fieldSchema: FormFieldSchemaSchema.parse(sub.formTemplate.fieldSchema),
        candidateIds: sub.contest.candidates.map((c) => c.id),
      });
      await this.prisma.withTenant(tenantId, async (tx) => {
        for (const f of result.fields) {
          const existing = await tx.resultValue.findFirst({
            where: { submissionId: sub.id, fieldKey: f.fieldKey, candidateReferenceId: f.candidateReferenceId },
            select: { id: true },
          });
          const confidence = new Prisma.Decimal(Math.min(1, Math.max(0, f.confidence)).toFixed(4));
          if (existing) {
            await tx.resultValue.update({
              where: { id: existing.id },
              data: { ocrValue: f.value, ocrConfidence: confidence },
            });
          } else {
            await tx.resultValue.create({
              data: {
                tenantId,
                submissionId: sub.id,
                fieldKey: f.fieldKey,
                candidateReferenceId: f.candidateReferenceId,
                ocrValue: f.value,
                ocrConfidence: confidence,
              },
            });
          }
        }
        await tx.ocrExtraction.update({
          where: { id: extractionId },
          data: {
            status: 'COMPLETED',
            engine: result.engine,
            engineVersion: result.engineVersion,
            resultJson: result as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
            error: null,
          },
        });
        await this.audit.record(
          {
            tenantId,
            actorId: null,
            actorType: 'SYSTEM',
            action: OCR_RECORDED_ACTION,
            entityType: ENTITY.OCR,
            entityId: extractionId,
            after: { submissionId: sub.id, engine: result.engine, fields: result.fields.length, draft: true },
          },
          tx,
        );
        const fresh = await tx.resultSubmission.findUnique({
          where: { id: sub.id },
          select: { id: true, tenantId: true, status: true, version: true },
        });
        if (fresh && fresh.status === 'SUBMITTED') {
          await this.workflow.transition(tx, fresh, 'OCR_COMPLETE', 'OCR draft extraction completed', {}, null);
        }
      });
    } catch (err) {
      this.logger.warn(`OCR extraction ${extractionId} failed: ${(err as Error).message}`);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.ocrExtraction.update({
          where: { id: extractionId },
          data: { status: 'FAILED', completedAt: new Date(), error: (err as Error).message.slice(0, 1000) },
        }),
      );
    }
  }

  get(submissionId: string): Promise<OcrExtraction | null> {
    return this.prisma.tenantTx(async (tx) => {
      const o = await tx.ocrExtraction.findFirst({ where: { submissionId }, orderBy: { queuedAt: 'desc' } });
      return o ? toOcr(o) : null;
    });
  }

  /** POST /tally/submissions/:id/ocr/retry */
  async retry(auth: AuthContext, submissionId: string): Promise<OcrExtraction> {
    const ext = await this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({ where: { id: submissionId }, select: { id: true, status: true } });
      if (!sub) throw AppException.notFound('Submission not found');
      if (!['SUBMITTED', 'OCR_COMPLETE', 'RETURNED', 'DATA_ENTRY_REVIEWED'].includes(sub.status)) {
        throw AppException.conflict('OCR can only be retried before the submission is sent for second review');
      }
      const running = await tx.ocrExtraction.findFirst({
        where: { submissionId, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (running) return running;
      const created = await tx.ocrExtraction.create({ data: { tenantId: auth.tenantId, submissionId, status: 'QUEUED' } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: OCR_RECORDED_ACTION,
          entityType: ENTITY.OCR,
          entityId: created.id,
          after: { submissionId, status: 'QUEUED', retry: true },
        },
        tx,
      );
      return created;
    });
    if (ext.status === 'QUEUED') await this.dispatch(auth.tenantId, submissionId, ext.id);
    return this.prisma.tenantTx(async (tx) => toOcr((await tx.ocrExtraction.findUnique({ where: { id: ext.id } }))!));
  }
}
