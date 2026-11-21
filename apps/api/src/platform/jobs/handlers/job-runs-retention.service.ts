/**
 * `platform.job_runs_retention`: deletes finished `job_runs` rows older than JOB_RUNS_RETENTION_DAYS
 * (default 90, at least 7). Daily, durable (BullMQ, one run across API instances), and recorded in
 * job_runs itself like every other job.
 *
 * Deletion goes only through the SECURITY DEFINER function ngao_purge_job_runs() (migration
 * 20261201000100): the runtime role has no DELETE privilege on job_runs, the guard trigger still
 * refuses any other DELETE, RUNNING rows are never deleted, and nothing younger than 7 days can be
 * deleted whatever the configuration says. Batches of 5 000 keep each statement short.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JOB_KEYS } from '@ngao360/shared';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../prisma/prisma.service';
import { JobScheduler } from '../job-scheduler';

export const JOB_RUNS_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const BATCH = 5000;
/** Upper bound of batches per run, so one run never holds the worker for long. */
const MAX_BATCHES = 200;

@Injectable()
export class JobRunsRetentionService implements OnModuleInit {
  private readonly logger = new Logger(JobRunsRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobScheduler,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.jobs.registered().some((d) => d.key === JOB_KEYS.JOB_RUNS_RETENTION)) return;
    this.jobs.register({ key: JOB_KEYS.JOB_RUNS_RETENTION, everyMs: JOB_RUNS_RETENTION_INTERVAL_MS, handler: () => this.run() });
  }

  /** Cut-off for a run at `now`: finished before this instant is deleted. */
  cutoff(now = new Date(), days = this.config.values.JOB_RUNS_RETENTION_DAYS): Date {
    return new Date(now.getTime() - Math.max(7, days) * 86_400_000);
  }

  async run(now = new Date()): Promise<{ deleted: number; retentionDays: number }> {
    const before = this.cutoff(now);
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const rows = await this.prisma.client.$queryRaw<Array<{ n: number }>>`SELECT ngao_purge_job_runs(${before}::timestamptz, ${BATCH}::integer) AS n`;
      const n = Number(rows[0]?.n ?? 0);
      deleted += n;
      if (n < BATCH) break;
    }
    if (deleted > 0) this.logger.log(`Job run retention: ${deleted} finished run(s) older than ${this.config.values.JOB_RUNS_RETENTION_DAYS} days deleted`);
    return { deleted, retentionDays: this.config.values.JOB_RUNS_RETENTION_DAYS };
  }
}
