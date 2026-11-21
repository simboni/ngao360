import { Injectable } from '@nestjs/common';
import type { JobRunStatus } from '@ngao360/shared';
import { hostname } from 'node:os';
import { PrismaService } from '../../prisma/prisma.service';

export type JobCounts = Record<string, number>;

/**
 * Writes `job_runs`. Platform-wide runs (tenantId null) are written on a connection without a
 * tenant setting (RLS shows platform rows only there); tenant runs inside withTenant().
 * A finished run is frozen by a trigger. Error text must not contain personal data or secrets.
 */
@Injectable()
export class JobRunRecorder {
  private readonly instance = `${hostname()}:${process.pid}`;

  constructor(private readonly prisma: PrismaService) {}

  async start(jobKey: string, opts: { tenantId?: string | null; queueJobId?: string | null; scheduledFor?: Date | null } = {}): Promise<string> {
    const data = {
      jobKey,
      tenantId: opts.tenantId ?? null,
      queueJobId: opts.queueJobId ?? null,
      scheduledFor: opts.scheduledFor ?? null,
      instance: this.instance,
    };
    const row = opts.tenantId
      ? await this.prisma.withTenant(opts.tenantId, (tx) => tx.jobRun.create({ data, select: { id: true } }))
      : await this.prisma.client.jobRun.create({ data, select: { id: true } });
    return row.id;
  }

  async finish(
    runId: string,
    tenantId: string | null,
    outcome: { status: Exclude<JobRunStatus, 'RUNNING'>; counts?: JobCounts; error?: string | null },
  ): Promise<void> {
    const data = {
      status: outcome.status,
      finishedAt: new Date(),
      counts: outcome.counts ?? {},
      error: outcome.error ? outcome.error.slice(0, 2000) : null,
    };
    if (tenantId) await this.prisma.withTenant(tenantId, (tx) => tx.jobRun.update({ where: { id: runId }, data }));
    else await this.prisma.client.jobRun.update({ where: { id: runId }, data });
  }
}
