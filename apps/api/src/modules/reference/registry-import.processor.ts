import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { REGISTRY_IMPORT_QUEUE, type RegistryImportJobData } from '../../queue/queue.constants';
import { RegistryService } from './registry.service';

/** Background registry imports (files above REGISTRY_IMPORT_SYNC_ROW_LIMIT rows). */
@Processor(REGISTRY_IMPORT_QUEUE)
export class RegistryImportProcessor extends WorkerHost {
  private readonly logger = new Logger(RegistryImportProcessor.name);

  constructor(private readonly registry: RegistryService) {
    super();
  }

  async process(job: Job<RegistryImportJobData>): Promise<void> {
    this.logger.log(`Registry import started for version ${job.data.registryVersionId}`);
    await this.registry.runQueuedImport(job.data);
  }
}
