import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { OcrQueueService } from './ocr-queue.service';
import { OcrProcessor } from './ocr.processor';
import { OCR_QUEUE } from './queue.constants';

function queuesEnabled(): boolean {
  const v = process.env.QUEUES_ENABLED;
  return v === undefined || ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** BullMQ registration. Add new queues here (one shared place) to avoid collisions. */
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
        BullModule.registerQueue({ name: OCR_QUEUE }),
      ],
      providers: [OcrQueueService, OcrProcessor],
      exports: [OcrQueueService, BullModule],
    };
  }
}
