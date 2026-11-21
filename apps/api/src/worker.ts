import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * Background worker entrypoint (`node dist/worker.js`): the same application graph as the API but
 * without an HTTP listener. It runs the BullMQ processors (OCR, registry import, notifications)
 * and the durable `platform-jobs` worker (outbox dispatch, malware scans, retention, the War Room
 * recorder, comparison retries, reminders). Pair it with API processes started with
 * PROCESS_ROLE=api so request handling never competes with background work.
 *
 * Liveness: the worker touches WORKER_HEARTBEAT_FILE (default /tmp/ngao360-worker.alive) every
 * 15 s; the container health check fails when the file is older than 60 s.
 */
async function bootstrap(): Promise<void> {
  process.env.PROCESS_ROLE = 'worker';
  // Module files read PROCESS_ROLE when they load, so import the app only after setting it.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  const file = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/ngao360-worker.alive';
  const beat = (): void => {
    try {
      writeFileSync(file, new Date().toISOString());
    } catch (err) {
      Logger.warn(`Cannot write heartbeat ${file}: ${(err as Error).message}`, 'Worker');
    }
  };
  beat();
  const timer = setInterval(beat, 15_000);
  timer.unref();
  Logger.log('NGAO360 worker started (no HTTP listener)', 'Worker');
}

if (require.main === module) {
  bootstrap().catch((err: Error) => {
    Logger.error(`Worker failed to start: ${err.message}`, 'Worker');
    process.exit(1);
  });
}
