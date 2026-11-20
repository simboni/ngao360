import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OCR_QUEUE, type OcrJobData } from './queue.constants';

/**
 * Enqueue OCR draft-extraction jobs. When queues are disabled (QUEUES_ENABLED=false)
 * this is a no-op that reports `enqueued: false`, and callers should mark the
 * extraction NOT_CONFIGURED. OCR output is always a draft (blueprint 8.2 step 4).
 */
@Injectable()
export class OcrQueueService {
  private readonly logger = new Logger(OcrQueueService.name);

  constructor(@Optional() @InjectQueue(OCR_QUEUE) private readonly queue?: Queue<OcrJobData>) {}

  get enabled(): boolean {
    return !!this.queue;
  }

  async enqueue(data: OcrJobData): Promise<{ enqueued: boolean }> {
    if (!this.queue) {
      this.logger.debug(`Queues disabled; OCR not enqueued for ${data.submissionId}`);
      return { enqueued: false };
    }
    await this.queue.add('extract', data, {
      jobId: data.extractionId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
    return { enqueued: true };
  }
}
