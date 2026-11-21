import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  type AssignDiscrepancy,
  AUDIT_ACTIONS,
  canTransitionSubmission,
  type CloseDiscrepancy,
  type CreateDiscrepancy,
  DISCREPANCY_REQUIRED_HANDLING,
  type DiscrepancyCaseAction,
  type DiscrepancyCaseDetail,
  type DiscrepancyCaseSummary,
  type DiscrepancyComment,
  type DiscrepancyQuery,
  type DiscrepancyStatus,
  type DiscrepancyTransition,
  type Paginated,
  type ResolveDiscrepancy,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PermissionService } from '../../../rbac/permission.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { type AcceptedFigures, figuresFingerprint } from '../domain/accepted-figures';
import { closureViolation, supervisorViolation } from '../domain/separation-of-duties';
import { ENTITY, HOLDING_CASE_TYPES, OPEN_CASE_STATUSES } from '../tally.constants';
import { caseSummaryInclude, iso, toCaseSummary, userRef } from './mappers';
import { caseScopeWhere } from './scope-where';
import { SubmissionsService } from './submissions.service';
import { TallyWorkflowService } from './tally-workflow.service';

const MANUAL_TRANSITIONS: Partial<Record<DiscrepancyStatus, DiscrepancyStatus[]>> = {
  OPEN: ['UNDER_REVIEW', 'ESCALATED'],
  UNDER_REVIEW: ['ESCALATED'],
  ESCALATED: ['UNDER_REVIEW'],
};


