import { HttpStatus, Injectable } from '@nestjs/common';
import { nextReference, Prisma, type ResultSubmission, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  canTransitionSubmission,
  type DiscrepancyLinkRole,
  type DiscrepancySeverity,
  type DiscrepancyType,
  ERROR_CODES,
  type PermissionKey,
  type SubmissionStatus,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';
import { PermissionService } from '../../../rbac/permission.service';
import { type GeoLocation, pathToUnitIds, scopeAllows, STATION_GEO_SELECT, stationGeoLocation } from '../../../rbac/scope';
import {
  participantsOf,
  SOD_MESSAGES,
  type SodViolation,
  type SubmissionParticipants,
} from '../domain/separation-of-duties';
import { ENTITY, HOLDING_CASE_TYPES, OPEN_CASE_STATUSES } from '../tally.constants';

export interface OpenCaseInput {
  tenantId: string;
  electionCycleId: string;
  contestId: string | null;
  varianceType: DiscrepancyType;
  severity: DiscrepancySeverity;
  title: string;
  description: string;
  details?: Record<string, unknown>;
  links: Array<{ submissionId: string; role: DiscrepancyLinkRole }>;
  openedById: string;
  /** ESCALATED for reviewer disagreements (blueprint 8.5: escalate to tally supervisor). */
  status?: 'OPEN' | 'ESCALATED';
}

/**
 * Shared tally workflow primitives used by every tally service: audited status
 * transitions, discrepancy case creation, separation-of-duties checks,
 * geography checks and re-authentication checks. Every method takes the
 * caller's tenant transaction so the change and its audit event commit together.
 */
@Injectable()
export class TallyWorkflowService {
  constructor(
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly config: AppConfig,
  ) {}

  /* ------------------------------ Status changes ----------------------------- */

  /**
   * Move a submission to `to` after checking SUBMISSION_STATUS_TRANSITIONS.
   * Uses the row `version` for optimistic concurrency and writes
   * SUBMISSION_STATUS_CHANGED with before/after status and the reason.
   */
  async transition(
    tx: TenantTx,
    sub: Pick<ResultSubmission, 'id' | 'tenantId' | 'status' | 'version'>,
    to: SubmissionStatus,
    reason: string,
    extra: Prisma.ResultSubmissionUpdateManyMutationInput = {},
    actorId?: string | null,
  ): Promise<{ status: SubmissionStatus; version: number }> {
    if (!canTransitionSubmission(sub.status, to)) throw AppException.invalidTransition(sub.status, to);
    const res = await tx.resultSubmission.updateMany({
      where: { id: sub.id, version: sub.version },
      data: { ...extra, status: to, version: { increment: 1 } },
    });
    if (res.count !== 1) {
      throw AppException.conflict('This submission was changed by someone else. Reload and try again.');
    }
    await this.audit.record(
      {
        tenantId: sub.tenantId,
        ...(actorId !== undefined ? { actorId } : {}),
        action: AUDIT_ACTIONS.SUBMISSION_STATUS_CHANGED,
        entityType: ENTITY.SUBMISSION,
        entityId: sub.id,
        before: { status: sub.status, version: sub.version },
        after: { status: to, version: sub.version + 1 },
        reason,
      },
      tx,
    );
    return { status: to, version: sub.version + 1 };
  }

  /** Apply a chain of transitions (each validated and audited). */
  async transitionPath(
    tx: TenantTx,
    sub: Pick<ResultSubmission, 'id' | 'tenantId' | 'status' | 'version'>,
    path: SubmissionStatus[],
    reason: string,
    actorId?: string | null,
  ): Promise<{ status: SubmissionStatus; version: number }> {
    let cur = { status: sub.status, version: sub.version };
    for (const step of path) {
      cur = await this.transition(tx, { ...sub, ...cur }, step, reason, {}, actorId);
    }
    return cur;
  }

  /* ------------------------------ Discrepancies ------------------------------ */

  async openCase(tx: TenantTx, input: OpenCaseInput): Promise<{ id: string; reference: string }> {
    const reference = await nextReference(tx, input.tenantId, 'DSC');
    const links = dedupeLinks(input.links);
    const created = await tx.discrepancyCase.create({
      data: {
        tenantId: input.tenantId,
        reference,
        electionCycleId: input.electionCycleId,
        contestId: input.contestId,
        varianceType: input.varianceType,
        severity: input.severity,
        status: input.status ?? 'OPEN',
        title: input.title.slice(0, 300),
        description: input.description.slice(0, 4000),
        details: (input.details ?? {}) as Prisma.InputJsonValue,
        openedById: input.openedById,
        links: {
          create: links.map((l) => ({ tenantId: input.tenantId, submissionId: l.submissionId, role: l.role })),
        },
        actions: {
          create: {
            tenantId: input.tenantId,
            actorId: input.openedById,
            action: 'OPENED',
            note: input.description.slice(0, 4000),
            data: { varianceType: input.varianceType, status: input.status ?? 'OPEN' },
          },
        },
      },
      select: { id: true, reference: true },
    });
    await this.audit.record(
      {
        tenantId: input.tenantId,
        actorId: input.openedById,
        action: AUDIT_ACTIONS.DISCREPANCY_OPENED,
        entityType: ENTITY.DISCREPANCY,
        entityId: created.id,
        after: {
          reference,
          varianceType: input.varianceType,
          severity: input.severity,
          status: input.status ?? 'OPEN',
          links,
        },
      },
      tx,
    );
    return created;
  }

  /** Open holding cases linked to a submission (see HOLDING_CASE_TYPES), optionally ignoring one case. */
  async openHoldingCases(
    tx: TenantTx,
    submissionId: string,
    exceptCaseId?: string,
  ): Promise<Array<{ id: string; reference: string; varianceType: DiscrepancyType }>> {
    return tx.discrepancyCase.findMany({
      where: {
        status: { in: OPEN_CASE_STATUSES },
        varianceType: { in: [...HOLDING_CASE_TYPES] },
        links: { some: { submissionId } },
        ...(exceptCaseId ? { id: { not: exceptCaseId } } : {}),
      },
      select: { id: true, reference: true, varianceType: true },
    });
  }

  /** Throws CONFLICT while an open holding case is linked to the submission. */
  async assertNoOpenHoldingCase(tx: TenantTx, submissionId: string, action: string): Promise<void> {
    const open = await this.openHoldingCases(tx, submissionId);
    if (open.length > 0) {
      throw AppException.conflict(
        `Resolve discrepancy case ${open.map((c) => c.reference).join(', ')} before you ${action}.`,
        { openCases: open },
      );
    }
  }

  /**
   * Resolve open cases of `type` linked to a submission as part of another
   * reasoned decision (e.g. a supervisor rejecting a disputed verification).
   * Audited like a manual resolution.
   */
  async resolveLinkedCases(
    tx: TenantTx,
    auth: AuthContext,
    submissionId: string,
    type: DiscrepancyType,
    resolution: string,
    data: Record<string, unknown>,
  ): Promise<string[]> {
    const cases = await tx.discrepancyCase.findMany({
      where: { varianceType: type, status: { in: OPEN_CASE_STATUSES }, links: { some: { submissionId } } },
      select: { id: true, status: true },
    });
    const now = new Date();
    for (const c of cases) {
      const r = await tx.discrepancyCase.updateMany({
        where: { id: c.id, status: { in: OPEN_CASE_STATUSES } },
        data: { status: 'RESOLVED', resolution, resolvedById: auth.userId, resolvedAt: now },
      });
      if (r.count !== 1) throw AppException.conflict('This case was changed by someone else. Reload and try again.');
      await tx.discrepancyCaseAction.create({
        data: { tenantId: auth.tenantId, caseId: c.id, actorId: auth.userId, action: 'RESOLVED', note: resolution, data: data as Prisma.InputJsonValue },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DISCREPANCY_RESOLVED,
          entityType: ENTITY.DISCREPANCY,
          entityId: c.id,
          before: { status: c.status },
          after: { status: 'RESOLVED', ...data },
          reason: resolution,
        },
        tx,
      );
    }
    return cases.map((c) => c.id);
  }

  /** Open case of a type already linked to the submission, if any. */
  async findOpenCase(tx: TenantTx, submissionId: string, type: DiscrepancyType): Promise<{ id: string } | null> {
    return tx.discrepancyCase.findFirst({
      where: { varianceType: type, status: { in: OPEN_CASE_STATUSES }, links: { some: { submissionId } } },
      select: { id: true },
    });
  }

  /**
   * Hold a submission from the verified aggregate by moving it to DISPUTED when
   * the transition is allowed (blueprint 8.5 arithmetic / reviewer disagreement).
   * Returns false when the status cannot move to DISPUTED (e.g. already held).
   */
  async hold(
    tx: TenantTx,
    submissionId: string,
    reason: string,
    actorId?: string | null,
  ): Promise<boolean> {
    const sub = await tx.resultSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, tenantId: true, status: true, version: true },
    });
    if (!sub || !canTransitionSubmission(sub.status, 'DISPUTED')) return false;
    await this.transition(tx, sub, 'DISPUTED', reason, {}, actorId);
    return true;
  }

  /* --------------------------- Separation of duties -------------------------- */

  async participants(tx: TenantTx, submissionId: string): Promise<SubmissionParticipants> {
    const sub = await tx.resultSubmission.findUnique({
      where: { id: submissionId },
      select: {
        submitterId: true,
        valueChanges: { select: { actorId: true } },
        values: { select: { id: true, confirmedById: true } },
        verifications: { select: { reviewerId: true, supervisorId: true } },
        discrepancyLinks: { select: { case: { select: { resolvedById: true } } } },
      },
    });
    if (!sub) throw AppException.notFound('Submission not found');
    // Confirmations and declaration edits are only fully recorded in the
    // append-only audit stream (value rows keep the latest confirmer only).
    const audit = await tx.auditEvent.findMany({
      where: {
        action: AUDIT_ACTIONS.RESULT_VALUE_CHANGED,
        entityId: { in: [submissionId, ...sub.values.map((v) => v.id)] },
      },
      select: { actorId: true },
      distinct: ['actorId'],
    });
    return participantsOf({
      submitterId: sub.submitterId,
      valueChanges: sub.valueChanges,
      values: sub.values,
      valueAuditActorIds: audit.map((a) => a.actorId),
      verifications: sub.verifications,
      resolvedCases: sub.discrepancyLinks.map((l) => l.case),
    });
  }

  /**
   * Bulk form of `participants()` for the work-queue filters: every record in `statuses` that
   * `userId` took part in, with that user's roles on it drawn from the same sources as
   * `participants()` (submitter, value changes, current confirmers, the append-only audit stream
   * of value changes and confirmations, verifications, supervisor actions, resolved cases), plus
   * whether the latest review round asked for a third check. Records the user never touched are
   * not returned (no rule can stop them). The sets hold only `userId`, which is all the
   * separation-of-duties rules look at for that user.
   */
  async participationOf(
    tx: TenantTx,
    who: { tenantId: string; userId: string },
    statuses: ReadonlyArray<SubmissionStatus>,
  ): Promise<Array<{ submissionId: string; participants: SubmissionParticipants; thirdCheckRequested: boolean }>> {
    const u = who.userId;
    const rows = await tx.$queryRaw<
      Array<{ id: string; submitter: boolean; editor: boolean; verifier: boolean; supervisor: boolean; resolver: boolean; last_action: string | null }>
    >`
      WITH audited AS (
        SELECT DISTINCT a.entity_id FROM audit_events a
         WHERE a.tenant_id = ${who.tenantId}::uuid AND a.actor_id = ${u}::uuid
           AND a.action = ${AUDIT_ACTIONS.RESULT_VALUE_CHANGED} AND a.entity_id IS NOT NULL
      ),
      roles AS (
        SELECT s.id,
               s.submitter_id = ${u}::uuid AS submitter,
               (EXISTS (SELECT 1 FROM result_value_changes c WHERE c.submission_id = s.id AND c.actor_id = ${u}::uuid)
                 OR EXISTS (SELECT 1 FROM result_values v WHERE v.submission_id = s.id AND v.confirmed_by_id = ${u}::uuid)
                 OR EXISTS (SELECT 1 FROM audited x WHERE x.entity_id = s.id::text)
                 OR EXISTS (SELECT 1 FROM result_values v JOIN audited x ON x.entity_id = v.id::text WHERE v.submission_id = s.id)) AS editor,
               EXISTS (SELECT 1 FROM verifications v WHERE v.submission_id = s.id AND v.reviewer_id = ${u}::uuid) AS verifier,
               EXISTS (SELECT 1 FROM verifications v WHERE v.submission_id = s.id AND v.supervisor_id = ${u}::uuid) AS supervisor,
               EXISTS (SELECT 1 FROM discrepancy_case_submissions l JOIN discrepancy_cases c ON c.id = l.case_id
                        WHERE l.submission_id = s.id AND c.resolved_by_id = ${u}::uuid) AS resolver
          FROM result_submissions s
         WHERE s.tenant_id = ${who.tenantId}::uuid AND s.status::text = ANY(${[...statuses]}::text[])
      )
      SELECT r.*,
             (SELECT v.supervisor_action::text FROM verifications v WHERE v.submission_id = r.id
               ORDER BY v.round DESC, v.reviewed_at DESC LIMIT 1) AS last_action
        FROM roles r
       WHERE r.submitter OR r.editor OR r.verifier OR r.supervisor OR r.resolver`;
    const only = (on: boolean): ReadonlySet<string> => (on ? new Set([u]) : new Set<string>());
    return rows.map((r) => ({
      submissionId: r.id,
      participants: {
        // Any id other than the user's when they did not submit it.
        submitterId: r.submitter ? u : '',
        editorIds: only(r.editor),
        verifierIds: only(r.verifier),
        supervisorIds: only(r.supervisor),
        resolverIds: only(r.resolver),
      },
      thirdCheckRequested: r.last_action === 'THIRD_CHECK_REQUESTED',
    }));
  }

  sod(violation: SodViolation | null): void {
    if (violation) throw AppException.separationOfDuties(SOD_MESSAGES[violation]);
  }

  /* ------------------------------ Authorisation ------------------------------ */

  requirePermission(auth: AuthContext, permission: PermissionKey): void {
    if (!auth.permissions.has(permission)) throw AppException.forbidden(undefined, { required: [permission] });
  }

  /** Re-authentication check for high-risk effects decided inside a handler. */
  requireReauth(auth: AuthContext): void {
    const now = Math.floor(Date.now() / 1000);
    if (auth.reauthAt === null || now - auth.reauthAt > this.config.values.REAUTH_WINDOW_SECONDS) {
      throw new AppException(ERROR_CODES.REAUTH_REQUIRED, HttpStatus.UNAUTHORIZED, 'Please confirm your password to continue');
    }
  }

  /** Throws OUT_OF_SCOPE unless `location` is inside the caller's grant of `permission`. */
  assertInScope(auth: AuthContext, permission: PermissionKey, location: GeoLocation): void {
    const scope = this.permissions.scopeFor(auth, permission);
    if (!scope.held) throw AppException.forbidden(undefined, { required: [permission] });
    if (!scopeAllows(scope, location)) throw AppException.outOfScope();
  }

  /** Geography and election cycle of a submission (station location or tally-centre unit path). */
  async submissionLocation(tx: TenantTx, submissionId: string): Promise<GeoLocation | null> {
    const s = await tx.resultSubmission.findUnique({
      where: { id: submissionId },
      select: {
        electionCycleId: true,
        pollingStation: { select: STATION_GEO_SELECT },
        geographicUnit: { select: { path: true } },
      },
    });
    if (!s) return null;
    if (s.pollingStation) return { ...stationGeoLocation(s.pollingStation), electionCycleId: s.electionCycleId };
    return {
      unitIds: s.geographicUnit ? pathToUnitIds(s.geographicUnit.path) : [],
      stationId: null,
      electionCycleId: s.electionCycleId,
    };
  }

  /**
   * OUT_OF_SCOPE unless the submission is inside the caller's grant of
   * `permission` (geography and election cycle). Throws NOT_FOUND when the
   * submission does not exist; never skips the check.
   */
  async assertSubmissionInScope(tx: TenantTx, auth: AuthContext, permission: PermissionKey, submissionId: string): Promise<void> {
    const loc = await this.submissionLocation(tx, submissionId);
    if (!loc) throw AppException.notFound('Submission not found');
    this.assertInScope(auth, permission, loc);
  }

  /**
   * Union of linked submissions' geography (the 'discrepancy' geo resolver,
   * used for read access: a case is visible when any linked record is).
   * Changes to a case check every affected submission separately.
   */
  async caseLocation(tx: TenantTx, caseId: string): Promise<GeoLocation | null> {
    const c = await tx.discrepancyCase.findUnique({
      where: { id: caseId },
      select: { electionCycleId: true, links: { select: { submissionId: true } } },
    });
    if (!c) return null;
    const unitIds = new Set<string>();
    let stationId: string | null = null;
    let stationKey: string | null = null;
    for (const l of c.links) {
      const loc = await this.submissionLocation(tx, l.submissionId);
      if (!loc) continue;
      loc.unitIds.forEach((u) => unitIds.add(u));
      if (!stationId) {
        stationId = loc.stationId;
        stationKey = loc.stationKey ?? null;
      }
    }
    return { unitIds: [...unitIds], stationId, stationKey, electionCycleId: c.electionCycleId };
  }
}

function dedupeLinks(
  links: Array<{ submissionId: string; role: DiscrepancyLinkRole }>,
): Array<{ submissionId: string; role: DiscrepancyLinkRole }> {
  const seen = new Map<string, DiscrepancyLinkRole>();
  for (const l of links) if (!seen.has(l.submissionId)) seen.set(l.submissionId, l.role);
  return [...seen.entries()].map(([submissionId, role]) => ({ submissionId, role }));
}
