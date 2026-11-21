import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type CaseAcknowledgementJobData, CaseAcknowledgementService } from '../platform/messaging/case-acknowledgement.service';
import { NOTIFICATION_QUEUE } from './queue.constants';

/**
 * Worker for the `notifications` queue. Today it carries Office portal acknowledgements
 * (`office.case.acknowledgement`, ids only), which become one outbox message each; the outbox
 * dispatcher then sends them with retries and a dead letter. Unknown job names fail loudly so a
 * new producer cannot be silently dropped. Owner: platform-infra.
 */
@Processor(NOTIFICATION_QUEUE)
export class NotificationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationQueueProcessor.name);

  constructor(private readonly moduleRef: ModuleRef) {
    super();
  }

  async process(job: Job<CaseAcknowledgementJobData>): Promise<void> {
    if (job.name !== 'office.case.acknowledgement') throw new Error(`Unknown notification job ${job.name}`);
    const r = await this.moduleRef.get(CaseAcknowledgementService, { strict: false }).enqueue(job.data);
    this.logger.log(`Case acknowledgement for ${job.data.caseId}: ${r ? `${r.status} ${r.messageId}` : 'nothing to send'}`);
  }
}
