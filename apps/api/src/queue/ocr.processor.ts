import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { OCR_QUEUE, type OcrJobData } from './queue.constants';

/**
 * OCR worker STUB. No OCR engine is configured in the foundation: the job marks
 * the extraction NOT_CONFIGURED so the clerk captures every value manually.
 * A self-hosted engine can be plugged in here later (blueprint 13.1); its output
 * must be written as ResultValue.ocrValue/ocrConfidence only, never as confirmed values.
 */
@Processor(OCR_QUEUE)
export class OcrProcessor extends WorkerHost {
  private readonly logger = new Logger(OcrProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<OcrJobData>): Promise<void> {
    const { tenantId, extractionId } = job.data;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.ocrExtraction.update({
        where: { id: extractionId },
        data: {
          status: 'NOT_CONFIGURED',
          engine: null,
          completedAt: new Date(),
          error: 'No OCR engine configured; manual capture required',
        },
      }),
    );
    this.logger.log(`OCR stub processed extraction ${extractionId}`);
  }
}
