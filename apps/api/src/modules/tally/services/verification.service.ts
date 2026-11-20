import { Injectable } from '@nestjs/common';
import { Prisma } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateVerification,
  FormFieldSchemaSchema,
  type SupervisorActionRequest,
  type Verification,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { supervisorViolation, verificationViolation } from '../domain/separation-of-duties';
import { statusPath } from '../domain/status-path';
import { compareIndependentValues, requiredReentryCells } from '../domain/verification-compare';
import { cellKey } from '../domain/validation-engine';
import { ENTITY, OPEN_CASE_STATUSES } from '../tally.constants';
import { toVerification, verificationInclude } from './mappers';
import { StageComparisonService } from './stage-comparison.service';
import { TallyWorkflowService } from './tally-workflow.service';
import { ValidationService } from './validation.service';

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workflow: TallyWorkflowService,
    private readonly validation: ValidationService,
    private readonly stages: StageComparisonService,
  ) {}

  /**
   * POST /tally/submissions/:id/verifications (blueprint 8.5). The reviewer must
   * differ from the submitter and from everyone who entered values. In
   * independent re-entry mode the reviewer's values are compared with the
   * captured ones; any difference escalates a REVIEWER_DISAGREEMENT case to the
   * tally supervisor and holds the record. Captured values are never changed.
   */
  async create(auth: AuthContext, submissionId: string, body: CreateVerification): Promise<Verification> {
    const result = await this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({
        where: { id: submissionId },
        include: {
          formTemplate: { select: { fieldSchema: true, formLevel: true } },
          contest: { select: { candidates: { select: { id: true }, orderBy: { ballotOrder: 'asc' } } } },
          values: { select: { fieldKey: true, candidateReferenceId: true, numericValue: true } },
          verifications: { select: { round: true, supervisorAction: true, reviewedAt: true }, orderBy: { round: 'desc' } },
        },
      });
      if (!sub) throw AppException.notFound('Submission not found');
      if (sub.status !== 'SECOND_REVIEW_PENDING') {
        throw AppException.conflict('Only submissions awaiting second review can be verified', { status: sub.status });
      }
      const last = sub.verifications[0];
      const thirdCheck = last?.supervisorAction === 'THIRD_CHECK_REQUESTED';
      this.workflow.sod(verificationViolation(auth.userId, await this.workflow.participants(tx, sub.id), { thirdCheck }));

      const schema = FormFieldSchemaSchema.parse(sub.formTemplate.fieldSchema);
      const candidateIds = sub.contest.candidates.map((c) => c.id);
      const defs = new Map(schema.fields.map((f) => [f.key, f] as const));
      for (const iv of body.independentValues) {
        const def = defs.get(iv.fieldKey);
        if (!def) throw AppException.validation(`Field "${iv.fieldKey}" is not on this form template`);
        if (def.perCandidate !== (iv.candidateReferenceId !== null) || (iv.candidateReferenceId && !candidateIds.includes(iv.candidateReferenceId))) {
          throw AppException.validation(`Check the candidate for ${def.label}`);
        }
      }
      const mode = body.independentValues.length > 0 ? 'INDEPENDENT_REENTRY' : 'CONFIRM';
      if (mode === 'INDEPENDENT_REENTRY') {
        const given = new Set(body.independentValues.map((v) => cellKey(v.fieldKey, v.candidateReferenceId)));
        const missing = requiredReentryCells(schema, candidateIds).filter((c) => !given.has(c));
        if (missing.length > 0) {
          throw AppException.validation('Independent re-entry must include every candidate vote and required count', { missing });
        }
      }
      const mismatches = compareIndependentValues(sub.values, body.independentValues);

      if (body.decision === 'PASS') {
        const c = body.checklist;
        const unchecked = (
          [
            ['imageMatchesMetadata', c.imageMatchesMetadata],
            ['allValuesComparedToSource', c.allValuesComparedToSource],
            ['stationIdentityConfirmed', c.stationIdentityConfirmed],
            ['legible', c.legible],
          ] as const
        )
          .filter(([, v]) => !v)
          .map(([k]) => k);
        if (unchecked.length > 0) {
          throw AppException.validation('Complete the checklist before passing a submission, or return or dispute it', { unchecked });
        }
        const { run } = await this.validation.runAndStore(tx, sub.id, auth.userId, { openCases: false });
        const fails = run.results.filter((r) => r.outcome === 'FAIL');
        if (fails.length > 0) {
          throw AppException.validation('Failed checks remain. Return or dispute the submission instead of passing it.', {
            failed: fails.map((f) => f.ruleKey),
          });
        }
      }

      const round = (last?.round ?? 0) + 1;
      const verification = await tx.verification.create({
        data: {
          tenantId: auth.tenantId,
          submissionId: sub.id,
          round,
          reviewerId: auth.userId,
          decision: body.decision,
          checklist: body.checklist as unknown as Prisma.InputJsonValue,
          independentValues: body.independentValues as unknown as Prisma.InputJsonValue,
          mismatchedFieldKeys: mismatches.map((m) => m.cell),
          fieldComments: body.fieldComments as unknown as Prisma.InputJsonValue,
          notes: body.notes ?? null,
        },
        include: verificationInclude,
      });

      let outcome: 'VERIFIED' | 'RETURNED' | 'DISPUTED';
      if (mismatches.length > 0) outcome = 'DISPUTED';
      else if (body.decision === 'PASS') outcome = 'VERIFIED';
      else if (body.decision === 'RETURN') outcome = 'RETURNED';
      else outcome = 'DISPUTED';

      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.VERIFICATION_RECORDED,
          entityType: ENTITY.VERIFICATION,
          entityId: verification.id,
          after: {
            submissionId: sub.id,
            round,
            mode,
            decision: body.decision,
            outcome,
            mismatches,
            checklist: body.checklist,
            thirdCheck,
          },
          reason: body.notes ?? null,
        },
        tx,
      );
      const reason =
        outcome === 'VERIFIED'
          ? `Verified for parallel tally by independent reviewer (round ${round})`
          : outcome === 'RETURNED'
            ? body.notes ?? `Returned by reviewer (round ${round})`
            : mismatches.length > 0
              ? `Reviewer disagreement on ${mismatches.length} value(s) (round ${round})`
              : body.notes ?? `Disputed by reviewer (round ${round})`;
      await this.workflow.transition(tx, sub, outcome, reason, outcome === 'VERIFIED' ? { verifiedAt: new Date() } : {});

      if (mismatches.length > 0) {
        await this.workflow.openCase(tx, {
          tenantId: auth.tenantId,
          electionCycleId: sub.electionCycleId,
          contestId: sub.contestId,
          varianceType: 'REVIEWER_DISAGREEMENT',
          severity: 'HIGH',
          status: 'ESCALATED',
          title: `Reviewer disagreement on ${sub.reference}`,
          description: `The independent reviewer recorded different values for ${mismatches
            .map((m) => m.cell)
            .join(', ')}. Escalated to the tally supervisor for a reasoned resolution.`,
          details: { verificationId: verification.id, round, comparison: mismatches },
          links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
          openedById: auth.userId,
        });
      }
      if (!body.checklist.legible && !(await this.workflow.findOpenCase(tx, sub.id, 'IMAGE_QUALITY'))) {
        await this.workflow.openCase(tx, {
          tenantId: auth.tenantId,
          electionCycleId: sub.electionCycleId,
          contestId: sub.contestId,
          varianceType: 'IMAGE_QUALITY',
          severity: 'MEDIUM',
          title: `Reviewer could not read the source clearly: ${sub.reference}`,
          description: 'Return for a clearer copy or escalate. Do not guess values that cannot be read.',
          details: { verificationId: verification.id },
          links: [{ submissionId: sub.id, role: 'SOURCE_A' }],
          openedById: auth.userId,
        });
      }
      return { verification, outcome, sub };
    });

    if (result.outcome === 'VERIFIED' && result.sub.formTemplate.formLevel !== 'POLLING_STATION') {
      // Later-stage forms are compared with the verified A-form aggregate (blueprint 8.6).
      await this.stages.compareSubmission(auth, result.sub.id);
    }
    return toVerification(result.verification);
  }

  list(submissionId: string): Promise<Verification[]> {
    return this.prisma.tenantTx(async (tx) => {
      const exists = await tx.resultSubmission.findUnique({ where: { id: submissionId }, select: { id: true } });
      if (!exists) throw AppException.notFound('Submission not found');
      const rows = await tx.verification.findMany({
        where: { submissionId },
        include: verificationInclude,
        orderBy: [{ round: 'asc' }, { reviewedAt: 'asc' }],
      });
      return rows.map(toVerification);
    });
  }

  /**
   * POST /tally/verifications/:id/supervisor-action. The supervisor must not be
   * the submitter, a value editor or a verifier of the submission. APPROVED
   * confirms the outcome; REJECTED sends the record back for second review;
   * THIRD_CHECK_REQUESTED opens a new round that a fresh reviewer must take.
   */
  async supervisorAction(auth: AuthContext, verificationId: string, body: SupervisorActionRequest): Promise<Verification> {
    return this.prisma.tenantTx(async (tx) => {
      const v = await tx.verification.findUnique({ where: { id: verificationId } });
      if (!v) throw AppException.notFound('Verification not found');
      const loc = await this.workflow.submissionLocation(tx, v.submissionId);
      if (loc) this.workflow.assertInScope(auth, 'tally.approve', loc);
      if (v.supervisorAction) {
        throw AppException.conflict('A supervisor action has already been recorded for this verification');
      }
      const latest = await tx.verification.findFirst({
        where: { submissionId: v.submissionId },
        orderBy: [{ round: 'desc' }],
        select: { id: true },
      });
      if (latest?.id !== v.id) throw AppException.conflict('Only the latest verification round can be acted on');
      this.workflow.sod(supervisorViolation(auth.userId, await this.workflow.participants(tx, v.submissionId)));

      const sub = await tx.resultSubmission.findUniqueOrThrow({
        where: { id: v.submissionId },
        select: { id: true, tenantId: true, status: true, version: true },
      });
      const updated = await tx.verification.update({
        where: { id: v.id },
        data: {
          supervisorAction: body.action,
          supervisorId: auth.userId,
          supervisorReason: body.reason,
          supervisorActionAt: new Date(),
        },
        include: verificationInclude,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.SUPERVISOR_ACTION,
          entityType: ENTITY.VERIFICATION,
          entityId: v.id,
          before: { supervisorAction: null, submissionStatus: sub.status },
          after: { supervisorAction: body.action, submissionId: sub.id },
          reason: body.reason,
        },
        tx,
      );

      if (body.action !== 'APPROVED' && sub.status !== 'SECOND_REVIEW_PENDING') {
        const path = statusPath(sub.status, 'SECOND_REVIEW_PENDING');
        if (!path) throw AppException.invalidTransition(sub.status, 'SECOND_REVIEW_PENDING');
        const label = body.action === 'THIRD_CHECK_REQUESTED' ? 'Third check requested' : 'Verification outcome rejected';
        await this.workflow.transitionPath(tx, sub, path, `${label} by tally supervisor: ${body.reason}`);
      }

      const cases = await tx.discrepancyCase.findMany({
        where: {
          varianceType: 'REVIEWER_DISAGREEMENT',
          status: { in: OPEN_CASE_STATUSES },
          links: { some: { submissionId: sub.id } },
        },
        select: { id: true },
      });
      for (const c of cases) {
        await tx.discrepancyCaseAction.create({
          data: {
            tenantId: auth.tenantId,
            caseId: c.id,
            actorId: auth.userId,
            action: `SUPERVISOR_${body.action}`,
            note: body.reason,
            data: { verificationId: v.id },
          },
        });
      }
      return toVerification(updated);
    });
  }
}
