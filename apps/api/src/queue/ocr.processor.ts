import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TallyOcrService } from '../modules/tally/ocr/ocr.service';
import { OCR_QUEUE, type OcrJobData } from './queue.constants';

/**
 * OCR worker. Routes each job through the pluggable tally OCR provider
 * (OCR_PROVIDER=none|stub). Output is written as ResultValue.ocrValue /
 * ocrConfidence drafts only, never as confirmed values. With the default
 * provider "none" the extraction is marked NOT_CONFIGURED and the clerk
 * captures every value manually.
 */
@Processor(OCR_QUEUE)
export class OcrProcessor extends WorkerHost {
  private readonly logger = new Logger(OcrProcessor.name);

  constructor(private readonly moduleRef: ModuleRef) {
    super();
  }

  async process(job: Job<OcrJobData>): Promise<void> {
    const { tenantId, extractionId } = job.data;
    await this.moduleRef.get(TallyOcrService, { strict: false }).process(tenantId, extractionId);
    this.logger.log(`OCR processed extraction ${extractionId}`);
  }
}
