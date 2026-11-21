/**
 * File scan status and durable job administration (API contract §34). Owner: platform-infra.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type FileScanSummary,
  type JobRunSummary,
  type JobStatusResponse,
  type Paginated,
} from '@ngao360/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../common/decorators/auth.decorators';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission, RequireReauth } from '../rbac/require-permission.decorator';
import { JobScheduler } from './jobs/job-scheduler';
import { JobKeyParamDto, JobRunsQueryDto, PlatformIdParamDto, ReasonBodyDto } from './platform.dto';
import { FileScanService, toFileScanSummary } from './scanning/file-scan.service';

const SCAN_SELECT = { id: true, malwareScanStatus: true, scanEngine: true, scanSignature: true, scannedAt: true, quarantinedAt: true } as const;

@Controller('files')
export class FileScanController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scans: FileScanService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/scan')
  @RequirePermission('workspace.view')
  status(@Param() p: PlatformIdParamDto): Promise<FileScanSummary> {
    return this.prisma.tenantTx(async (tx) => {
      const f = await tx.storedFile.findUnique({ where: { id: p.id }, select: SCAN_SELECT });
      if (!f) throw AppException.notFound('File not found');
      return toFileScanSummary(f);
    });
  }

  /** PENDING / ERROR only. Scans now when a scanner is configured; INFECTED and CLEAN are final here. */
  @Post(':id/rescan')
  @HttpCode(200)
  @RequirePermission('workspace.configure')
  @RequireReauth()
  async rescan(@CurrentAuth() auth: AuthContext, @Param() p: PlatformIdParamDto, @Body() body: ReasonBodyDto): Promise<FileScanSummary> {
    const before = await this.prisma.tenantTx(async (tx) => {
      const f = await tx.storedFile.findUnique({ where: { id: p.id }, select: SCAN_SELECT });
      if (!f) throw AppException.notFound('File not found');
      if (f.malwareScanStatus !== 'PENDING' && f.malwareScanStatus !== 'ERROR') throw AppException.invalidTransition(f.malwareScanStatus, 'PENDING');
      await this.audit.record(
        { tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.FILE_SCAN_RECORDED, entityType: 'StoredFile', entityId: p.id, after: { requested: true, status: f.malwareScanStatus }, reason: body.reason },
        tx,
      );
      return f;
    });
    if (!this.scans.scannerConfigured) {
      throw AppException.conflict('No malware scanner is configured on this server, so the file stays PENDING and cannot be used where a clean scan is required', { status: before.malwareScanStatus });
    }
    await this.scans.scanNext(auth.tenantId, p.id);
    return this.prisma.tenantTx(async (tx) => toFileScanSummary(await tx.storedFile.findUniqueOrThrow({ where: { id: p.id }, select: SCAN_SELECT })));
  }
}

type RunRow = { id: string; tenantId: string | null; jobKey: string; status: JobRunSummary['status']; startedAt: Date; finishedAt: Date | null; counts: unknown; error: string | null };

function toRun(r: RunRow, showError: boolean): JobRunSummary {
  const counts: Record<string, number> = {};
  if (r.counts && typeof r.counts === 'object') for (const [k, v] of Object.entries(r.counts)) if (typeof v === 'number') counts[k] = v;
  return {
    id: r.id,
    tenantId: r.tenantId,
    jobKey: r.jobKey,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    counts,
    error: r.error === null ? null : showError ? r.error : 'failed',
  };
}

@Controller('platform/jobs')
export class JobsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobScheduler,
    private readonly audit: AuditService,
  ) {}

  /** Registered jobs with their last run: tenant runs of the caller's tenant and platform runs. */
  @Get()
  @RequirePermission('workspace.view')
  async status(@CurrentAuth() auth: AuthContext): Promise<JobStatusResponse> {
    const operator = auth.permissions.has('platform.health.view');
    const defs = this.jobs.registered();
    const keys = defs.map((d) => d.key);
    // Platform runs are visible only on a connection without a tenant setting (RLS).
    const [platformRuns, tenantRuns] = await Promise.all([
      this.prisma.client.jobRun.findMany({ where: { jobKey: { in: keys }, tenantId: null }, orderBy: { startedAt: 'desc' }, distinct: ['jobKey'] }),
      this.prisma.withTenant(auth.tenantId, (tx) => tx.jobRun.findMany({ where: { jobKey: { in: keys } }, orderBy: { startedAt: 'desc' }, distinct: ['jobKey'] })),
    ]);
    return {
      jobs: defs.map((d) => {
        const last = [...platformRuns, ...tenantRuns].filter((r) => r.jobKey === d.key).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        return {
          jobKey: d.key,
          scheduled: this.jobs.enabled && !!d.everyMs,
          everyMinutes: d.everyMs ? Math.max(1, Math.round(d.everyMs / 60_000)) : null,
          lastRun: last ? toRun(last, operator || last.tenantId !== null) : null,
        };
      }),
    };
  }

  @Get('runs')
  @RequirePermission('platform.health.view')
  async runs(@Query() q: JobRunsQueryDto): Promise<Paginated<JobRunSummary>> {
    const where = { ...(q.jobKey ? { jobKey: q.jobKey } : {}), ...(q.status ? { status: q.status } : {}), tenantId: null };
    const [rows, total] = await Promise.all([
      this.prisma.client.jobRun.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.client.jobRun.count({ where }),
    ]);
    return { items: rows.map((r) => toRun(r, true)), page: q.page, pageSize: q.pageSize, total };
  }

  @Post(':key/run')
  @HttpCode(200)
  @RequirePermission('platform.tenants.manage')
  @RequireReauth()
  async run(@CurrentAuth() auth: AuthContext, @Param() p: JobKeyParamDto, @Body() body: ReasonBodyDto): Promise<JobRunSummary> {
    if (!this.jobs.registered().some((d) => d.key === p.key)) throw AppException.notFound('Unknown job');
    await this.prisma.withTenant(auth.tenantId, (tx) =>
      this.audit.record({ tenantId: auth.tenantId, actorId: auth.userId, action: AUDIT_ACTIONS.JOB_RUN_TRIGGERED, entityType: 'Job', entityId: null, after: { jobKey: p.key }, reason: body.reason }, tx),
    );
    const outcome = await this.jobs.runNow(p.key);
    const row = await this.prisma.client.jobRun.findUnique({ where: { id: outcome.runId } });
    if (!row) throw AppException.notFound('Run not found');
    return toRun(row, true);
  }
}
