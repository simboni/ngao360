import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { OcrQueueService } from './ocr-queue.service';
import { NotificationQueueProcessor } from './notification.processor';
import { OcrProcessor } from './ocr.processor';
import { runsWorkers } from './process-role';
import { ALL_QUEUES } from './queue.constants';

function queuesEnabled(): boolean {
  const v = process.env.QUEUES_ENABLED;
  return v === undefined || ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * BullMQ registration. Queues are declared in queue.constants.ts. Modules inject
 * a queue with @InjectQueue(NAME) (mark it @Optional() so the API still runs with
 * QUEUES_ENABLED=false) and provide their own @Processor in their module.
 */
@Global()
@Module({})
export class QueueModule {
  static register(): DynamicModule {
    if (!queuesEnabled()) {
      return { module: QueueModule, providers: [OcrQueueService], exports: [OcrQueueService] };
    }
    return {
      module: QueueModule,
      imports: [
        BullModule.forRootAsync({
          inject: [AppConfig],
          useFactory: (config: AppConfig) => {
            const url = new URL(config.values.REDIS_URL);
            return {
              connection: {
                host: url.hostname,
                port: Number(url.port || 6379),
                ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
                ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
                ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
                maxRetriesPerRequest: null,
              },
              prefix: 'ngao360',
            };
          },
        }),
        BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
      ],
      // PROCESS_ROLE=api registers the queues (producers) but no processors: a worker process consumes them.
      providers: [OcrQueueService, ...(runsWorkers() ? [OcrProcessor, NotificationQueueProcessor] : [])],
      exports: [OcrQueueService, BullModule],
    };
  }
}