@Injectable()
export class DiscrepancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly workflow: TallyWorkflowService,
    private readonly submissions: SubmissionsService,
  ) {}

  async list(auth: AuthContext, q: DiscrepancyQuery): Promise<Paginated<DiscrepancyCaseSummary>> {
    const and: Prisma.DiscrepancyCaseWhereInput[] = [];
    const scoped = caseScopeWhere(this.permissions.scopeFor(auth, 'tally.discrepancy.view'));
    if (scoped) and.push(scoped);
    if (q.electionCycleId) and.push({ electionCycleId: q.electionCycleId });
    if (q.contestId) and.push({ contestId: q.contestId });
    if (q.status) and.push({ status: q.status });
    if (q.varianceType) and.push({ varianceType: q.varianceType });
    if (q.severity) and.push({ severity: q.severity });
    if (q.assignedToMe) and.push({ assignedToId: auth.userId });
    if (q.submissionId) and.push({ links: { some: { submissionId: q.submissionId } } });
    if (q.q) {
      and.push({
        OR: [
          { reference: { contains: q.q, mode: 'insensitive' } },
          { title: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    }
    const where = { AND: and };
    const sortable = new Set(['createdAt', 'updatedAt', 'severity', 'status', 'reference']);
    const sortKey = q.sort && sortable.has(q.sort) ? q.sort : 'createdAt';
    const [total, rows] = await this.prisma.tenantTx((tx) =>
      Promise.all([
        tx.discrepancyCase.count({ where }),
        tx.discrepancyCase.findMany({
          where,
          include: caseSummaryInclude,
          orderBy: [{ [sortKey]: q.order }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]),
    );
    const now = new Date();
    return { items: rows.map((r) => toCaseSummary(r, now)), page: q.page, pageSize: q.pageSize, total };
  }

  get(id: string): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx((tx) => this.detailTx(tx, id));
  }

  async detailTx(tx: TenantTx, id: string): Promise<DiscrepancyCaseDetail> {
    const c = await tx.discrepancyCase.findUnique({
      where: { id },
      include: {
        ...caseSummaryInclude,
        resolvedBy: userRef,
        closureApprover: userRef,
        actions: { include: { actor: userRef }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!c) throw AppException.notFound('Discrepancy case not found');
    return {
      ...toCaseSummary(c),
      description: c.description,
      details: (c.details && typeof c.details === 'object' && !Array.isArray(c.details) ? c.details : {}) as Record<string, unknown>,
      links: c.links.map((l) => ({ submissionId: l.submissionId, role: l.role, reference: l.submission.reference })),
      requiredHandling: DISCREPANCY_REQUIRED_HANDLING[c.varianceType],
      resolution: c.resolution,
      resolvedBy: c.resolvedBy,
      closureApprover: c.closureApprover,
      closedAt: iso(c.closedAt),
      actions: c.actions.map(toAction),
    };
  }

  /**
   * Load a case for a change. Every linked submission must be inside the
   * caller's grant of `permission` (geography and cycle): a ward-level user
   * cannot act on a case that also links forms outside their ward. Read access
   * (the 'discrepancy' geo resolver) stays "any linked record".
   */
  private async loadInScope(tx: TenantTx, auth: AuthContext, id: string, permission: 'tally.discrepancy.manage' | 'tally.discrepancy.resolve') {
    const c = await tx.discrepancyCase.findUnique({ where: { id }, include: { links: true } });
    if (!c) throw AppException.notFound('Discrepancy case not found');
    if (c.links.length === 0) throw AppException.outOfScope('This case has no linked records to check your access against');
    for (const l of c.links) await this.workflow.assertSubmissionInScope(tx, auth, permission, l.submissionId);
    return c;
  }

  /** Conditional status change: fails with CONFLICT if another request changed the case first. */
  private async setStatus(tx: TenantTx, id: string, from: DiscrepancyStatus, data: Prisma.DiscrepancyCaseUncheckedUpdateManyInput): Promise<void> {
    const r = await tx.discrepancyCase.updateMany({ where: { id, status: from }, data });
    if (r.count !== 1) throw AppException.conflict('This case was changed by someone else. Reload and try again.');
  }

  /** POST /tally/discrepancies (manual case). */
  create(auth: AuthContext, body: CreateDiscrepancy): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const subs = await tx.resultSubmission.findMany({
        where: { id: { in: body.links.map((l) => l.submissionId) } },
        select: { id: true, electionCycleId: true, contestId: true },
      });
      if (subs.length !== new Set(body.links.map((l) => l.submissionId)).size) {
        throw AppException.validation('One or more linked submissions were not found');
      }
      for (const s of subs) {
        await this.workflow.assertSubmissionInScope(tx, auth, 'tally.discrepancy.manage', s.id);
      }
      const cycles = new Set(subs.map((s) => s.electionCycleId));
      if (cycles.size !== 1) throw AppException.validation('Linked submissions must belong to one election cycle');
      const contests = new Set(subs.map((s) => s.contestId));
      const created = await this.workflow.openCase(tx, {
        tenantId: auth.tenantId,
        electionCycleId: subs[0]!.electionCycleId,
        contestId: contests.size === 1 ? subs[0]!.contestId : null,
        varianceType: body.varianceType,
        severity: body.severity,
        title: body.title,
        description: body.description,
        details: body.details,
        links: body.links,
        openedById: auth.userId,
      });
      // Arithmetic and disagreement cases also move the record to DISPUTED; the
      // other holding types keep it out of the aggregate without a status change.
      if (body.varianceType === 'ARITHMETIC' || body.varianceType === 'REVIEWER_DISAGREEMENT') {
        for (const l of body.links) {
          await this.workflow.hold(tx, l.submissionId, `Held from the verified aggregate by case ${created.reference}`);
        }
      }
      return this.detailTx(tx, created.id);
    });
  }

  assign(auth: AuthContext, id: string, body: AssignDiscrepancy): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await this.loadInScope(tx, auth, id, 'tally.discrepancy.manage');
      this.assertOpen(c.status);
      if (body.assignedToId) {
        const u = await tx.user.findUnique({ where: { id: body.assignedToId }, select: { status: true } });
        if (!u || u.status !== 'ACTIVE') throw AppException.validation('Assign the case to an active user');
      }
      await tx.discrepancyCase.update({ where: { id }, data: { assignedToId: body.assignedToId } });
      await tx.discrepancyCaseAction.create({
        data: {
          tenantId: auth.tenantId,
          caseId: id,
          actorId: auth.userId,
          action: body.assignedToId ? 'ASSIGNED' : 'UNASSIGNED',
          note: body.note ?? null,
          data: { from: c.assignedToId, to: body.assignedToId },
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_UPDATED,
          entityType: ENTITY.DISCREPANCY,
          entityId: id,
          before: { assignedToId: c.assignedToId },
          after: { assignedToId: body.assignedToId },
          reason: body.note ?? null,
        },
        tx,
      );
      return this.detailTx(tx, id);
    });
  }

  comment(auth: AuthContext, id: string, body: DiscrepancyComment): Promise<DiscrepancyCaseAction> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadInScope(tx, auth, id, 'tally.discrepancy.manage');
      const a = await tx.discrepancyCaseAction.create({
        data: { tenantId: auth.tenantId, caseId: id, actorId: auth.userId, action: 'COMMENT', note: body.note },
        include: { actor: userRef },
      });
      await tx.discrepancyCase.update({ where: { id }, data: { updatedAt: new Date() } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_UPDATED,
          entityType: ENTITY.DISCREPANCY,
          entityId: id,
          after: { commentId: a.id },
        },
        tx,
      );
      return toAction(a);
    });
  }

  transition(auth: AuthContext, id: string, body: DiscrepancyTransition): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await this.loadInScope(tx, auth, id, 'tally.discrepancy.manage');
      if (!(MANUAL_TRANSITIONS[c.status] ?? []).includes(body.to)) {
        throw AppException.invalidTransition(c.status, body.to);
      }
      await this.setStatus(tx, id, c.status, { status: body.to });
      await tx.discrepancyCaseAction.create({
        data: {
          tenantId: auth.tenantId,
          caseId: id,
          actorId: auth.userId,
          action: `STATUS_${body.to}`,
          note: body.reason,
          data: { from: c.status, to: body.to },
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_UPDATED,
          entityType: ENTITY.DISCREPANCY,
          entityId: id,
          before: { status: c.status },
          after: { status: body.to },
          reason: body.reason,
        },
        tx,
      );
      return this.detailTx(tx, id);
    });
  }

  /**
   * POST /tally/discrepancies/:id/resolve. Records a reasoned decision. It may
   * designate a canonical record and exclude records (each change audited),
   * and sends held records back for a fresh independent review. It never
   * overwrites a source file or captured value.
   */
  resolve(auth: AuthContext, id: string, body: ResolveDiscrepancy): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await this.loadInScope(tx, auth, id, 'tally.discrepancy.resolve');
      this.assertOpen(c.status);
      const linked = new Set(c.links.map((l) => l.submissionId));
      if (body.canonicalSubmissionId && !linked.has(body.canonicalSubmissionId)) {
        throw AppException.validation('The canonical record must be one of the linked submissions');
      }
      const exclude = new Set(body.excludeSubmissionIds);
      for (const sid of exclude) {
        if (!linked.has(sid)) throw AppException.validation('Only linked submissions can be excluded');
      }
      if (body.canonicalSubmissionId && exclude.has(body.canonicalSubmissionId)) {
        throw AppException.validation('The canonical record cannot also be excluded');
      }
      // Exclusion needs tally.exclude over each excluded record, not just somewhere.
      for (const sid of exclude) await this.workflow.assertSubmissionInScope(tx, auth, 'tally.exclude', sid);
      if (body.canonicalSubmissionId) {
        await this.workflow.assertSubmissionInScope(tx, auth, 'tally.approve', body.canonicalSubmissionId);
      }

      // Separation of duties applies to the records this decision is about. For
      // duplicate and cross-stage cases that is the compared sources plus any
      // record being excluded or made canonical; RELATED links (and, for
      // cross-stage cases, every station record in the area) are context only.
      const decided = new Set<string>([...exclude, ...(body.canonicalSubmissionId ? [body.canonicalSubmissionId] : [])]);
      for (const l of c.links) {
        if (c.varianceType === 'CROSS_STAGE_MISMATCH') {
          if (l.role === 'SOURCE_B') decided.add(l.submissionId);
        } else if (c.varianceType === 'DUPLICATE') {
          if (l.role === 'SOURCE_A' || l.role === 'SOURCE_B') decided.add(l.submissionId);
        } else {
          decided.add(l.submissionId);
        }
      }
      for (const sid of decided) {
        this.workflow.sod(supervisorViolation(auth.userId, await this.workflow.participants(tx, sid)));
      }

      // An arithmetic decision covers the exact figures it was taken on ("figures as printed"):
      // fingerprint them so a later recapture with different figures reopens the check.
      const acceptedFigures: AcceptedFigures[] = [];
      if (c.varianceType === 'ARITHMETIC') {
        for (const sid of linked) {
          if (exclude.has(sid)) continue;
          const values = await tx.resultValue.findMany({
            where: { submissionId: sid },
            select: { fieldKey: true, candidateReferenceId: true, numericValue: true },
          });
          acceptedFigures.push({ submissionId: sid, fingerprint: figuresFingerprint(values) });
        }
      }

      // Claim the case first so two concurrent resolutions cannot both apply effects.
      const now = new Date();
      await this.setStatus(tx, id, c.status, {
        status: 'RESOLVED',
        resolution: body.resolution,
        resolvedById: auth.userId,
        resolvedAt: now,
      });

      const effects: Array<Record<string, unknown>> = [];
      const reason = `Discrepancy ${c.reference} resolved: ${body.resolution}`.slice(0, 2000);
      for (const sid of exclude) {
        const s = await tx.resultSubmission.findUniqueOrThrow({
          where: { id: sid },
          select: { id: true, tenantId: true, status: true, version: true },
        });
        if (s.status === 'EXCLUDED_FROM_AGGREGATE') continue;
        if (canTransitionSubmission(s.status, 'EXCLUDED_FROM_AGGREGATE')) {
          await this.workflow.transition(tx, s, 'EXCLUDED_FROM_AGGREGATE', reason);
        } else if (canTransitionSubmission(s.status, 'ARCHIVED')) {
          await this.workflow.transition(tx, s, 'ARCHIVED', reason);
        } else {
          throw AppException.invalidTransition(s.status, 'EXCLUDED_FROM_AGGREGATE');
        }
        effects.push({ submissionId: sid, effect: 'EXCLUDED' });
      }
      if (body.canonicalSubmissionId) {
        await this.submissions.setCanonical(tx, auth, body.canonicalSubmissionId, reason, { allowDemoteVerified: true });
        effects.push({ submissionId: body.canonicalSubmissionId, effect: 'CANONICAL' });
      }
      for (const sid of linked) {
        if (exclude.has(sid)) continue;
        const s = await tx.resultSubmission.findUniqueOrThrow({
          where: { id: sid },
          select: { id: true, tenantId: true, status: true, version: true, formTemplate: { select: { approvalState: true } } },
        });
        if (s.status === 'DISPUTED' && HOLDING_CASE_TYPES.includes(c.varianceType)) {
          // Only release records this case was holding, and only when no other
          // open holding case still holds them. Held records need a fresh
          // independent review; never straight to VERIFIED.
          const others = await this.workflow.openHoldingCases(tx, sid, c.id);
          if (others.length > 0) {
            effects.push({ submissionId: sid, effect: 'STILL_HELD', heldBy: others.map((o) => o.reference) });
            continue;
          }
          await this.workflow.transition(tx, s, 'SECOND_REVIEW_PENDING', reason);
          effects.push({ submissionId: sid, effect: 'RETURNED_TO_SECOND_REVIEW' });
        } else if (s.status === 'QUARANTINED' && c.varianceType === 'FORM_VERSION_MISMATCH' && s.formTemplate.approvalState === 'APPROVED') {
          await this.workflow.transition(tx, s, 'SUBMITTED', reason);
          effects.push({ submissionId: sid, effect: 'RELEASED_FROM_QUARANTINE' });
        }
      }

      await tx.discrepancyCaseAction.create({
        data: {
          tenantId: auth.tenantId,
          caseId: id,
          actorId: auth.userId,
          action: 'RESOLVED',
          note: body.resolution,
          // Every arithmetic resolution carries the key (possibly empty): its absence marks a
          // resolution recorded before fingerprints existed (domain/accepted-figures, legacy).
          data: { effects, ...(c.varianceType === 'ARITHMETIC' ? { acceptedFigures } : {}) } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_RESOLVED,
          entityType: ENTITY.DISCREPANCY,
          entityId: id,
          before: { status: c.status },
          after: { status: 'RESOLVED', effects, ...(c.varianceType === 'ARITHMETIC' ? { acceptedFigures } : {}) },
          reason: body.resolution,
        },
        tx,
      );
      return this.detailTx(tx, id);
    });
  }

  close(auth: AuthContext, id: string, body: CloseDiscrepancy): Promise<DiscrepancyCaseDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await this.loadInScope(tx, auth, id, 'tally.discrepancy.resolve');
      if (c.status !== 'RESOLVED') throw AppException.invalidTransition(c.status, 'CLOSED');
      this.workflow.sod(closureViolation(auth.userId, c.resolvedById));
      await this.setStatus(tx, id, 'RESOLVED', { status: 'CLOSED', closureApproverId: auth.userId, closedAt: new Date() });
      await tx.discrepancyCaseAction.create({
        data: { tenantId: auth.tenantId, caseId: id, actorId: auth.userId, action: 'CLOSED', note: body.closureNote },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_CLOSED,
          entityType: ENTITY.DISCREPANCY,
          entityId: id,
          before: { status: 'RESOLVED' },
          after: { status: 'CLOSED', closureApproverId: auth.userId },
          reason: body.closureNote,
        },
        tx,
      );
      return this.detailTx(tx, id);
    });
  }

  private assertOpen(status: DiscrepancyStatus): void {
    if (!OPEN_CASE_STATUSES.includes(status)) {
      throw AppException.conflict(`This case is ${status.toLowerCase()} and can no longer be changed`);
    }
  }
}

function toAction(a: {
  id: string;
  action: string;
  note: string | null;
  actor: { id: string; displayName: string };
  createdAt: Date;
}): DiscrepancyCaseAction {
  return { id: a.id, action: a.action, note: a.note, actor: a.actor, createdAt: iso(a.createdAt) };
}
