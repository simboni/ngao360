import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@ngao360/shared';
import { Redis } from 'ioredis';
import { Public } from '../common/decorators/auth.decorators';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

async function timed(fn: () => Promise<unknown>): Promise<{ status: 'up' | 'down'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - start, error: err instanceof Error ? err.message.slice(0, 200) : 'error' };
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async health(): Promise<HealthResponse> {
    const checks: HealthResponse['checks'] = {
      database: await timed(() => this.prisma.client.$queryRaw`SELECT 1`),
      storage: await timed(() => this.storage.healthCheck()),
    };
    if (this.config.values.QUEUES_ENABLED) {
      checks.redis = await timed(async () => {
        const redis = new Redis(this.config.values.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
        try {
          await redis.connect();
          await redis.ping();
        } finally {
          redis.disconnect();
        }
      });
    }
    const down = Object.values(checks).filter((c) => c.status === 'down').length;
    return {
      status: down === 0 ? 'ok' : checks.database?.status === 'down' ? 'down' : 'degraded',
      version: process.env.npm_package_version ?? '0.1.0',
      checks,
      time: new Date().toISOString(),
    };
  }
}
