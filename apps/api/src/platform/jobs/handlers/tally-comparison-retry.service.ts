/**
 * `tally.comparison_retry`: re-runs cross-stage comparisons that did not complete (blueprint 8.6;
 * STATUS gap "a failed comparison is logged but not retried"). Owner: platform-infra.
 *
 * Verification of a later-stage form (37B, 37C …) compares it with the verified station aggregate
 * right after the verification commits. If that comparison failed (or the process stopped first),
 * nothing records it as done. This job finds, per tenant with the tally module on:
 *   VERIFIED non-polling-station submissions verified in the last 7 days (and at least 2 minutes
 *   ago, so the inline comparison has had its chance), with no `tally.stage_comparison.completed`
 *   audit event and no cross-stage case already linking them,
 * and re-runs the comparison as the person who verified them (the case opener must be a user).
 * Failures are audited (`tally.stage_comparison.failed`) and retried with backoff (1, 2, 4 …
 * minutes, at most 8 attempts); after that a supervisor can still use the re-run action.
 * Idempotent: the comparison itself never opens a second open case for the same submission.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JOB_KEYS } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import {
  STAGE_COMPARISON_COMPLETED,
  STAGE_COMPARISON_FAILED,
  StageComparisonService,
} from '../../../modules/tally/services/stage-comparison.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { JobScheduler } from '../job-scheduler';

export const COMPARISON_RETRY_MAX_ATTEMPTS = 8;
const LOOKBACK = '7 days';
const GRACE = '2 minutes';

interface Candidate {
  id: string;
  failures: number;
  verifier_id: string | null;
}

@Injectable()
export class TallyComparisonRetryService implements OnModuleInit {
  private readonly logger = new Logger(TallyComparisonRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobScheduler,
    private readonly modules: TenantModulesService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ key: JOB_KEYS.TALLY_COMPARISON_RETRY, everyMs: 5 * 60_000, handler: () => this.runAll() });
  }

  private get comparisons(): StageComparisonService {
    return this.moduleRef.get(StageComparisonService, { strict: false });
  }

  async runAll(): Promise<{ tenants: number; retried: number; completed: number; failed: number }> {
    const tenants = await this.prisma.client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    const total = { tenants: 0, retried: 0, completed: 0, failed: 0 };
    for (const t of tenants) {
      const r = await this.runForTenant(t.id);
      if (!r) continue;
      total.tenants += 1;
      total.retried += r.retried;
      total.completed += r.completed;
      total.failed += r.failed;
    }
    return total;
  }

  /** Null when the tally module is off for the tenant. */
  async runForTenant(tenantId: string, opts: { graceSeconds?: number } = {}): Promise<{ retried: number; completed: number; failed: number } | null> {
    const grace = opts.graceSeconds !== undefined ? `${opts.graceSeconds} seconds` : GRACE;
    const candidates = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!(await this.modules.isEnabled(tx, 'tally'))) return null;
      return tx.$queryRaw<Candidate[]>`
        SELECT s.id,
               (SELECT count(*)::int FROM audit_events a
                 WHERE a.tenant_id = s.tenant_id AND a.entity_type = 'ResultSubmission' AND a.entity_id = s.id::text
                   AND a.action = ${STAGE_COMPARISON_FAILED}) AS failures,
               (SELECT v.reviewer_id FROM verifications v
                 WHERE v.submission_id = s.id AND v.decision = 'PASS' ORDER BY v.reviewed_at DESC LIMIT 1) AS verifier_id
        FROM result_submissions s
        JOIN form_templates t ON t.id = s.form_template_id
        WHERE s.status = 'VERIFIED' AND t.form_level <> 'POLLING_STATION'
          AND s.verified_at >= now() - ${LOOKBACK}::interval
          AND s.verified_at <= now() - ${grace}::interval
          AND NOT EXISTS (SELECT 1 FROM audit_events a
                          WHERE a.tenant_id = s.tenant_id AND a.entity_type = 'ResultSubmission' AND a.entity_id = s.id::text
                            AND a.action = ${STAGE_COMPARISON_COMPLETED})
          AND NOT EXISTS (SELECT 1 FROM discrepancy_case_submissions l JOIN discrepancy_cases c ON c.id = l.case_id
                          WHERE l.submission_id = s.id AND c.variance_type = 'CROSS_STAGE_MISMATCH')
          AND NOT EXISTS (SELECT 1 FROM audit_events a
                          WHERE a.tenant_id = s.tenant_id AND a.entity_type = 'ResultSubmission' AND a.entity_id = s.id::text
                            AND a.action = ${STAGE_COMPARISON_FAILED}
                            AND a.occurred_at > now() - interval '1 minute' * power(2, LEAST(10, (
                                SELECT count(*) FROM audit_events b
                                 WHERE b.tenant_id = s.tenant_id AND b.entity_type = 'ResultSubmission'
                                   AND b.entity_id = s.id::text AND b.action = ${STAGE_COMPARISON_FAILED}))::int - 1))
        ORDER BY s.verified_at
        LIMIT 100`;
    });
    if (candidates === null) return null;
    const out = { retried: 0, completed: 0, failed: 0 };
    for (const c of candidates) {
      if (c.failures >= COMPARISON_RETRY_MAX_ATTEMPTS || !c.verifier_id) continue;
      out.retried += 1;
      try {
        await this.comparisons.compareInTenant({ tenantId, userId: c.verifier_id }, c.id, { actorType: 'SYSTEM', trigger: 'RETRY' });
        out.completed += 1;
      } catch (err) {
        out.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Cross-stage comparison retry failed for submission ${c.id}: ${message}`);
        await this.prisma.withTenant(tenantId, (tx) =>
          this.audit.record(
            {
              tenantId,
              actorId: null,
              actorType: 'SYSTEM',
              action: STAGE_COMPARISON_FAILED,
              entityType: 'ResultSubmission',
              entityId: c.id,
              after: { attempt: c.failures + 1, error: message.slice(0, 300) },
              omitRequestMetadata: true,
            },
            tx,
          ),
        );
      }
    }
    return out;
  }
}
