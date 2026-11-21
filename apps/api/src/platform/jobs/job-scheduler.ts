/**
 * Durable repeatable jobs (BullMQ) with a `job_runs` record per run. Owner: platform-infra.
 *
 * Modules register a handler under a JOB_KEYS key at bootstrap:
 *
 *   scheduler.register({ key: JOB_KEYS.OFFICE_RETENTION, everyMs: 6 * 3600_000,
 *                        handler: async (ctx) => ({ contactsErased: 2 }) });
 *
 * With QUEUES_ENABLED and JOBS_ENABLED the scheduler adds one BullMQ repeatable job per key on the
 * `platform-jobs` queue (one schedule across all API instances; BullMQ hands each run to exactly
 * one worker). Every run, scheduled or `runNow`, is recorded in job_runs: RUNNING at start, then
 * SUCCEEDED with counts or FAILED with the error message. A failed run is retried by BullMQ with
 * backoff and appears as a new run record. Handlers must be idempotent.
 *
 * Without Redis (QUEUES_ENABLED=false or JOBS_ENABLED=false) nothing is scheduled; `runNow` still
 * works (tests, the S30 "run now" action, an external scheduler).
 */
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { AppConfig } from '../../config/app-config';
import { PLATFORM_JOBS_QUEUE } from '../../queue/queue.constants';
import { type JobCounts, JobRunRecorder } from './job-run-recorder';

export interface JobContext {
  jobKey: string;
  /** Null for platform-wide runs (iterate tenants inside the handler, one withTenant() each). */
  tenantId: string | null;
  runId: string;
  scheduledFor: Date | null;
}

export interface JobDefinition {
  key: string;
  /** Repeat interval. 0 or undefined = run only on demand. */
  everyMs?: number;
  /** Tenant-scoped definition (rare); most jobs are platform-wide and loop over tenants. */
  tenantId?: string | null;
  handler: (ctx: JobContext) => Promise<JobCounts | void>;
}

export interface JobRunOutcome {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED';
  counts: JobCounts;
  error: string | null;
}

@Injectable()
export class JobScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobScheduler.name);
  private readonly definitions = new Map<string, JobDefinition>();
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly recorder: JobRunRecorder,
  ) {}

  get enabled(): boolean {
    return this.config.values.QUEUES_ENABLED && this.config.values.JOBS_ENABLED;
  }

  register(def: JobDefinition): void {
    if (this.definitions.has(def.key)) throw new Error(`Job ${def.key} is already registered`);
    this.definitions.set(def.key, def);
    if (this.started) void this.schedule(def);
  }

  registered(): JobDefinition[] {
    return [...this.definitions.values()];
  }

  /** Run a job now, in process, with a run record. Never throws for handler errors. */
  async runNow(key: string, opts: { queueJobId?: string | null; scheduledFor?: Date | null } = {}): Promise<JobRunOutcome> {
    const def = this.definitions.get(key);
    if (!def) throw new Error(`Unknown job ${key}`);
    const tenantId = def.tenantId ?? null;
    const runId = await this.recorder.start(key, { tenantId, queueJobId: opts.queueJobId ?? null, scheduledFor: opts.scheduledFor ?? null });
    try {
      const counts = (await def.handler({ jobKey: key, tenantId, runId, scheduledFor: opts.scheduledFor ?? null })) ?? {};
      await this.recorder.finish(runId, tenantId, { status: 'SUCCEEDED', counts });
      return { runId, status: 'SUCCEEDED', counts, error: null };
    } catch (err) {
      const error = (err as Error).message ?? 'Job failed';
      this.logger.error(`Job ${key} run ${runId} failed: ${error}`);
      await this.recorder.finish(runId, tenantId, { status: 'FAILED', error });
      return { runId, status: 'FAILED', counts: {}, error };
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    this.started = true;
    for (const def of this.definitions.values()) await this.schedule(def);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Queue and worker are created on the first scheduled definition (none => no Redis connection). */
  private ensureWorker(): Queue | null {
    if (!this.enabled) return null;
    if (this.queue) return this.queue;
    const connection = this.connection();
    this.queue = new Queue(PLATFORM_JOBS_QUEUE, { connection, prefix: 'ngao360' });
    this.worker = new Worker(
      PLATFORM_JOBS_QUEUE,
      async (job) => {
        const outcome = await this.runNow(job.name, { queueJobId: job.id ?? null, scheduledFor: job.timestamp ? new Date(job.timestamp) : null });
        // Throw so BullMQ applies its retry/backoff; the failed run is already recorded.
        if (outcome.status === 'FAILED') throw new Error(outcome.error ?? 'Job failed');
        return outcome.counts;
      },
      { connection, prefix: 'ngao360', concurrency: 1 },
    );
    this.worker.on('error', (err) => this.logger.error(`Job worker error: ${err.message}`));
    return this.queue;
  }

  private async schedule(def: JobDefinition): Promise<void> {
    if (!def.everyMs) return;
    const queue = this.ensureWorker();
    if (!queue) return;
    await queue.upsertJobScheduler(
      def.key,
      { every: def.everyMs },
      { name: def.key, opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  private connection(): ConnectionOptions {
    const url = new URL(this.config.values.REDIS_URL);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
  }
}
