import { Injectable } from '@nestjs/common';
import { nextReference, type Prisma, type TenantTx } from '@ngao360/db';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  AGENT_STATUS_TRANSITIONS,
  AUDIT_ACTIONS,
  type AgentAccreditation,
  type AgentDetail,
  type AgentQuery,
  type AgentSensitiveReveal,
  type AgentSummary,
  type AgentTraining,
  type AuditEvent,
  type AgentStatusChange,
  type CreateAgent,
  type FieldEvidenceUpload,
  type FieldMe,
  type LinkAgentUser,
  type Paginated,
  type PermissionKey,
  type RecordTraining,
  type RevealAgentSensitive,
  type SetAccreditation,
  type UpdateAgent,
  type UpdateAgentSensitive,
  type UpdateTraining,
  canTransitionAgent,
  maskNationalId,
  maskPhone,
} from '@ngao360/shared';
import { z } from 'zod';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { type GeoLocation, pathToUnitIds, scopeAllows } from '../../../rbac/scope';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { resolveFieldCycle } from '../common/field-cycle';
import { agentScopeWhere } from '../common/field-location';
import {
  USER_REF,
  auditEventsFor,
  contains,
  dateOnly,
  type FieldUpload,
  immutableRecord,
  iso,
  isoDate,
  paging,
  serverChanged,
  storeFieldFile,
} from '../common/field-support';
import { DEPLOYMENT_INCLUDE, toMyAssignments } from '../deployment/deployment.mappers';
import { FIELD_ENTITY } from '../field.constants';

const AGENT_INCLUDE = {
  homeWard: { select: { id: true, officialName: true, path: true } },
  _count: { select: { trainings: true } },
} satisfies Prisma.AgentInclude;
type AgentRow = Prisma.AgentGetPayload<{ include: typeof AGENT_INCLUDE }>;

const ACTIVE = [...ACTIVE_DEPLOYMENT_STATUSES];

