import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  FormFieldSchemaSchema,
  type ValidationRun,
  ValidationRulesSchema,
} from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { arithmeticFailures, type EngineResult, type EngineRun, runValidation } from '../domain/validation-engine';
import { ENTITY } from '../tally.constants';
import { toValidationRun } from './mappers';
import { TallyWorkflowService } from './tally-workflow.service';

/** Statuses in which an arithmetic FAIL holds the record (it is in or entering the aggregate pipeline). */
const HOLD_ON_ARITHMETIC_FAIL = new Set(['SECOND_REVIEW_PENDING', 'VERIFIED']);

@Injectable()
export class ValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workflow: TallyWorkflowService,
  ) {}

  /**
   * Evaluate the template's rules against the current values and persist one
   * ValidationResult row per rule under a new run id. Never alters values.
   * With `openCases`, an arithmetic FAIL opens an ARITHMETIC case (if none is
   * open) and holds the record from the aggregate when it is under review or
   * verified.
   */
  async runAndStore(
    tx: TenantTx,
    submissionId: string,
    actorId: string,
    opts: { openCases: boolean },
  ): Promise<{ run: ValidationRun; engine: EngineRun; arithmetic: EngineResult[] }> {
    const sub = await tx.resultSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        electionCycleId: true,
        contestId: true,
        reference: true,
        formTemplate: { select: { id: true, fieldSchema: true, validationRules: true, formNumber: true, version: true } },
        contest: { select: { candidates: { select: { id: true }, orderBy: { ballotOrder: 'asc' } } } },
        values: { select: { fieldKey: true, candidateReferenceId: true, numericValue: true, textValue: true } },
      },
    });
    if (!sub) throw AppException.notFound('Submission not found');
    const fieldSchema = FormFieldSchemaSchema.parse(sub.formTemplate.fieldSchema);
    const rules = ValidationRulesSchema.parse(sub.formTemplate.validationRules);
    const engine = runValidation({
      rules,
      fieldSchema,
      values: sub.values,
      candidateIds: sub.contest.candidates.map((c) => c.id),
    });

    const runId = randomUUID();
    const now = new Date();
    await tx.validationResult.createMany({
      data: engine.results.map((r) => ({
        tenantId: sub.tenantId,
        submissionId: sub.id,
        runId,
        rulesVersion: engine.rulesVersion,
        ruleKey: r.ruleKey,
        ruleVersion: r.ruleVersion,
        outcome: r.outcome,
        fieldKeys: r.fieldKeys,
        message: r.message,
        details: r.details as Prisma.InputJsonValue,
        reference: r.reference,
        createdAt: now,
      })),
    });
    await this.audit.record(
      {
        tenantId: sub.tenantId,
        actorId,
        action: AUDIT_ACTIONS.VALIDATION_RUN,
        entityType: ENTITY.SUBMISSION,
        entityId: sub.id,
        after: {
          runId,
          formTemplateId: sub.formTemplate.id,
          rulesVersion: engine.rulesVersion,
          summary: engine.summary,
          failed: engine.results.filter((r) => r.outcome === 'FAIL').map((r) => r.ruleKey),
        },
      },
      tx,
    );

    const arithmetic = arithmeticFailures(rules, engine);
    if (opts.openCases && arithmetic.length > 0 && !(await this.workflow.findOpenCase(tx, sub.id, 'ARITHMETIC'))) {
      await this.openArithmeticCase(tx, sub, actorId, runId, arithmetic);
      if (HOLD_ON_ARITHMETIC_FAIL.has(sub.status)) {
        await this.workflow.hold(tx, sub.id, 'Held from the verified aggregate: arithmetic check failed', actorId);
      }
    }

    const rows = await tx.validationResult.findMany({ where: { submissionId: sub.id, runId }, orderBy: { createdAt: 'asc' } });
    // createMany preserves insertion order only by id; re-order by the engine's rule order.
    const order = new Map(engine.results.map((r, i) => [r.ruleKey, i] as const));
    rows.sort((a, b) => (order.get(a.ruleKey) ?? 0) - (order.get(b.ruleKey) ?? 0));
    return { run: toValidationRun(sub.id, rows)!, engine, arithmetic };
  }

  private async openArithmeticCase(
    tx: TenantTx,
    sub: { id: string; tenantId: string; electionCycleId: string; contestId: string; reference: string },
    actorId: string,
    runId: string | null,
    failures: EngineResult[],
  ): Promise<void> {
    await this.workflow.openCase(tx, {
      tenantId: sub.tenantId,
      electionCycleId: sub.electionCycleId,
      contestId: sub.contestId,
      varianceType: 'ARITHMETIC',
      severity: 'HIGH',
      title: `Arithmetic check failed on ${sub.reference}`,
      description: failures.map((f) => f.message).join('\n'),
      details: { runId, failures: failures.map((f) => ({ ruleKey: f.ruleKey, fieldKeys: f.fieldKeys, ...f.details })) },
      links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
      openedById: actorId,
    });
  }

  /**
   * Blueprint 8.5: a form whose printed figures fail arithmetic is held, shows
   * the arithmetic, and goes to second review through the case. Ensures an
   * open ARITHMETIC case is linked and moves the record to DISPUTED (held).
   */
  async holdForArithmetic(tx: TenantTx, submissionId: string, actorId: string, failures: EngineResult[]): Promise<void> {
    if (!(await this.workflow.findOpenCase(tx, submissionId, 'ARITHMETIC'))) {
      const sub = await tx.resultSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        select: { id: true, tenantId: true, electionCycleId: true, contestId: true, reference: true },
      });
      await this.openArithmeticCase(tx, sub, actorId, null, failures);
    }
    await this.workflow.hold(tx, submissionId, 'Held from the verified aggregate: arithmetic check failed on the figures as printed', actorId);
  }

  /** True when a supervisor has resolved an arithmetic case on this record (figures accepted as printed). */
  async arithmeticAccepted(tx: TenantTx, submissionId: string): Promise<boolean> {
    const n = await tx.discrepancyCase.count({
      where: { varianceType: 'ARITHMETIC', status: { in: ['RESOLVED', 'CLOSED'] }, links: { some: { submissionId } } },
    });
    return n > 0;
  }

  /** POST /tally/submissions/:id/validate */
  validate(auth: AuthContext, submissionId: string): Promise<ValidationRun> {
    return this.prisma.tenantTx(async (tx) => {
      const { run } = await this.runAndStore(tx, submissionId, auth.userId, { openCases: true });
      return run;
    });
  }

  /** Latest run for a submission (null when never validated). */
  async latest(tx: TenantTx, submissionId: string): Promise<ValidationRun | null> {
    const last = await tx.validationResult.findFirst({
      where: { submissionId },
      orderBy: { createdAt: 'desc' },
      select: { runId: true },
    });
    if (!last) return null;
    const rows = await tx.validationResult.findMany({ where: { submissionId, runId: last.runId } });
    const sub = await tx.resultSubmission.findUnique({
      where: { id: submissionId },
      select: { formTemplate: { select: { validationRules: true } } },
    });
    const parsed = ValidationRulesSchema.safeParse(sub?.formTemplate.validationRules);
    if (parsed.success) {
      const order = new Map(parsed.data.rules.map((r, i) => [r.key, i] as const));
      rows.sort((a, b) => (order.get(a.ruleKey) ?? 0) - (order.get(b.ruleKey) ?? 0));
    }
    return toValidationRun(submissionId, rows);
  }

  getLatest(submissionId: string): Promise<ValidationRun | null> {
    return this.prisma.tenantTx((tx) => this.latest(tx, submissionId));
  }
}
