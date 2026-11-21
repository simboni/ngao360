import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JOB_KEYS } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import { JobScheduler } from '../../../platform/jobs/job-scheduler';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { eraseAgentSensitiveInTx } from './agents.service';

/** Interval of the `field.agent_retention` job (daily). */
export const AGENT_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * `field.agent_retention`: erase the national ID, phone, M-Pesa and next-of-kin details of agents
 * WITHDRAWN for longer than `agentSensitiveRetentionMonths` (field module configuration, default
 * 12). The agent record, its history and the audit trail stay. Runs for every tenant, whatever
 * its status or module state, so the period stated in the agent privacy notice keeps applying.
 */
@Injectable()
export class AgentRetentionService implements OnModuleInit {
  private readonly logger = new Logger(AgentRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly modules: TenantModulesService,
    private readonly jobs: JobScheduler,
  ) {}

  onModuleInit(): void {
    if (this.jobs.registered().some((d) => d.key === JOB_KEYS.FIELD_AGENT_RETENTION)) return;
    this.jobs.register({
      key: JOB_KEYS.FIELD_AGENT_RETENTION,
      everyMs: AGENT_RETENTION_INTERVAL_MS,
      handler: async () => {
        const r = await this.runAll();
        if (r.erased > 0) this.logger.log(`Agent retention: ${r.erased} agent record(s) erased`);
        return { ...r };
      },
    });
  }

  async runAll(now = new Date()): Promise<{ tenants: number; erased: number }> {
    const tenants = await this.prisma.client.tenant.findMany({ select: { id: true } });
    let erased = 0;
    for (const t of tenants) erased += await this.runForTenant(t.id, now);
    return { tenants: tenants.length, erased };
  }

  runForTenant(tenantId: string, now = new Date()): Promise<number> {
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const config = await this.modules.fieldConfig(tx);
        const cutoff = new Date(now);
        cutoff.setUTCMonth(cutoff.getUTCMonth() - config.agentSensitiveRetentionMonths);
        const withdrawn = await tx.agent.findMany({
          where: {
            status: 'WITHDRAWN',
            OR: [{ phoneMasked: { not: null } }, { nationalIdMasked: { not: null } }, { hasMpesaNumber: true }, { hasNextOfKin: true }, { sensitive: { is: { erasedAt: null } } }],
          },
          select: { id: true, updatedAt: true, statusEvents: { where: { toStatus: 'WITHDRAWN' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
          take: 500,
        });
        let erased = 0;
        for (const a of withdrawn) {
          const since = a.statusEvents[0]?.createdAt ?? a.updatedAt;
          if (since >= cutoff) continue;
          const done = await eraseAgentSensitiveInTx(tx, this.audit, {
            tenantId,
            actorId: null,
            agentId: a.id,
            reason: `Agent data retention period (${config.agentSensitiveRetentionMonths} months after withdrawal) ended`,
            trigger: 'RETENTION',
          });
          if (done) erased += 1;
        }
        return erased;
      },
      { timeout: 120_000 },
    );
  }
}