/**
 * Agent registry (blueprint 6.3). Personal identifiers and contact details live in
 * agent_sensitive and are read only by the audited reveal (field.agents.reveal_sensitive + reauth);
 * agents.phone_masked / national_id_masked are refreshed whenever they change.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly storage: StorageService,
  ) {}

  /* --------------------------------- helpers -------------------------------- */

  private agentLocation(a: { homeCountyId: string; homeConstituencyId: string; homeWardId: string }): GeoLocation {
    return { unitIds: [a.homeCountyId, a.homeConstituencyId, a.homeWardId], stationId: null };
  }

  private can(auth: AuthContext, perm: PermissionKey, loc: GeoLocation): boolean {
    return auth.permissions.has(perm) && scopeAllows(this.permissions.scopeFor(auth, perm), loc);
  }

  /** Field cycle when one exists (agents are not cycle-bound). */
  private async cycleOrNull(tx: TenantTx, requested?: string | null) {
    const config = await this.modules.fieldConfig(tx);
    try {
      return await resolveFieldCycle(tx, config, requested);
    } catch (e) {
      if (requested) throw e;
      return null;
    }
  }

  /** A WARD unit inside the caller's scope for `perm` (403 OUT_OF_SCOPE). */
  private async resolveHomeWard(tx: TenantTx, auth: AuthContext, wardId: string, perm: PermissionKey) {
    const unit = await tx.geographicUnit.findUnique({ where: { id: wardId }, select: { id: true, type: true, path: true } });
    if (!unit || unit.type !== 'WARD') {
      throw AppException.validation('Choose the agent’s home ward', [{ path: ['homeWardId'], message: 'Not a ward' }]);
    }
    const [countyId, constituencyId] = pathToUnitIds(unit.path);
    if (!countyId || !constituencyId) throw AppException.validation('The ward has no county or constituency', [{ path: ['homeWardId'], message: 'Invalid ward' }]);
    if (!scopeAllows(this.permissions.scopeFor(auth, perm), { unitIds: pathToUnitIds(unit.path), stationId: null })) {
      throw AppException.outOfScope('The home ward is outside your assigned geography');
    }
    return { homeWardId: unit.id, homeConstituencyId: constituencyId, homeCountyId: countyId };
  }

  private async loadAgent(tx: TenantTx, id: string) {
    const a = await tx.agent.findUnique({ where: { id } });
    if (!a) throw AppException.notFound('Agent not found');
    return a;
  }

  private async summaries(tx: TenantTx, rows: AgentRow[], cycleId: string | null): Promise<AgentSummary[]> {
    const ids = rows.map((r) => r.id);
    const unitIds = new Set<string>();
    rows.forEach((r) => unitIds.add(r.homeConstituencyId));
    const [units, accreditations, completed, active] = await Promise.all([
      tx.geographicUnit.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, officialName: true } }),
      cycleId ? tx.agentAccreditation.findMany({ where: { agentId: { in: ids }, electionCycleId: cycleId }, select: { agentId: true, status: true } }) : [],
      tx.agentTraining.groupBy({ by: ['agentId'], where: { agentId: { in: ids }, status: 'COMPLETED' }, _count: { _all: true } }),
      cycleId
        ? tx.deployment.groupBy({ by: ['agentId'], where: { agentId: { in: ids }, electionCycleId: cycleId, status: { in: ACTIVE } }, _count: { _all: true } })
        : [],
    ]);
    const unitName = new Map(units.map((u) => [u.id, u.officialName]));
    const accr = new Map(accreditations.map((a) => [a.agentId, a.status]));
    const done = new Map(completed.map((c) => [c.agentId, c._count._all]));
    const act = new Map(active.map((c) => [c.agentId, c._count._all]));
    return rows.map((a) => ({
      id: a.id,
      reference: a.reference,
      givenName: a.givenName,
      familyName: a.familyName,
      displayName: `${a.givenName} ${a.familyName}`,
      status: a.status,
      availability: a.availability,
      homeWard: { id: a.homeWard.id, name: a.homeWard.officialName },
      homeConstituency: { id: a.homeConstituencyId, name: unitName.get(a.homeConstituencyId) ?? 'Unknown unit' },
      languages: a.languages,
      phoneMasked: a.phoneMasked,
      accreditationStatus: accr.get(a.id) ?? null,
      trainingCompleted: done.get(a.id) ?? 0,
      trainingTotal: a._count.trainings,
      activeDeployments: act.get(a.id) ?? 0,
      hasUserAccount: !!a.userId,
      updatedAt: a.updatedAt.toISOString(),
    }));
  }

  private toTraining(t: Prisma.AgentTrainingGetPayload<{ include: { recordedBy: typeof USER_REF } }>): AgentTraining {
    return {
      id: t.id,
      electionCycleId: t.electionCycleId,
      title: t.title,
      status: t.status,
      scheduledOn: isoDate(t.scheduledOn),
      materialsIssued: t.materialsIssued,
      attendedAt: iso(t.attendedAt),
      assessmentScore: t.assessmentScore,
      completedAt: iso(t.completedAt),
      refresherDueOn: isoDate(t.refresherDueOn),
      notes: t.notes,
      recordedBy: t.recordedBy,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private toAccreditation(a: Prisma.AgentAccreditationGetPayload<{ include: { updatedBy: typeof USER_REF } }>): AgentAccreditation {
    return {
      id: a.id,
      electionCycleId: a.electionCycleId,
      status: a.status,
      accreditationReference: a.accreditationReference,
      evidenceFileId: a.evidenceFileId,
      submittedAt: iso(a.submittedAt),
      decidedAt: iso(a.decidedAt),
      expiresOn: isoDate(a.expiresOn),
      notes: a.notes,
      updatedBy: a.updatedBy,
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  async detailInTx(tx: TenantTx, auth: AuthContext, id: string): Promise<AgentDetail> {
    const a = await tx.agent.findUnique({ where: { id }, include: AGENT_INCLUDE });
    if (!a) throw AppException.notFound('Agent not found');
    const cycle = await this.cycleOrNull(tx);
    const [summary] = await this.summaries(tx, [a], cycle?.id ?? null);
    const [county, accreditations, trainings, deployments, statusEvents, createdBy] = await Promise.all([
      tx.geographicUnit.findUnique({ where: { id: a.homeCountyId }, select: { id: true, officialName: true } }),
      tx.agentAccreditation.findMany({ where: { agentId: id }, include: { updatedBy: USER_REF }, orderBy: { createdAt: 'desc' } }),
      tx.agentTraining.findMany({ where: { agentId: id }, include: { recordedBy: USER_REF }, orderBy: { createdAt: 'desc' } }),
      tx.deployment.findMany({ where: { agentId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      tx.agentStatusEvent.findMany({ where: { agentId: id }, include: { actor: USER_REF }, orderBy: { createdAt: 'asc' } }),
      tx.user.findUnique({ where: { id: a.createdById }, select: { id: true, displayName: true } }),
    ]);
    const stationNames = new Map<string, string>();
    for (const cycleId of new Set(deployments.map((d) => d.electionCycleId))) {
      const reg = await tx.registryVersion.findFirst({ where: { electionCycleId: cycleId, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' }, select: { id: true } });
      if (!reg) continue;
      const sts = await tx.pollingStation.findMany({
        where: { registryVersionId: reg.id, code: { in: deployments.filter((d) => d.electionCycleId === cycleId).map((d) => d.pollingStationCode) } },
        select: { code: true, name: true },
      });
      sts.forEach((s) => stationNames.set(`${cycleId}:${s.code}`, s.name));
    }
    const loc = this.agentLocation(a);
    const own = await this.isOwnRecord(tx, a, auth.userId);
    const actions: AgentDetail['allowedActions'] = [];
    const canEdit = this.can(auth, 'field.agents.edit', loc);
    if (canEdit && a.status !== 'WITHDRAWN') actions.push('edit');
    if (canEdit && a.status !== 'WITHDRAWN' && !own) actions.push('link_user');
    if (canEdit && AGENT_STATUS_TRANSITIONS[a.status].length > 0) actions.push('change_status');
    if (this.can(auth, 'field.agents.training', loc)) actions.push('record_training');
    if (this.can(auth, 'field.agents.accreditation', loc)) actions.push('record_accreditation');
    // Personal data: home area, grants for every cycle or the current field cycle only.
    if (!own && this.can(auth, 'field.agents.reveal_sensitive', { ...loc, electionCycleId: cycle?.id ?? null })) actions.push('reveal_sensitive', 'edit_sensitive');
    return {
      ...summary!,
      otherNames: a.otherNames,
      gender: a.gender,
      homeCounty: county ? { id: county.id, name: county.officialName } : null,
      nationalIdMasked: a.nationalIdMasked,
      hasMpesaNumber: a.hasMpesaNumber,
      hasNextOfKin: a.hasNextOfKin,
      notes: a.notes,
      privacyNoticeVersion: a.privacyNoticeVersion,
      privacyNoticeAcknowledgedAt: iso(a.privacyNoticeAckAt),
      userId: a.userId,
      accreditations: accreditations.map((x) => this.toAccreditation(x)),
      trainings: trainings.map((t) => this.toTraining(t)),
      deployments: deployments.map((d) => ({
        id: d.id,
        electionCycleId: d.electionCycleId,
        pollingStationCode: d.pollingStationCode,
        pollingStationName: stationNames.get(`${d.electionCycleId}:${d.pollingStationCode}`) ?? null,
        role: d.role,
        shift: d.shift,
        status: d.status,
      })),
      statusHistory: statusEvents.map((e) => ({
        id: e.id,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reason: e.reason,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
      })),
      createdBy: createdBy ?? { id: a.createdById, displayName: 'Unknown user' },
      createdAt: a.createdAt.toISOString(),
      version: a.version,
      allowedActions: actions,
    };
  }

  /* ---------------------------------- reads --------------------------------- */

  list(auth: AuthContext, q: AgentQuery): Promise<Paginated<AgentSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await this.cycleOrNull(tx, q.electionCycleId);
      const cycleId = cycle?.id ?? null;
      const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const and: Prisma.AgentWhereInput[] = [agentScopeWhere(this.permissions.scopeFor(auth, 'field.agents.view')) ?? {}];
      if (statuses) and.push({ status: { in: statuses } });
      if (q.availability) and.push({ availability: q.availability });
      if (q.countyId) and.push({ homeCountyId: q.countyId });
      if (q.constituencyId) and.push({ homeConstituencyId: q.constituencyId });
      if (q.wardId) and.push({ homeWardId: q.wardId });
      if (q.language) and.push({ languages: { has: q.language } });
      // Never matches phone or ID values (they are not even in this table).
      if (q.q) and.push({ OR: [{ reference: contains(q.q) }, { givenName: contains(q.q) }, { familyName: contains(q.q) }, { otherNames: contains(q.q) }] });
      if (cycleId && q.accreditationStatus) {
        and.push(
          q.accreditationStatus === 'NOT_SUBMITTED'
            ? { OR: [{ accreditations: { some: { electionCycleId: cycleId, status: 'NOT_SUBMITTED' } } }, { accreditations: { none: { electionCycleId: cycleId } } }] }
            : { accreditations: { some: { electionCycleId: cycleId, status: q.accreditationStatus } } },
        );
      }
      if (cycleId && q.undeployedOnly) and.push({ deployments: { none: { electionCycleId: cycleId, status: { in: ACTIVE } } } });
      const where: Prisma.AgentWhereInput = { AND: and };
      const dir = q.order;
      const orderBy: Prisma.AgentOrderByWithRelationInput[] =
        q.sort === 'reference'
          ? [{ reference: dir }]
          : q.sort === 'updatedAt'
            ? [{ updatedAt: dir }]
            : q.sort === 'status'
              ? [{ status: dir }, { familyName: 'asc' }]
              : [{ familyName: q.sort === 'familyName' ? dir : 'asc' }, { givenName: 'asc' }, { reference: 'asc' }];
      const [rows, total] = await Promise.all([
        tx.agent.findMany({ where, include: AGENT_INCLUDE, orderBy, ...paging(q) }),
        tx.agent.count({ where }),
      ]);
      return { items: await this.summaries(tx, rows, cycleId), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<AgentDetail> {
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, auth, id));
  }

  history(auth: AuthContext, id: string): Promise<AuditEvent[]> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadAgent(tx, id);
      const [trainings, accreditations] = await Promise.all([
        tx.agentTraining.findMany({ where: { agentId: id }, select: { id: true } }),
        tx.agentAccreditation.findMany({ where: { agentId: id }, select: { id: true } }),
      ]);
      return auditEventsFor(tx, [id, ...trainings.map((t) => t.id), ...accreditations.map((a) => a.id)], auth);
    });
  }

  /* --------------------------------- writes --------------------------------- */

  create(auth: AuthContext, dto: CreateAgent): Promise<AgentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const home = await this.resolveHomeWard(tx, auth, dto.homeWardId, 'field.agents.create');
      const config = await this.modules.fieldConfig(tx);
      const cycle = await this.cycleOrNull(tx);
      const year = cycle ? cycle.electionDate.getUTCFullYear() : new Date().getUTCFullYear();
      const reference = await nextReference(tx, auth.tenantId, 'AGT', year);
      const s = dto.sensitive ?? {};
      const now = new Date();
      const agent = await tx.agent.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          givenName: dto.givenName,
          familyName: dto.familyName,
          otherNames: dto.otherNames,
          gender: dto.gender,
          ...home,
          languages: dto.languages,
          availability: dto.availability,
          notes: dto.notes,
          phoneMasked: maskPhone(s.phone ?? null),
          nationalIdMasked: maskNationalId(s.nationalIdNumber ?? null),
          hasMpesaNumber: !!s.mpesaNumber,
          hasNextOfKin: !!(s.nextOfKinName || s.nextOfKinPhone),
          privacyNoticeVersion: config.agentPrivacyNoticeVersion,
          privacyNoticeAckAt: now,
          createdById: auth.userId,
        },
      });
      await tx.agentSensitive.create({
        data: {
          agentId: agent.id,
          tenantId: auth.tenantId,
          nationalIdNumber: s.nationalIdNumber ?? null,
          phone: s.phone ?? null,
          mpesaNumber: s.mpesaNumber ?? null,
          nextOfKinName: s.nextOfKinName ?? null,
          nextOfKinPhone: s.nextOfKinPhone ?? null,
          nextOfKinRelationship: s.nextOfKinRelationship ?? null,
          updatedById: auth.userId,
        },
      });
      await tx.agentStatusEvent.create({ data: { tenantId: auth.tenantId, agentId: agent.id, fromStatus: null, toStatus: 'RECRUITED', reason: 'Registered', actorId: auth.userId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.AGENT_CREATED,
          entityType: FIELD_ENTITY.AGENT,
          entityId: agent.id,
          after: {
            reference,
            status: 'RECRUITED',
            homeWardId: home.homeWardId,
            privacyNoticeVersion: config.agentPrivacyNoticeVersion,
            hasPhone: !!s.phone,
            hasNationalId: !!s.nationalIdNumber,
            hasMpesaNumber: !!s.mpesaNumber,
            hasNextOfKin: !!(s.nextOfKinName || s.nextOfKinPhone),
          },
        },
        tx,
      );
      return this.detailInTx(tx, auth, agent.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateAgent): Promise<AgentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await this.loadAgent(tx, id);
      if (a.status === 'WITHDRAWN') throw immutableRecord('A withdrawn agent record cannot be edited');
      if (a.version !== dto.expectedVersion) throw serverChanged(a.version, await this.detailInTx(tx, auth, id));
      const home = dto.homeWardId && dto.homeWardId !== a.homeWardId ? await this.resolveHomeWard(tx, auth, dto.homeWardId, 'field.agents.edit') : {};
      const patch: Prisma.AgentUpdateManyMutationInput & Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const fields = ['givenName', 'familyName', 'otherNames', 'gender', 'languages', 'availability', 'notes'] as const;
      for (const f of fields) {
        const v = dto[f];
        if (v === undefined) continue;
        if (JSON.stringify(a[f]) === JSON.stringify(v)) continue;
        before[f] = a[f];
        after[f] = v;
        patch[f] = v as never;
      }
      for (const [k, v] of Object.entries(home)) {
        before[k] = (a as Record<string, unknown>)[k];
        after[k] = v;
        patch[k] = v;
      }
      if (Object.keys(after).length > 0) {
        const r = await tx.agent.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...patch, version: { increment: 1 } } });
        if (r.count === 0) throw serverChanged(a.version, await this.detailInTx(tx, auth, id));
        await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_UPDATED, entityType: FIELD_ENTITY.AGENT, entityId: id, before, after }, tx);
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  changeStatus(auth: AuthContext, id: string, dto: AgentStatusChange): Promise<AgentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await this.loadAgent(tx, id);
      if (a.version !== dto.expectedVersion) throw serverChanged(a.version, await this.detailInTx(tx, auth, id));
      if (!canTransitionAgent(a.status, dto.to)) throw AppException.invalidTransition(a.status, dto.to);
      if (dto.to === 'INACTIVE' || dto.to === 'WITHDRAWN') {
        const active = await tx.deployment.findMany({ where: { agentId: id, status: { in: ACTIVE } }, select: { id: true } });
        if (active.length > 0) {
          throw AppException.conflict('Replace or cancel the agent’s active deployments first', { deploymentIds: active.map((d) => d.id) });
        }
      }
      const r = await tx.agent.updateMany({ where: { id, version: dto.expectedVersion }, data: { status: dto.to, version: { increment: 1 } } });
      if (r.count === 0) throw serverChanged(a.version, await this.detailInTx(tx, auth, id));
      await tx.agentStatusEvent.create({ data: { tenantId: auth.tenantId, agentId: id, fromStatus: a.status, toStatus: dto.to, reason: dto.reason, actorId: auth.userId } });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_STATUS_CHANGED, entityType: FIELD_ENTITY.AGENT, entityId: id, before: { status: a.status }, after: { status: dto.to }, reason: dto.reason },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  /** Audited reveal of the fields asked for. Never for the caller's own record. */
  reveal(auth: AuthContext, id: string, dto: RevealAgentSensitive): Promise<AgentSensitiveReveal> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await this.loadAgent(tx, id);
      if (await this.isOwnRecord(tx, a, auth.userId)) throw AppException.separationOfDuties('You cannot reveal your own agent record’s personal data');
      const s = await tx.agentSensitive.findUnique({ where: { agentId: id } });
      const fields = [...new Set(dto.fields)];
      const out: AgentSensitiveReveal = { agentId: id, revealedAt: new Date().toISOString() };
      for (const f of fields) {
        if (f === 'nationalIdNumber') out.nationalIdNumber = s?.nationalIdNumber ?? null;
        if (f === 'phone') out.phone = s?.phone ?? null;
        if (f === 'mpesaNumber') out.mpesaNumber = s?.mpesaNumber ?? null;
        if (f === 'nextOfKin') {
          out.nextOfKin = s && (s.nextOfKinName || s.nextOfKinPhone || s.nextOfKinRelationship)
            ? { name: s.nextOfKinName, phone: s.nextOfKinPhone, relationship: s.nextOfKinRelationship }
            : null;
        }
      }
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_SENSITIVE_REVEALED, entityType: FIELD_ENTITY.AGENT, entityId: id, after: { fields }, reason: dto.reason },
        tx,
      );
      return out;
    });
  }

  updateSensitive(auth: AuthContext, id: string, dto: UpdateAgentSensitive): Promise<AgentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await this.loadAgent(tx, id);
      if (await this.isOwnRecord(tx, a, auth.userId)) throw AppException.separationOfDuties('You cannot change your own agent record’s personal data');
      if (a.status === 'WITHDRAWN') throw immutableRecord('A withdrawn agent record cannot be edited');
      const current = await tx.agentSensitive.findUnique({ where: { agentId: id } });
      const keys = ['nationalIdNumber', 'phone', 'mpesaNumber', 'nextOfKinName', 'nextOfKinPhone', 'nextOfKinRelationship'] as const;
      const patch: Record<string, string | null> = {};
      const changed: string[] = [];
      for (const k of keys) {
        const v = dto[k];
        if (v === undefined) continue;
        if ((current?.[k] ?? null) === v) continue;
        patch[k] = v;
        changed.push(k);
      }
      if (changed.length > 0) {
        const merged = { ...(current ?? {}), ...patch } as Record<(typeof keys)[number], string | null | undefined>;
        await tx.agentSensitive.upsert({
          where: { agentId: id },
          create: { agentId: id, tenantId: auth.tenantId, ...patch, updatedById: auth.userId },
          update: { ...patch, updatedById: auth.userId },
        });
        await tx.agent.update({
          where: { id },
          data: {
            phoneMasked: maskPhone(merged.phone ?? null),
            nationalIdMasked: maskNationalId(merged.nationalIdNumber ?? null),
            hasMpesaNumber: !!merged.mpesaNumber,
            hasNextOfKin: !!(merged.nextOfKinName || merged.nextOfKinPhone),
            version: { increment: 1 },
          },
        });
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_SENSITIVE_UPDATED, entityType: FIELD_ENTITY.AGENT, entityId: id, after: { fields: changed }, reason: dto.reason },
          tx,
        );
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  recordTraining(auth: AuthContext, id: string, dto: RecordTraining): Promise<AgentTraining> {
    return this.prisma.tenantTx(async (tx) => {
      await this.loadAgent(tx, id);
      if (dto.electionCycleId && !(await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { id: true } }))) {
        throw AppException.validation('Unknown election cycle', [{ path: ['electionCycleId'], message: 'Not found' }]);
      }
      const t = await tx.agentTraining.create({
        data: {
          tenantId: auth.tenantId,
          agentId: id,
          electionCycleId: dto.electionCycleId,
          title: dto.title,
          status: dto.status,
          scheduledOn: dateOnly(dto.scheduledOn) ?? null,
          materialsIssued: dto.materialsIssued,
          attendedAt: dto.attendedAt ? new Date(dto.attendedAt) : null,
          assessmentScore: dto.assessmentScore,
          completedAt: dto.completedAt ? new Date(dto.completedAt) : dto.status === 'COMPLETED' ? new Date() : null,
          refresherDueOn: dateOnly(dto.refresherDueOn) ?? null,
          notes: dto.notes,
          recordedById: auth.userId,
        },
        include: { recordedBy: USER_REF },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_TRAINING_RECORDED, entityType: FIELD_ENTITY.AGENT_TRAINING, entityId: t.id, after: { agentId: id, title: t.title, status: t.status, assessmentScore: t.assessmentScore } },
        tx,
      );
      return this.toTraining(t);
    });
  }

  updateTraining(auth: AuthContext, id: string, trainingId: string, dto: UpdateTraining): Promise<AgentTraining> {
    return this.prisma.tenantTx(async (tx) => {
      const t = await tx.agentTraining.findUnique({ where: { id: trainingId } });
      if (!t || t.agentId !== id) throw AppException.notFound('Training record not found for this agent');
      const data: Prisma.AgentTrainingUpdateInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.scheduledOn !== undefined) data.scheduledOn = dateOnly(dto.scheduledOn);
      if (dto.materialsIssued !== undefined) data.materialsIssued = dto.materialsIssued;
      if (dto.attendedAt !== undefined) data.attendedAt = dto.attendedAt ? new Date(dto.attendedAt) : null;
      if (dto.assessmentScore !== undefined) data.assessmentScore = dto.assessmentScore;
      if (dto.completedAt !== undefined) data.completedAt = dto.completedAt ? new Date(dto.completedAt) : null;
      else if (dto.status === 'COMPLETED' && !t.completedAt) data.completedAt = new Date();
      if (dto.refresherDueOn !== undefined) data.refresherDueOn = dateOnly(dto.refresherDueOn);
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.electionCycleId !== undefined) data.electionCycle = dto.electionCycleId ? { connect: { id: dto.electionCycleId } } : { disconnect: true };
      const updated = await tx.agentTraining.update({ where: { id: trainingId }, data, include: { recordedBy: USER_REF } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.AGENT_TRAINING_RECORDED,
          entityType: FIELD_ENTITY.AGENT_TRAINING,
          entityId: trainingId,
          before: { status: t.status, assessmentScore: t.assessmentScore, title: t.title },
          after: { status: updated.status, assessmentScore: updated.assessmentScore, title: updated.title },
          reason: dto.reason,
        },
        tx,
      );
      return this.toTraining(updated);
    });
  }

  private async upsertAccreditation(
    tx: TenantTx,
    auth: AuthContext,
    agentId: string,
    electionCycleId: string,
    data: Omit<Prisma.AgentAccreditationUncheckedCreateInput, 'tenantId' | 'agentId' | 'electionCycleId'>,
    reason: string | null,
  ): Promise<AgentAccreditation> {
    await this.loadAgent(tx, agentId);
    if (!(await tx.electionCycle.findUnique({ where: { id: electionCycleId }, select: { id: true } }))) {
      throw AppException.validation('Unknown election cycle', [{ path: ['electionCycleId'], message: 'Not found' }]);
    }
    const key = { tenantId_agentId_electionCycleId: { tenantId: auth.tenantId, agentId, electionCycleId } };
    const before = await tx.agentAccreditation.findUnique({ where: key });
    const row = await tx.agentAccreditation.upsert({
      where: key,
      create: { tenantId: auth.tenantId, agentId, electionCycleId, ...data, updatedById: auth.userId },
      update: { ...data, updatedById: auth.userId },
      include: { updatedBy: USER_REF },
    });
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.AGENT_ACCREDITATION_RECORDED,
        entityType: FIELD_ENTITY.AGENT_ACCREDITATION,
        entityId: row.id,
        before: before ? { status: before.status, evidenceFileId: before.evidenceFileId } : null,
        after: { agentId, electionCycleId, status: row.status, evidenceFileId: row.evidenceFileId },
        reason,
      },
      tx,
    );
    return this.toAccreditation(row);
  }

  setAccreditation(auth: AuthContext, id: string, dto: SetAccreditation): Promise<AgentAccreditation> {
    return this.prisma.tenantTx((tx) =>
      this.upsertAccreditation(
        tx,
        auth,
        id,
        dto.electionCycleId,
        {
          status: dto.status,
          accreditationReference: dto.accreditationReference,
          submittedAt: dto.submittedAt ? new Date(dto.submittedAt) : null,
          decidedAt: dto.decidedAt ? new Date(dto.decidedAt) : null,
          expiresOn: dateOnly(dto.expiresOn) ?? null,
          notes: dto.notes,
        },
        dto.reason,
      ),
    );
  }

  accreditationEvidence(auth: AuthContext, id: string, metadata: unknown, file: FieldUpload | undefined): Promise<AgentAccreditation> {
    let meta: unknown = metadata;
    if (typeof metadata === 'string') {
      try {
        meta = JSON.parse(metadata);
      } catch {
        throw AppException.validation('metadata must be JSON', [{ path: ['metadata'], message: 'Invalid JSON' }]);
      }
    }
    const parsed = z.object({ electionCycleId: z.string().uuid() }).safeParse(meta);
    if (!parsed.success) throw AppException.validation('Give the election cycle of the accreditation', [{ path: ['metadata', 'electionCycleId'], message: 'Required' }]);
    return this.prisma.tenantTx(async (tx) => {
      await this.loadAgent(tx, id);
      const stored = await storeFieldFile(this.storage, tx, auth, file, 'AGENT_DOCUMENT');
      return this.upsertAccreditation(tx, auth, id, parsed.data.electionCycleId, { evidenceFileId: stored.file.id }, 'Accreditation letter attached');
    });
  }

  /**
   * True when the user is, or ever was, linked to this agent record. The link history comes
   * from the append-only audit stream, so unlinking does not reopen the caller's own record.
   */
  private async isOwnRecord(tx: TenantTx, a: { id: string; userId: string | null }, userId: string): Promise<boolean> {
    if (a.userId === userId) return true;
    const past = await tx.auditEvent.findFirst({
      where: {
        entityId: a.id,
        action: AUDIT_ACTIONS.AGENT_USER_LINKED,
        OR: [{ before: { path: ['userId'], equals: userId } }, { after: { path: ['userId'], equals: userId } }],
      },
      select: { id: true },
    });
    return !!past;
  }

  linkUser(auth: AuthContext, id: string, dto: LinkAgentUser): Promise<AgentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const a = await this.loadAgent(tx, id);
      if (a.status === 'WITHDRAWN') throw immutableRecord('A withdrawn agent record cannot be edited');
      // Separation of duties: nobody links or unlinks their own account (unlinking would
      // otherwise open the reveal / edit-sensitive routes on their own record).
      if (dto.userId === auth.userId || (await this.isOwnRecord(tx, a, auth.userId))) {
        throw AppException.separationOfDuties('You cannot change the account link of your own agent record');
      }
      if (dto.userId) {
        const user = await tx.user.findUnique({ where: { id: dto.userId }, select: { id: true, status: true } });
        if (!user || user.status !== 'ACTIVE') throw AppException.validation('Choose an active user account', [{ path: ['userId'], message: 'Unknown or inactive user' }]);
        const other = await tx.agent.findFirst({ where: { userId: dto.userId, id: { not: id } }, select: { id: true, reference: true } });
        if (other) throw AppException.conflict(`This account is already linked to agent ${other.reference}`, { agentId: other.id });
      }
      if (a.userId !== dto.userId) {
        await tx.agent.update({ where: { id }, data: { userId: dto.userId, version: { increment: 1 } } });
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.AGENT_USER_LINKED, entityType: FIELD_ENTITY.AGENT, entityId: id, before: { userId: a.userId }, after: { userId: dto.userId }, reason: dto.reason },
          tx,
        );
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  /* --------------------------------- mobile --------------------------------- */

  me(auth: AuthContext): Promise<FieldMe> {
    return this.prisma.tenantTx(async (tx) => {
      const config = await this.modules.fieldConfig(tx);
      const cycle = await this.cycleOrNull(tx);
      const agent = await tx.agent.findUnique({ where: { userId: auth.userId }, select: { id: true, reference: true, givenName: true, familyName: true, status: true } });
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const rows =
        agent && cycle
          ? await tx.deployment.findMany({
              where: {
                agentId: agent.id,
                electionCycleId: cycle.id,
                OR: [{ status: { in: ACTIVE } }, { status: 'CHECKED_OUT', checkedOutAt: { gte: new Date(startOfDay.getTime() - 3 * 3_600_000) } }],
              },
              include: DEPLOYMENT_INCLUDE,
              orderBy: [{ shift: 'asc' }, { createdAt: 'asc' }],
            })
          : [];
      const has = (p: PermissionKey) => auth.permissions.has(p);
      const templates = has('field.reports.submit')
        ? await tx.fieldReportTemplate.findMany({
            where: { status: 'ACTIVE', OR: [{ electionCycleId: null }, ...(cycle ? [{ electionCycleId: cycle.id }] : [])] },
            select: { id: true, key: true, version: true, name: true },
            orderBy: { name: 'asc' },
          })
        : [];
      const notices = await tx.notification.findMany({
        where: { userId: auth.userId, module: 'field', readAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, body: true, createdAt: true },
      });
      return {
        agent: agent ? { id: agent.id, reference: agent.reference, displayName: `${agent.givenName} ${agent.familyName}`, status: agent.status } : null,
        electionCycleId: cycle?.id ?? null,
        assignments: await toMyAssignments(tx, rows, config),
        can: {
          submitFieldReport: has('field.reports.submit'),
          reportIncident: has('field.incidents.report'),
          checkIn: has('field.deployment.checkin') && rows.length > 0,
          uploadResultForm: has('tally.submit') && (await this.modules.isEnabled(tx, 'tally')),
        },
        templates,
        notices: notices.map((n) => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt.toISOString() })),
        serverTime: new Date().toISOString(),
      };
    });
  }

  uploadEvidence(auth: AuthContext, file: FieldUpload | undefined): Promise<FieldEvidenceUpload> {
    return this.prisma.tenantTx(async (tx) => {
      const { file: f, duplicate } = await storeFieldFile(this.storage, tx, auth, file, 'FIELD_EVIDENCE');
      return { fileId: f.id, sha256: f.sha256, mimeType: f.mimeType, sizeBytes: Number(f.sizeBytes), duplicate };
    });
  }
}
