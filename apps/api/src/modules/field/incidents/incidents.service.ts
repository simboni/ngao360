import { HttpStatus, Injectable } from '@nestjs/common';
import { nextReference, Prisma, type TenantTx } from '@ngao360/db';
import {
  type UserRef,
  AUDIT_ACTIONS,
  type AddIncidentEvent,
  type AssignIncident,
  type AttachEvidence,
  type AuditEvent,
  type CloseIncident,
  type CreateIncident,
  ERROR_CODES,
  type EscalateIncident,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_ESCALATION_TARGET_LABELS,
  INCIDENT_SEVERITY_LABELS,
  type IncidentDetail,
  type IncidentEvent,
  type IncidentQuery,
  type IncidentStatus,
  type IncidentSubject,
  type IncidentSummary,
  type Paginated,
  type PermissionKey,
  type RecordIncidentSubject,
  type ReopenIncident,
  type ResolveIncident,
  type SignedUrlResponse,
  type TriageIncident,
  canTransitionIncident,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { scopeAllows } from '../../../rbac/scope';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { ClientSubmissionLedger } from '../common/client-submission.ledger';
import { resolveFieldCycle } from '../common/field-cycle';
import { fieldGeoLocation, fieldScopeWhere, loadFieldLocations, resolveFieldLocation } from '../common/field-location';
import {
  isIdempotencyKeyViolation,
  assertAgentDeployedAt,
  USER_REF,
  asArray,
  assertOfflineAge,
  auditEventsFor,
  issueFieldFileUrl,
  iso,
  loadOwnEvidenceFiles,
  notifyUsers,
  paging,
  serverChanged,
  usersWithPermission,
} from '../common/field-support';
import type { FieldWriteContext } from '../deployment/deployment.service';
import { FIELD_ENTITY } from '../field.constants';

const INCIDENT_INCLUDE = {
  reporter: USER_REF,
  assignee: USER_REF,
  resolvedBy: USER_REF,
  closedBy: USER_REF,
  _count: { select: { evidence: true, subjects: true } },
} satisfies Prisma.IncidentInclude;
type IncidentRow = Prisma.IncidentGetPayload<{ include: typeof INCIDENT_INCLUDE }>;

const RETRIAGE_STATUSES: IncidentStatus[] = ['TRIAGED', 'ASSIGNED', 'ESCALATED'];

/**
 * Incident desk (blueprint 7.3, S17). The original report is immutable (DB
 * trigger); triage, assignment, escalation, notes, corrections, referrals,
 * evidence holds, resolution, closure and reopening are appended as
 * incident_events in the same transaction as the status change. Names of
 * people or bodies go only into the restricted subject record.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly ledger: ClientSubmissionLedger,
  ) {}

  /* --------------------------------- helpers -------------------------------- */

  private can(auth: AuthContext, perm: PermissionKey, i: Parameters<typeof fieldGeoLocation>[0]): boolean {
    return auth.permissions.has(perm) && scopeAllows(this.permissions.scopeFor(auth, perm), fieldGeoLocation(i));
  }

  private async load(tx: TenantTx, id: string): Promise<IncidentRow> {
    const i = await tx.incident.findUnique({ where: { id }, include: INCIDENT_INCLUDE });
    if (!i) throw AppException.notFound('Incident not found');
    return i;
  }

  /** The incident, readable by a field.incidents.view holder in scope or by its reporter. */
  private async loadReadable(tx: TenantTx, auth: AuthContext, id: string): Promise<IncidentRow> {
    const i = await this.load(tx, id);
    if (i.reporterId !== auth.userId && !this.can(auth, 'field.incidents.view', i)) {
      if (auth.permissions.has('field.incidents.view')) throw AppException.outOfScope();
      throw AppException.notFound('Incident not found');
    }
    return i;
  }

  private assertVersion(i: IncidentRow, expected: number, state: () => Promise<unknown>): Promise<void> {
    if (i.version === expected) return Promise.resolve();
    return state().then((s) => {
      throw serverChanged(i.version, s);
    });
  }

  private async update(tx: TenantTx, auth: AuthContext, i: IncidentRow, expectedVersion: number, data: Prisma.IncidentUncheckedUpdateManyInput): Promise<void> {
    const r = await tx.incident.updateMany({ where: { id: i.id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) throw serverChanged(i.version, await this.detailInTx(tx, auth, i.id));
  }

  private async event(
    tx: TenantTx,
    auth: AuthContext,
    incidentId: string,
    type: Prisma.IncidentEventUncheckedCreateInput['type'],
    from: IncidentStatus | null,
    to: IncidentStatus | null,
    note: string | null,
    data: Record<string, unknown> = {},
    fileIds: string[] = [],
  ) {
    return tx.incidentEvent.create({
      data: { tenantId: auth.tenantId, incidentId, type, fromStatus: from, toStatus: to, note, data: data as Prisma.InputJsonValue, fileIds, actorId: auth.userId },
      include: { actor: USER_REF },
    });
  }

  private toEvent(e: Prisma.IncidentEventGetPayload<{ include: { actor: typeof USER_REF } }>): IncidentEvent {
    return {
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      data: (e.data ?? {}) as Record<string, unknown>,
      fileIds: e.fileIds,
      actor: e.actor,
      createdAt: e.createdAt.toISOString(),
    };
  }

  /**
   * Active users who may be assigned this incident: field.incidents.triage over
   * its location (the same rule assign/escalate re-check). Names only.
   */
  assignableUsers(_auth: AuthContext, id: string): Promise<UserRef[]> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      const ids = await usersWithPermission(tx, 'field.incidents.triage', fieldGeoLocation(i));
      if (ids.length === 0) return [];
      return tx.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' }, take: 500 });
    });
  }

  /** The assignee must be ACTIVE and hold field.incidents.triage over the incident location (400). */
  private async assertAssignee(tx: TenantTx, i: IncidentRow, assigneeId: string): Promise<void> {
    const ok = await usersWithPermission(tx, 'field.incidents.triage', fieldGeoLocation(i), { only: [assigneeId] });
    if (ok.length === 0) {
      throw AppException.validation('Choose an active colleague who handles incidents in this area', [{ path: ['assigneeId'], message: 'Cannot handle this incident' }]);
    }
  }

  private async summaries(tx: TenantTx, rows: IncidentRow[]): Promise<IncidentSummary[]> {
    const locations = await loadFieldLocations(tx, rows);
    const now = Date.now();
    return rows.map((i, n) => ({
      id: i.id,
      reference: i.reference,
      category: i.category,
      reportedCategory: i.reportedCategory,
      initialSeverity: i.initialSeverity,
      severity: i.severity,
      status: i.status,
      outcome: i.outcome,
      location: locations[n]!,
      occurredAt: i.occurredAt.toISOString(),
      reportedAt: i.reportedAt.toISOString(),
      descriptionPreview: i.description.length > 160 ? `${i.description.slice(0, 157)}…` : i.description,
      reporter: i.reporter,
      assignee: i.assignee,
      escalatedTo: i.escalatedTo,
      evidenceHold: i.evidenceHold,
      evidenceCount: i._count.evidence,
      ageMinutes: Math.max(0, Math.floor((now - i.reportedAt.getTime()) / 60_000)),
      submittedOffline: i.submittedOffline,
      updatedAt: i.updatedAt.toISOString(),
    }));
  }

  private allowedActions(auth: AuthContext, i: IncidentRow): IncidentDetail['allowedActions'] {
    const out: IncidentDetail['allowedActions'] = [];
    const open = i.status !== 'CLOSED';
    const isReporter = i.reporterId === auth.userId;
    const triage = this.can(auth, 'field.incidents.triage', i);
    const escalate = this.can(auth, 'field.incidents.escalate', i);
    if (triage && !isReporter && (i.status === 'REPORTED' || RETRIAGE_STATUSES.includes(i.status))) out.push('triage');
    if (this.can(auth, 'field.incidents.assign', i) && ['TRIAGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED'].includes(i.status)) out.push('assign');
    if (escalate && canTransitionIncident(i.status, 'ESCALATED')) out.push('escalate');
    if (triage && open) out.push('add_note');
    if ((isReporter || triage) && open) out.push('add_correction', 'add_evidence');
    if (escalate && open) out.push('evidence_hold', 'refer');
    if (this.can(auth, 'field.incidents.view_subject', i)) out.push('record_subject', 'view_subject');
    if (this.can(auth, 'field.incidents.resolve', i) && canTransitionIncident(i.status, 'RESOLVED')) out.push('resolve');
    const close = this.can(auth, 'field.incidents.close', i);
    if (close && i.status === 'RESOLVED' && !isReporter && i.resolvedById !== auth.userId) out.push('close');
    if (close && i.status === 'CLOSED') out.push('reopen');
    return out;
  }

  async detailInTx(tx: TenantTx, auth: AuthContext, id: string): Promise<IncidentDetail> {
    const i = await this.loadReadable(tx, auth, id);
    const viewer = this.can(auth, 'field.incidents.view', i);
    const [summary] = await this.summaries(tx, [i]);
    const [events, evidence] = await Promise.all([
      tx.incidentEvent.findMany({ where: { incidentId: id }, include: { actor: USER_REF }, orderBy: { createdAt: 'asc' } }),
      tx.incidentEvidence.findMany({ where: { incidentId: id }, include: { storedFile: { select: { mimeType: true, sizeBytes: true, sha256: true } }, addedBy: USER_REF }, orderBy: { createdAt: 'asc' } }),
    ]);
    // Reporter-only callers see the report, status, outcome and their own entries; other people's notes stay hidden.
    const visibleEvents = viewer
      ? events.map((e) => this.toEvent(e))
      : events.map((e) => (e.actorId === auth.userId ? this.toEvent(e) : { ...this.toEvent(e), note: null, data: {}, fileIds: [], actor: { id: e.actorId, displayName: 'Incident desk' } }));
    const visibleEvidence = viewer ? evidence : evidence.filter((e) => e.original || e.addedById === auth.userId);
    return {
      ...summary!,
      assignee: viewer ? summary!.assignee : null,
      description: i.description,
      locationDescription: i.locationDescription,
      point: i.latitude !== null && i.longitude !== null ? { latitude: Number(i.latitude), longitude: Number(i.longitude), accuracyMetres: null, capturedAt: i.occurredAt.toISOString() } : null,
      sensitivity: i.sensitivity,
      evidence: visibleEvidence.map((e) => ({
        fileId: e.storedFileId,
        mimeType: e.storedFile.mimeType,
        sizeBytes: Number(e.storedFile.sizeBytes),
        sha256: e.storedFile.sha256,
        addedBy: e.addedBy,
        addedAt: e.createdAt.toISOString(),
        original: e.original,
      })),
      evidenceCount: visibleEvidence.length,
      events: visibleEvents,
      hasSubject: viewer ? i._count.subjects > 0 : false,
      resolutionNote: viewer ? i.resolutionNote : null,
      resolvedBy: viewer ? i.resolvedBy : null,
      closureNote: viewer ? i.closureNote : null,
      closedBy: viewer ? i.closedBy : null,
      closedAt: iso(i.closedAt),
      clientCreatedAt: iso(i.clientCreatedAt),
      version: i.version,
      allowedActions: this.allowedActions(auth, i),
    };
  }

  /* ---------------------------------- reads --------------------------------- */

  list(auth: AuthContext, q: IncidentQuery): Promise<Paginated<IncidentSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const and: Prisma.IncidentWhereInput[] = [];
      if (auth.permissions.has('field.incidents.view')) {
        const scoped = fieldScopeWhere(this.permissions.scopeFor(auth, 'field.incidents.view')) as Prisma.IncidentWhereInput | undefined;
        // Organisation-wide scope adds no filter; otherwise in-scope rows plus the caller's own reports.
        if (scoped) and.push({ OR: [scoped, { reporterId: auth.userId }] });
      } else {
        and.push({ reporterId: auth.userId });
      }
      if (q.view === 'open') and.push({ status: { not: 'CLOSED' } });
      if (q.view === 'assigned_to_me') and.push({ assigneeId: auth.userId, status: { not: 'CLOSED' } });
      if (q.view === 'unassigned') and.push({ assigneeId: null, status: { in: ['REPORTED', 'TRIAGED', 'ESCALATED'] } });
      if (q.view === 'mine') and.push({ reporterId: auth.userId });
      if (q.electionCycleId) and.push({ electionCycleId: q.electionCycleId });
      if (q.countyId) and.push({ countyId: q.countyId });
      if (q.constituencyId) and.push({ constituencyId: q.constituencyId });
      if (q.wardId) and.push({ wardId: q.wardId });
      if (q.pollingStationCode) and.push({ pollingStationCode: q.pollingStationCode });
      const statuses = asArray(q.status);
      if (statuses) and.push({ status: { in: statuses } });
      const severities = asArray(q.severity);
      if (severities) and.push({ severity: { in: severities } });
      if (q.category) and.push({ category: q.category });
      if (q.from) and.push({ occurredAt: { gte: new Date(q.from) } });
      if (q.to) and.push({ occurredAt: { lte: new Date(q.to) } });
      if (q.q) and.push({ OR: [{ reference: { contains: q.q, mode: 'insensitive' } }, { pollingStationCode: { contains: q.q, mode: 'insensitive' } }] });
      const where: Prisma.IncidentWhereInput = { AND: and };
      const orderBy: Prisma.IncidentOrderByWithRelationInput[] =
        q.sort === 'reportedAt' ? [{ reportedAt: q.order }] : q.sort === 'updatedAt' ? [{ updatedAt: q.order }] : [{ severity: 'desc' }, { reportedAt: 'asc' }];
      const [rows, total] = await Promise.all([tx.incident.findMany({ where, include: INCIDENT_INCLUDE, orderBy, ...paging(q) }), tx.incident.count({ where })]);
      const items = await this.summaries(tx, rows);
      // Reporter-only rows do not show who handles the incident.
      return {
        items: items.map((s, n) => (this.can(auth, 'field.incidents.view', rows[n]!) ? s : { ...s, assignee: null })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      };
    });
  }

  detail(auth: AuthContext, id: string): Promise<IncidentDetail> {
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, auth, id));
  }

  history(auth: AuthContext, id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      return auditEventsFor(tx, [id], auth);
    });
  }

  /* --------------------------------- intake --------------------------------- */

  /** Exactly the checks and writes of POST /field/incidents, without the ledger (the caller wraps it). */
  async reportInTx(tx: TenantTx, auth: AuthContext, dto: CreateIncident, ctx: FieldWriteContext): Promise<IncidentDetail> {
    const config = await this.modules.fieldConfig(tx);
    assertOfflineAge(config, dto.clientCreatedAt);
    if (new Date(dto.occurredAt).getTime() > Date.now() + 5 * 60_000) {
      throw AppException.validation('The incident time is in the future', [{ path: ['occurredAt'], message: 'Check the date and time' }]);
    }
    const cycle = await resolveFieldCycle(tx, config, dto.electionCycleId);
    const loc = await resolveFieldLocation(tx, cycle.id, dto.location);
    if (!scopeAllows(this.permissions.scopeFor(auth, 'field.incidents.report'), fieldGeoLocation(loc))) {
      throw AppException.outOfScope('You can only report incidents at your own station(s) or area');
    }
    await assertAgentDeployedAt(tx, auth, cycle.id, loc.pollingStationCode, 'You can only report incidents at the station(s) you are deployed to');
    const files = await loadOwnEvidenceFiles(tx, auth, dto.evidenceFileIds, ['evidenceFileIds']);
    const severity = config.incidentSeverityDefaults[dto.category];
    const reference = await nextReference(tx, auth.tenantId, 'INC', cycle.electionDate.getUTCFullYear());
    let created: { id: string };
    try {
      created = await tx.incident.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          electionCycleId: cycle.id,
          reportedCategory: dto.category,
          category: dto.category,
          initialSeverity: severity,
          severity,
          occurredAt: new Date(dto.occurredAt),
          pollingStationCode: loc.pollingStationCode,
          geographicUnitId: loc.geographicUnitId,
          countyId: loc.countyId,
          constituencyId: loc.constituencyId,
          wardId: loc.wardId,
          pollingCentreId: loc.pollingCentreId,
          locationDescription: dto.locationDescription,
          latitude: dto.point ? new Prisma.Decimal(dto.point.latitude.toFixed(6)) : null,
          longitude: dto.point ? new Prisma.Decimal(dto.point.longitude.toFixed(6)) : null,
          description: dto.description,
          reporterId: auth.userId,
          submittedOffline: dto.submittedOffline,
          clientIdempotencyKey: dto.clientIdempotencyKey,
          deviceId: dto.deviceId,
          clientCreatedAt: new Date(dto.clientCreatedAt),
        },
        select: { id: true },
      });
    } catch (e) {
      // Only the client idempotency key's unique index means "sent before"; any other
      // unique violation (e.g. a reference collision) is a server error, not the device's.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && isIdempotencyKeyViolation(e)) {
        throw new AppException(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, HttpStatus.CONFLICT, 'This incident was already sent with different content. Save it again as a new report.');
      }
      throw e;
    }
    await this.event(tx, auth, created.id, 'REPORTED', null, 'REPORTED', null, { category: dto.category, severity, submittedOffline: dto.submittedOffline });
    if (files.length > 0) {
      await tx.incidentEvidence.createMany({ data: files.map((f) => ({ tenantId: auth.tenantId, incidentId: created.id, storedFileId: f.id, original: true, addedById: auth.userId })) });
      await this.event(tx, auth, created.id, 'EVIDENCE_ADDED', null, null, null, { original: true }, files.map((f) => f.id));
    }
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.INCIDENT_REPORTED,
        entityType: FIELD_ENTITY.INCIDENT,
        entityId: created.id,
        after: {
          reference,
          category: dto.category,
          severity,
          pollingStationCode: loc.pollingStationCode,
          geographicUnitId: loc.geographicUnitId,
          submittedOffline: dto.submittedOffline,
          descriptionLength: dto.description.length,
          evidenceFileIds: files.map((f) => f.id),
          via: ctx.via,
          deviceId: ctx.deviceId,
        },
      },
      tx,
    );
    if (severity === 'HIGH' || severity === 'CRITICAL') {
      const desk = await usersWithPermission(tx, 'field.incidents.triage', fieldGeoLocation(loc));
      await notifyUsers(tx, auth.tenantId, desk.filter((u) => u !== auth.userId), {
        module: 'field',
        type: 'incident.reported',
        title: `${INCIDENT_SEVERITY_LABELS[severity]} incident reported`,
        body: `${reference}: ${INCIDENT_CATEGORY_LABELS[dto.category]}${loc.pollingStationCode ? ` at station ${loc.pollingStationCode}` : ''}.`,
        link: `/field/incidents/${created.id}`,
      });
    }
    return this.detailInTx(tx, auth, created.id);
  }

  report(auth: AuthContext, dto: CreateIncident): Promise<{ replayed: boolean; result: IncidentDetail }> {
    return this.prisma.tenantTx((tx) =>
      this.ledger.run(
        tx,
        auth,
        { idempotencyKey: dto.clientIdempotencyKey, deviceId: dto.deviceId, kind: 'INCIDENT', clientCreatedAt: dto.clientCreatedAt, payload: dto },
        { type: FIELD_ENTITY.INCIDENT, id: (r) => r.id, reference: (r) => r.reference },
        () => this.reportInTx(tx, auth, dto, { via: 'api', deviceId: dto.deviceId }),
        (resultId) => this.detailInTx(tx, auth, resultId),
      ),
    );
  }

  /* -------------------------------- workflow -------------------------------- */

  triage(auth: AuthContext, id: string, dto: TriageIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      if (i.reporterId === auth.userId) throw AppException.separationOfDuties('You cannot triage an incident you reported');
      const statusChange = i.status === 'REPORTED';
      if (!statusChange && !RETRIAGE_STATUSES.includes(i.status)) throw AppException.invalidTransition(i.status, 'TRIAGED');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      await this.update(tx, auth, i, dto.expectedVersion, {
        ...(statusChange ? { status: 'TRIAGED' } : {}),
        severity: dto.severity,
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.sensitivity ? { sensitivity: dto.sensitivity } : {}),
      });
      const data: Record<string, unknown> = { severity: dto.severity, previousSeverity: i.severity };
      if (dto.category && dto.category !== i.category) Object.assign(data, { category: dto.category, previousCategory: i.category });
      if (dto.sensitivity && dto.sensitivity !== i.sensitivity) Object.assign(data, { sensitivity: dto.sensitivity, previousSensitivity: i.sensitivity });
      await this.event(tx, auth, id, 'TRIAGED', i.status, statusChange ? 'TRIAGED' : i.status, dto.note, data);
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_TRIAGED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: i.status, severity: i.severity, category: i.category }, after: { status: statusChange ? 'TRIAGED' : i.status, ...data }, reason: dto.note },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  private clearResolution(): Prisma.IncidentUncheckedUpdateManyInput {
    return { outcome: null, resolutionNote: null, resolvedById: null, resolvedAt: null, duplicateOfId: null };
  }

  assign(auth: AuthContext, id: string, dto: AssignIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      const reassign = i.status === 'ASSIGNED';
      if (!reassign && !(['TRIAGED', 'ESCALATED', 'RESOLVED'] as IncidentStatus[]).includes(i.status)) throw AppException.invalidTransition(i.status, 'ASSIGNED');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      await this.assertAssignee(tx, i, dto.assigneeId);
      await this.update(tx, auth, i, dto.expectedVersion, { status: 'ASSIGNED', assigneeId: dto.assigneeId, ...(i.status === 'RESOLVED' ? this.clearResolution() : {}) });
      await this.event(tx, auth, id, 'ASSIGNED', i.status, 'ASSIGNED', dto.note, { assigneeId: dto.assigneeId, previousAssigneeId: i.assigneeId });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_ASSIGNED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: i.status, assigneeId: i.assigneeId }, after: { status: 'ASSIGNED', assigneeId: dto.assigneeId } },
        tx,
      );
      if (dto.assigneeId !== auth.userId) {
        await notifyUsers(tx, auth.tenantId, [dto.assigneeId], {
          module: 'field',
          type: 'incident.assigned',
          title: 'Incident assigned to you',
          body: `${i.reference}: ${INCIDENT_CATEGORY_LABELS[i.category]} (${INCIDENT_SEVERITY_LABELS[i.severity]}).`,
          link: `/field/incidents/${id}`,
        });
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  escalate(auth: AuthContext, id: string, dto: EscalateIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      if (!canTransitionIncident(i.status, 'ESCALATED')) throw AppException.invalidTransition(i.status, 'ESCALATED');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      if (dto.assigneeId) await this.assertAssignee(tx, i, dto.assigneeId);
      await this.update(tx, auth, i, dto.expectedVersion, {
        status: 'ESCALATED',
        escalatedTo: dto.target,
        ...(dto.assigneeId ? { assigneeId: dto.assigneeId } : {}),
        ...(i.status === 'RESOLVED' ? this.clearResolution() : {}),
      });
      await this.event(tx, auth, id, 'ESCALATED', i.status, 'ESCALATED', dto.reason, { target: dto.target, assigneeId: dto.assigneeId });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_ESCALATED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: i.status }, after: { status: 'ESCALATED', target: dto.target, assigneeId: dto.assigneeId }, reason: dto.reason },
        tx,
      );
      const commanders = await usersWithPermission(tx, 'warroom.command', fieldGeoLocation(i));
      const body = `${i.reference}: ${INCIDENT_CATEGORY_LABELS[i.category]} (${INCIDENT_SEVERITY_LABELS[i.severity]}) escalated to ${INCIDENT_ESCALATION_TARGET_LABELS[dto.target]}.`;
      await notifyUsers(tx, auth.tenantId, commanders.filter((u) => u !== auth.userId), { module: 'warroom', type: 'incident.escalated', title: 'Incident escalated', body, link: `/field/incidents/${id}` });
      if (dto.assigneeId && dto.assigneeId !== auth.userId) {
        await notifyUsers(tx, auth.tenantId, [dto.assigneeId], { module: 'field', type: 'incident.assigned', title: 'Escalated incident assigned to you', body, link: `/field/incidents/${id}` });
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  /**
   * Append a note, correction, referral or evidence hold. The reporter may add a
   * CORRECTION to their own incident; a correction never changes the original report.
   */
  async addEventInTx(tx: TenantTx, auth: AuthContext, id: string, dto: AddIncidentEvent, ctx: FieldWriteContext): Promise<IncidentEvent> {
    const i = await this.load(tx, id);
    const isReporter = i.reporterId === auth.userId && auth.permissions.has('field.incidents.report');
    const needsEscalate = dto.type === 'REFERRED' || dto.type === 'EVIDENCE_HOLD_PLACED' || dto.type === 'EVIDENCE_HOLD_RELEASED';
    const allowed = needsEscalate
      ? this.can(auth, 'field.incidents.escalate', i)
      : this.can(auth, 'field.incidents.triage', i) || (dto.type === 'CORRECTION' && isReporter);
    if (!allowed) {
      const anyGrant = auth.permissions.has(needsEscalate ? 'field.incidents.escalate' : 'field.incidents.triage');
      throw anyGrant ? AppException.outOfScope() : AppException.forbidden('You cannot add this entry to the incident');
    }
    if (i.status === 'CLOSED') throw AppException.invalidTransition('CLOSED', dto.type);
    if (dto.type === 'REFERRED' && !dto.referredTo) throw AppException.validation('Name the body the incident was referred to', [{ path: ['referredTo'], message: 'Required' }]);
    if (dto.type === 'CORRECTION' && !dto.correction) throw AppException.validation('State what is corrected', [{ path: ['correction'], message: 'Required' }]);
    if (dto.type === 'EVIDENCE_HOLD_PLACED' || dto.type === 'EVIDENCE_HOLD_RELEASED') {
      const hold = dto.type === 'EVIDENCE_HOLD_PLACED';
      if (i.evidenceHold !== hold) await tx.incident.update({ where: { id }, data: { evidenceHold: hold, version: { increment: 1 } } });
    } else {
      await tx.incident.update({ where: { id }, data: { version: { increment: 1 } } });
    }
    const data: Record<string, unknown> = {};
    if (dto.correction) data.correction = dto.correction;
    if (dto.referredTo) data.referredTo = dto.referredTo;
    if (ctx.via === 'sync') data.via = 'sync';
    const e = await this.event(tx, auth, id, dto.type, null, null, dto.note, data);
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.INCIDENT_EVENT_ADDED,
        entityType: FIELD_ENTITY.INCIDENT,
        entityId: id,
        after: { eventId: e.id, type: dto.type, noteLength: dto.note.length, correctedFields: dto.correction ? Object.keys(dto.correction) : [], via: ctx.via, deviceId: ctx.deviceId },
      },
      tx,
    );
    return this.toEvent(e);
  }

  addEvent(auth: AuthContext, id: string, dto: AddIncidentEvent): Promise<IncidentEvent> {
    return this.prisma.tenantTx((tx) => this.addEventInTx(tx, auth, id, dto, { via: 'api', deviceId: 'web' }));
  }

  addEvidence(auth: AuthContext, id: string, dto: AttachEvidence): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      const isReporter = i.reporterId === auth.userId && auth.permissions.has('field.incidents.report');
      if (!isReporter && !this.can(auth, 'field.incidents.triage', i)) {
        throw auth.permissions.has('field.incidents.triage') ? AppException.outOfScope() : AppException.forbidden('Only the reporter or the incident desk can add evidence');
      }
      if (i.status === 'CLOSED') throw AppException.invalidTransition('CLOSED', 'EVIDENCE_ADDED');
      const files = await loadOwnEvidenceFiles(tx, auth, dto.fileIds);
      const existing = new Set((await tx.incidentEvidence.findMany({ where: { incidentId: id }, select: { storedFileId: true } })).map((e) => e.storedFileId));
      const fresh = files.filter((f) => !existing.has(f.id));
      if (fresh.length > 0) {
        await tx.incidentEvidence.createMany({ data: fresh.map((f) => ({ tenantId: auth.tenantId, incidentId: id, storedFileId: f.id, original: false, addedById: auth.userId })) });
        await tx.incident.update({ where: { id }, data: { version: { increment: 1 } } });
        await this.event(tx, auth, id, 'EVIDENCE_ADDED', null, null, null, { original: false }, fresh.map((f) => f.id));
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_EVIDENCE_ADDED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, after: { fileIds: fresh.map((f) => f.id), sha256: fresh.map((f) => f.sha256) } },
          tx,
        );
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  evidenceUrl(auth: AuthContext, id: string, fileId: string, download: boolean): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const link = await tx.incidentEvidence.findFirst({ where: { incidentId: id, storedFileId: fileId }, include: { storedFile: true } });
      if (!link) throw AppException.notFound('File not found on this incident');
      return issueFieldFileUrl(tx, { storage: this.storage, audit: this.audit }, { tenantId: auth.tenantId, file: link.storedFile, entityType: FIELD_ENTITY.INCIDENT, entityId: id, download });
    });
  }

  resolve(auth: AuthContext, id: string, dto: ResolveIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      if (!canTransitionIncident(i.status, 'RESOLVED')) throw AppException.invalidTransition(i.status, 'RESOLVED');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      if (dto.outcome === 'DUPLICATE') {
        if (!dto.duplicateOfId || dto.duplicateOfId === id) throw AppException.validation('Name the incident this one duplicates', [{ path: ['duplicateOfId'], message: 'Required' }]);
        const other = await tx.incident.findUnique({ where: { id: dto.duplicateOfId }, include: INCIDENT_INCLUDE });
        if (!other || !this.can(auth, 'field.incidents.view', other)) throw AppException.validation('Unknown incident', [{ path: ['duplicateOfId'], message: 'Not found' }]);
      }
      const now = new Date();
      await this.update(tx, auth, i, dto.expectedVersion, {
        status: 'RESOLVED',
        outcome: dto.outcome,
        resolutionNote: dto.resolutionNote,
        resolvedById: auth.userId,
        resolvedAt: now,
        duplicateOfId: dto.outcome === 'DUPLICATE' ? dto.duplicateOfId : null,
      });
      await this.event(tx, auth, id, 'RESOLVED', i.status, 'RESOLVED', dto.resolutionNote, { outcome: dto.outcome, duplicateOfId: dto.outcome === 'DUPLICATE' ? dto.duplicateOfId : null });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_RESOLVED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: i.status }, after: { status: 'RESOLVED', outcome: dto.outcome, duplicateOfId: dto.duplicateOfId } },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  close(auth: AuthContext, id: string, dto: CloseIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      if (i.status !== 'RESOLVED') throw AppException.invalidTransition(i.status, 'CLOSED');
      if (i.reporterId === auth.userId) throw AppException.separationOfDuties('You cannot close an incident you reported');
      if (i.resolvedById === auth.userId) throw AppException.separationOfDuties('A second person closes an incident you resolved');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      await this.update(tx, auth, i, dto.expectedVersion, { status: 'CLOSED', closureNote: dto.closureNote, closedById: auth.userId, closedAt: new Date() });
      await this.event(tx, auth, id, 'CLOSED', 'RESOLVED', 'CLOSED', dto.closureNote, { outcome: i.outcome });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_CLOSED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: 'RESOLVED' }, after: { status: 'CLOSED', outcome: i.outcome } },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  reopen(auth: AuthContext, id: string, dto: ReopenIncident): Promise<IncidentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const i = await this.load(tx, id);
      if (i.status !== 'CLOSED') throw AppException.invalidTransition(i.status, 'TRIAGED');
      await this.assertVersion(i, dto.expectedVersion, () => this.detailInTx(tx, auth, id));
      await this.update(tx, auth, i, dto.expectedVersion, { status: 'TRIAGED', ...this.clearResolution(), closureNote: null, closedById: null, closedAt: null });
      await this.event(tx, auth, id, 'REOPENED', 'CLOSED', 'TRIAGED', dto.reason, { previousOutcome: i.outcome });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_REOPENED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, before: { status: 'CLOSED', outcome: i.outcome }, after: { status: 'TRIAGED' }, reason: dto.reason },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  /* ----------------------------- restricted subject ---------------------------- */

  subjects(auth: AuthContext, id: string): Promise<IncidentSubject[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.incidentSubject.findMany({ where: { incidentId: id }, include: { recordedBy: USER_REF }, orderBy: { createdAt: 'desc' } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_SUBJECT_VIEWED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, after: { records: rows.length } },
        tx,
      );
      return rows.map((s) => ({ incidentId: id, description: s.description, recordedBy: s.recordedBy, recordedAt: s.createdAt.toISOString() }));
    });
  }

  recordSubject(auth: AuthContext, id: string, dto: RecordIncidentSubject): Promise<IncidentSubject> {
    return this.prisma.tenantTx(async (tx) => {
      await this.load(tx, id);
      const s = await tx.incidentSubject.create({
        data: { tenantId: auth.tenantId, incidentId: id, description: dto.description, recordedById: auth.userId },
        include: { recordedBy: USER_REF },
      });
      await this.event(tx, auth, id, 'SUBJECT_RECORDED', null, null, 'Restricted subject record added');
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INCIDENT_SUBJECT_RECORDED, entityType: FIELD_ENTITY.INCIDENT, entityId: id, after: { subjectId: s.id, descriptionLength: dto.description.length }, reason: dto.reason },
        tx,
      );
      return { incidentId: id, description: s.description, recordedBy: s.recordedBy, recordedAt: s.createdAt.toISOString() };
    });
  }
}
