import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  AUDIT_ACTIONS,
  type CancelDeployment,
  type CheckIn,
  type CheckOut,
  type ConfirmDeployment,
  type CreateDeployment,
  DATA_PROVENANCE_LABELS,
  DEPLOYMENT_ROLE_LABELS,
  type DeploymentConflict,
  type DeploymentCoverage,
  type DeploymentCoverageQuery,
  type DeploymentDetail,
  type DeploymentQuery,
  type DeploymentShift,
  type DeploymentSummary,
  type Paginated,
  type PermissionKey,
  type ReplaceDeployment,
  type ReplaceDeploymentResult,
  type RosterExport,
  type SignedUrlResponse,
  type UpdateDeployment,
  canTransitionDeployment,
  exportLabelLines,
  shiftsOverlap,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { cycleOrTenantDataLabel } from '../../../common/provenance/data-label';
import { AppException } from '../../../common/http/app-exception';
import { AllExceptionsFilter } from '../../../common/http/all-exceptions.filter';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { scopeAllows } from '../../../rbac/scope';
import { StorageService } from '../../../storage/storage.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { ClientSubmissionLedger } from '../common/client-submission.ledger';
import { resolveFieldCycle } from '../common/field-cycle';
import { agentScopeWhere, approvedRegistryId, fieldGeoLocation, fieldScopeWhere, resolveStationByCode } from '../common/field-location';
import { FIELD_COLS, STATION_COLS, areaFilterSql, expectedStationSql, scopeSql } from '../common/field-sql';
import { USER_REF, assertOfflineAge, contains, immutableRecord, notifyUsers, paging, serverChanged } from '../common/field-support';
import { FIELD_ENTITY } from '../field.constants';
import type { BulkCreateDeployment, BulkDeploymentResult } from '@ngao360/shared';
import { DEPLOYMENT_INCLUDE, type DeploymentRow, agentDisplayName, ownDeploymentActions, toDeploymentSummaries } from './deployment.mappers';

const ACTIVE = [...ACTIVE_DEPLOYMENT_STATUSES];
const COVERING_ROLES = ['CHIEF_AGENT', 'STATION_AGENT'] as const;
const CONFLICT_LIMIT = 200;

/** How a device-originated write reached the server (sync passes `via: 'sync'`). */
export interface FieldWriteContext {
  via: 'api' | 'sync';
  deviceId: string;
}

export type { BulkDeploymentResult };

/**
 * Deployment planner (blueprint 6.3, S14) and agent confirmation / check-in
 * (blueprint 7.2). Slots are agent × station code × cycle × role × shift; the
 * DB backs the planner's checks with partial unique indexes. Nothing is ever
 * deleted: replacement links rows, cancellation keeps them.
 */
@Injectable()
export class DeploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly storage: StorageService,
    private readonly ledger: ClientSubmissionLedger,
  ) {}

  /* --------------------------------- helpers -------------------------------- */

  private can(auth: AuthContext, perm: PermissionKey, d: { electionCycleId: string; pollingStationCode: string; countyId: string; constituencyId: string; wardId: string; pollingCentreId: string | null }): boolean {
    return auth.permissions.has(perm) && scopeAllows(this.permissions.scopeFor(auth, perm), fieldGeoLocation(d));
  }

  private async load(tx: TenantTx, id: string): Promise<DeploymentRow> {
    const d = await tx.deployment.findUnique({ where: { id }, include: DEPLOYMENT_INCLUDE });
    if (!d) throw AppException.notFound('Deployment not found');
    return d;
  }

  private async summary(tx: TenantTx, id: string): Promise<DeploymentSummary> {
    return (await toDeploymentSummaries(tx, [await this.load(tx, id)]))[0]!;
  }

  /** Non-blocking conflicts of one slot (shown on the detail and returned by create). */
  private async slotWarnings(tx: TenantTx, d: { id?: string; agentId: string; electionCycleId: string; pollingStationCode: string }): Promise<DeploymentConflict[]> {
    const out: DeploymentConflict[] = [];
    const [agent, accr, reg] = await Promise.all([
      tx.agent.findUnique({ where: { id: d.agentId }, select: { status: true, reference: true } }),
      tx.agentAccreditation.findFirst({ where: { agentId: d.agentId, electionCycleId: d.electionCycleId }, select: { status: true } }),
      approvedRegistryId(tx, d.electionCycleId),
    ]);
    const ids = d.id ? [d.id] : [];
    if (agent && agent.status !== 'ACTIVE' && agent.status !== 'STANDBY') {
      out.push({ kind: 'AGENT_NOT_ACTIVE', message: `Agent ${agent.reference} is ${agent.status.toLowerCase()}`, deploymentIds: ids, agentId: d.agentId, pollingStationCode: d.pollingStationCode, blocking: false });
    }
    if (!accr || (accr.status !== 'APPROVED' && accr.status !== 'NOT_APPLICABLE')) {
      out.push({
        kind: 'AGENT_NOT_ACCREDITED',
        message: `Accreditation for this election is ${accr ? accr.status.toLowerCase().replace(/_/g, ' ') : 'not recorded'}`,
        deploymentIds: ids,
        agentId: d.agentId,
        pollingStationCode: d.pollingStationCode,
        blocking: false,
      });
    }
    const inRegistry = reg ? await tx.pollingStation.count({ where: { registryVersionId: reg, code: d.pollingStationCode } }) : 0;
    if (!inRegistry) {
      out.push({ kind: 'STATION_NOT_IN_APPROVED_REGISTRY', message: `Station ${d.pollingStationCode} is not in the approved registry`, deploymentIds: ids, agentId: d.agentId, pollingStationCode: d.pollingStationCode, blocking: false });
    }
    return out;
  }

  /**
   * Serialise writers of one agent's bookings (and, for a chief agent, one station's chief
   * slot) in the cycle before the conflict check. The partial unique indexes only catch an
   * identical shift; FULL_DAY overlaps MORNING / AFTERNOON, so without this lock two planners
   * could both pass the check under READ COMMITTED. Locks are always taken agent first, then
   * station, and at most one of each per transaction, so they cannot deadlock.
   */
  private async lockSlot(tx: TenantTx, slot: { agentId: string; electionCycleId: string; pollingStationCode: string; role: string }): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deployment-agent:${slot.electionCycleId}:${slot.agentId}`}, 0))`;
    if (slot.role === 'CHIEF_AGENT') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deployment-chief:${slot.electionCycleId}:${slot.pollingStationCode}`}, 0))`;
    }
  }

  /** Blocking conflicts: the agent double-booked on an overlapping shift, or a second active chief agent. */
  private async blockingConflicts(
    tx: TenantTx,
    slot: { agentId: string; electionCycleId: string; pollingStationCode: string; role: string; shift: DeploymentShift },
    excludeIds: string[] = [],
  ): Promise<DeploymentConflict[]> {
    const out: DeploymentConflict[] = [];
    const own = await tx.deployment.findMany({
      where: { agentId: slot.agentId, electionCycleId: slot.electionCycleId, status: { in: ACTIVE }, id: { notIn: excludeIds } },
      select: { id: true, shift: true, pollingStationCode: true },
    });
    const clash = own.filter((o) => shiftsOverlap(o.shift, slot.shift));
    if (clash.length > 0) {
      out.push({
        kind: 'AGENT_DOUBLE_BOOKED',
        message: `The agent already holds an active deployment on an overlapping shift (station ${clash.map((c) => c.pollingStationCode).join(', ')})`,
        deploymentIds: clash.map((c) => c.id),
        agentId: slot.agentId,
        pollingStationCode: slot.pollingStationCode,
        blocking: true,
      });
    }
    if (slot.role === 'CHIEF_AGENT') {
      const chiefs = await tx.deployment.findMany({
        where: { electionCycleId: slot.electionCycleId, pollingStationCode: slot.pollingStationCode, role: 'CHIEF_AGENT', status: { in: ACTIVE }, id: { notIn: excludeIds } },
        select: { id: true, shift: true },
      });
      const taken = chiefs.filter((c) => shiftsOverlap(c.shift, slot.shift));
      if (taken.length > 0) {
        out.push({
          kind: 'SLOT_ALREADY_FILLED',
          message: `Station ${slot.pollingStationCode} already has an active chief agent on an overlapping shift`,
          deploymentIds: taken.map((c) => c.id),
          agentId: slot.agentId,
          pollingStationCode: slot.pollingStationCode,
          blocking: true,
        });
      }
    }
    return out;
  }

  /** The agent must exist, be ACTIVE or STANDBY and be visible to the planner. */
  private async assertAssignableAgent(tx: TenantTx, auth: AuthContext, agentId: string, path: string) {
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true, status: true, reference: true, userId: true, homeCountyId: true, homeConstituencyId: true, homeWardId: true } });
    if (!agent) throw AppException.validation('Unknown agent', [{ path: [path], message: 'Agent not found' }]);
    const wheres = [agentScopeWhere(this.permissions.scopeFor(auth, 'field.deployment.plan'))];
    if (auth.permissions.has('field.agents.view')) wheres.push(agentScopeWhere(this.permissions.scopeFor(auth, 'field.agents.view')));
    // undefined = organisation-wide: every agent is visible.
    const visible = wheres.some((w) => w === undefined) || (await tx.agent.count({ where: { id: agentId, OR: wheres as Prisma.AgentWhereInput[] } })) > 0;
    if (!visible) throw AppException.outOfScope('The agent is outside your assigned geography');
    if (agent.status !== 'ACTIVE' && agent.status !== 'STANDBY') {
      throw AppException.conflict(`Agent ${agent.reference} is ${agent.status.toLowerCase()} and cannot be deployed`, {
        conflicts: [{ kind: 'AGENT_NOT_ACTIVE', message: `Agent ${agent.reference} is ${agent.status.toLowerCase()}`, deploymentIds: [], agentId, pollingStationCode: null, blocking: true }],
      });
    }
    return agent;
  }

  private async event(
    tx: TenantTx,
    auth: AuthContext,
    deploymentId: string,
    type: Prisma.DeploymentEventUncheckedCreateInput['type'],
    from: Prisma.DeploymentEventUncheckedCreateInput['fromStatus'],
    to: Prisma.DeploymentEventUncheckedCreateInput['toStatus'],
    extra: { note?: string | null; hasLocation?: boolean; submittedOffline?: boolean; clientCreatedAt?: string | null } = {},
  ) {
    await tx.deploymentEvent.create({
      data: {
        tenantId: auth.tenantId,
        deploymentId,
        type,
        fromStatus: from ?? null,
        toStatus: to ?? null,
        note: extra.note ?? null,
        hasLocation: extra.hasLocation ?? false,
        submittedOffline: extra.submittedOffline ?? false,
        clientCreatedAt: extra.clientCreatedAt ? new Date(extra.clientCreatedAt) : null,
        actorId: auth.userId,
      },
    });
  }

  private async notifyAssigned(tx: TenantTx, auth: AuthContext, agentUserId: string | null, role: keyof typeof DEPLOYMENT_ROLE_LABELS, code: string) {
    if (!agentUserId) return;
    await notifyUsers(tx, auth.tenantId, [agentUserId], {
      module: 'field',
      type: 'deployment.assigned',
      title: 'New assignment',
      body: `${DEPLOYMENT_ROLE_LABELS[role]} at polling station ${code}. Open the app to confirm.`,
      link: '/m',
    });
  }

  async detailInTx(tx: TenantTx, auth: AuthContext, id: string): Promise<DeploymentDetail> {
    const d = await this.load(tx, id);
    const [summary] = await toDeploymentSummaries(tx, [d]);
    const [events, createdBy, warnings] = await Promise.all([
      tx.deploymentEvent.findMany({ where: { deploymentId: id }, include: { actor: USER_REF }, orderBy: { createdAt: 'asc' } }),
      tx.user.findUnique({ where: { id: d.createdById }, select: { id: true, displayName: true } }),
      ACTIVE.includes(d.status) ? this.slotWarnings(tx, d) : Promise.resolve([]),
    ]);
    const canView = this.can(auth, 'field.deployment.view', d);
    const canPlan = this.can(auth, 'field.deployment.plan', d);
    const own = d.agent.userId === auth.userId && auth.permissions.has('field.deployment.checkin');
    const actions = new Set<DeploymentDetail['allowedActions'][number]>();
    if (canPlan && (d.status === 'ASSIGNED' || d.status === 'CONFIRMED')) ['edit', 'cancel', 'replace'].forEach((a) => actions.add(a as never));
    if (canPlan && d.status === 'CHECKED_IN') actions.add('replace');
    if (own) ownDeploymentActions(d.status).forEach((a) => actions.add(a));
    return {
      ...summary!,
      instructions: d.instructions,
      checkInLocation:
        canView && d.checkInLatitude !== null && d.checkInLongitude !== null
          ? { latitude: Number(d.checkInLatitude), longitude: Number(d.checkInLongitude), accuracyMetres: d.checkInAccuracyMetres, capturedAt: (d.checkedInAt ?? d.updatedAt).toISOString() }
          : null,
      cancelledReason: d.cancelledReason,
      createdBy: createdBy ?? { id: d.createdById, displayName: 'Unknown user' },
      createdAt: d.createdAt.toISOString(),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        note: e.note,
        actor: e.actor,
        hasLocation: e.hasLocation,
        submittedOffline: e.submittedOffline,
        createdAt: e.createdAt.toISOString(),
      })),
      allowedActions: [...actions],
      warnings,
    };
  }

  /* ---------------------------------- reads --------------------------------- */

  list(auth: AuthContext, q: DeploymentQuery): Promise<Paginated<DeploymentSummary>> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const statuses = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const and: Prisma.DeploymentWhereInput[] = [
        (fieldScopeWhere(this.permissions.scopeFor(auth, 'field.deployment.view')) ?? {}) as Prisma.DeploymentWhereInput,
        { electionCycleId: cycle.id },
      ];
      if (statuses) and.push({ status: { in: statuses } });
      if (!q.includeInactive) and.push({ status: { notIn: ['REPLACED', 'CANCELLED'] } });
      if (q.countyId) and.push({ countyId: q.countyId });
      if (q.constituencyId) and.push({ constituencyId: q.constituencyId });
      if (q.wardId) and.push({ wardId: q.wardId });
      if (q.pollingStationCode) and.push({ pollingStationCode: q.pollingStationCode });
      if (q.agentId) and.push({ agentId: q.agentId });
      if (q.role) and.push({ role: q.role });
      if (q.shift) and.push({ shift: q.shift });
      if (q.q) and.push({ OR: [{ pollingStationCode: contains(q.q) }, { agent: { reference: contains(q.q) } }, { agent: { familyName: contains(q.q) } }, { agent: { givenName: contains(q.q) } }] });
      const where: Prisma.DeploymentWhereInput = { AND: and };
      const orderBy: Prisma.DeploymentOrderByWithRelationInput[] =
        q.sort === 'updatedAt' ? [{ updatedAt: q.order }] : q.sort === 'status' ? [{ status: q.order }, { pollingStationCode: 'asc' }] : [{ pollingStationCode: 'asc' }, { role: 'asc' }, { shift: 'asc' }];
      const [rows, total] = await Promise.all([tx.deployment.findMany({ where, include: DEPLOYMENT_INCLUDE, orderBy, ...paging(q) }), tx.deployment.count({ where })]);
      return { items: await toDeploymentSummaries(tx, rows), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(auth: AuthContext, id: string): Promise<DeploymentDetail> {
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, auth, id));
  }

  /**
   * Planner grid (S14): every approved-registry station in scope with its
   * active slots. Uncovered stations are listed as "Not assigned", never
   * dropped; conflicts are listed for the planner to resolve.
   */
  coverage(auth: AuthContext, q: DeploymentCoverageQuery): Promise<DeploymentCoverage> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const registry = await tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' }, select: { id: true, version: true } });
      const scope = this.permissions.scopeFor(auth, 'field.deployment.view', cycle.id);
      const asOf = new Date().toISOString();
      if (!registry) {
        return { electionCycleId: cycle.id, registryVersion: null, expectedStations: 0, coveredStations: 0, conflicts: [], stations: { items: [], page: q.page, pageSize: q.pageSize, total: 0 }, asOf };
      }
      const stationWhere = Prisma.sql`${expectedStationSql(registry.id)} AND ${scopeSql(scope, cycle.id, STATION_COLS('ps'))} AND ${areaFilterSql(q, STATION_COLS('ps'))}`;
      const covered = Prisma.sql`EXISTS (SELECT 1 FROM deployments d WHERE d.election_cycle_id = ${cycle.id}::uuid AND d.polling_station_code = ps.code
        AND d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN') AND d.role IN ('CHIEF_AGENT','STATION_AGENT'))`;
      const [counts] = await tx.$queryRaw<Array<{ expected: bigint; covered: bigint }>>`
        SELECT count(*) AS expected, count(*) FILTER (WHERE ${covered}) AS covered FROM polling_stations ps WHERE ${stationWhere}`;
      const pageWhere = q.uncoveredOnly ? Prisma.sql`${stationWhere} AND NOT ${covered}` : stationWhere;
      const [pageTotal] = q.uncoveredOnly
        ? await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM polling_stations ps WHERE ${pageWhere}`
        : [{ n: counts!.expected }];
      const stations = await tx.$queryRaw<Array<{ code: string; name: string; ward: string | null }>>`
        SELECT ps.code, ps.name, w.official_name AS ward FROM polling_stations ps LEFT JOIN geographic_units w ON w.id = ps.ward_id
        WHERE ${pageWhere} ORDER BY ps.code LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
      const slots = stations.length
        ? await tx.deployment.findMany({
            where: { electionCycleId: cycle.id, pollingStationCode: { in: stations.map((s) => s.code) }, status: { in: ACTIVE } },
            include: { agent: { select: { givenName: true, familyName: true } } },
            orderBy: [{ role: 'asc' }, { shift: 'asc' }],
          })
        : [];
      const byCode = new Map<string, typeof slots>();
      for (const s of slots) byCode.set(s.pollingStationCode, [...(byCode.get(s.pollingStationCode) ?? []), s]);
      return {
        electionCycleId: cycle.id,
        registryVersion: registry.version,
        expectedStations: Number(counts!.expected),
        coveredStations: Number(counts!.covered),
        conflicts: await this.coverageConflicts(tx, auth, cycle.id, registry.id, q),
        stations: {
          items: stations.map((s) => {
            const mine = byCode.get(s.code) ?? [];
            return {
              pollingStationCode: s.code,
              pollingStationName: s.name,
              ward: s.ward,
              slots: mine.map((d) => ({ role: d.role, shift: d.shift, deploymentId: d.id, agentId: d.agentId, agentDisplayName: agentDisplayName(d.agent), status: d.status })),
              covered: mine.some((d) => (COVERING_ROLES as readonly string[]).includes(d.role)),
            };
          }),
          page: q.page,
          pageSize: q.pageSize,
          total: Number(pageTotal!.n),
        },
        asOf,
      };
    });
  }

  private async coverageConflicts(tx: TenantTx, auth: AuthContext, cycleId: string, registryId: string, q: DeploymentCoverageQuery): Promise<DeploymentConflict[]> {
    const scope = this.permissions.scopeFor(auth, 'field.deployment.view', cycleId);
    const dScope = (alias: string) => Prisma.sql`${scopeSql(scope, cycleId, FIELD_COLS(alias))} AND ${areaFilterSql(q, FIELD_COLS(alias))}`;
    const active = Prisma.sql`('ASSIGNED','CONFIRMED','CHECKED_IN')`;
    const out: DeploymentConflict[] = [];
    const doubles = await tx.$queryRaw<Array<{ a: string; b: string; agent_id: string; code_a: string; code_b: string }>>`
      SELECT d1.id AS a, d2.id AS b, d1.agent_id, d1.polling_station_code AS code_a, d2.polling_station_code AS code_b
      FROM deployments d1 JOIN deployments d2 ON d2.agent_id = d1.agent_id AND d2.election_cycle_id = d1.election_cycle_id AND d1.id < d2.id
      WHERE d1.election_cycle_id = ${cycleId}::uuid AND d1.status IN ${active} AND d2.status IN ${active}
        AND (d1.shift = d2.shift OR d1.shift = 'FULL_DAY' OR d2.shift = 'FULL_DAY') AND ${dScope('d1')}
      LIMIT ${CONFLICT_LIMIT}`;
    for (const r of doubles) {
      out.push({ kind: 'AGENT_DOUBLE_BOOKED', message: `Agent is booked on overlapping shifts at ${r.code_a} and ${r.code_b}`, deploymentIds: [r.a, r.b], agentId: r.agent_id, pollingStationCode: r.code_a, blocking: true });
    }
    // Over-covered: more than one active station agent on overlapping shifts at one station.
    const over = await tx.$queryRaw<Array<{ a: string; b: string; code: string }>>`
      SELECT d1.id AS a, d2.id AS b, d1.polling_station_code AS code
      FROM deployments d1 JOIN deployments d2 ON d2.election_cycle_id = d1.election_cycle_id AND d2.polling_station_code = d1.polling_station_code
        AND d2.role = d1.role AND d1.id < d2.id
      WHERE d1.election_cycle_id = ${cycleId}::uuid AND d1.role IN ('STATION_AGENT','CHIEF_AGENT') AND d1.status IN ${active} AND d2.status IN ${active}
        AND (d1.shift = d2.shift OR d1.shift = 'FULL_DAY' OR d2.shift = 'FULL_DAY') AND ${dScope('d1')}
      LIMIT ${CONFLICT_LIMIT}`;
    for (const r of over) {
      out.push({ kind: 'SLOT_ALREADY_FILLED', message: `Station ${r.code} has more than one agent in the same role on overlapping shifts`, deploymentIds: [r.a, r.b], agentId: null, pollingStationCode: r.code, blocking: false });
    }
    const inactive = await tx.$queryRaw<Array<{ id: string; agent_id: string; code: string; status: string; reference: string }>>`
      SELECT d.id, d.agent_id, d.polling_station_code AS code, a.status::text AS status, a.reference FROM deployments d JOIN agents a ON a.id = d.agent_id
      WHERE d.election_cycle_id = ${cycleId}::uuid AND d.status IN ${active} AND a.status NOT IN ('ACTIVE','STANDBY') AND ${dScope('d')}
      LIMIT ${CONFLICT_LIMIT}`;
    for (const r of inactive) {
      out.push({ kind: 'AGENT_NOT_ACTIVE', message: `Agent ${r.reference} is ${r.status.toLowerCase()} but still deployed at ${r.code}`, deploymentIds: [r.id], agentId: r.agent_id, pollingStationCode: r.code, blocking: false });
    }
    const missing = await tx.$queryRaw<Array<{ id: string; agent_id: string; code: string }>>`
      SELECT d.id, d.agent_id, d.polling_station_code AS code FROM deployments d
      WHERE d.election_cycle_id = ${cycleId}::uuid AND d.status IN ${active} AND ${dScope('d')}
        AND NOT EXISTS (SELECT 1 FROM polling_stations ps WHERE ps.registry_version_id = ${registryId}::uuid AND ps.code = d.polling_station_code)
      LIMIT ${CONFLICT_LIMIT}`;
    for (const r of missing) {
      out.push({ kind: 'STATION_NOT_IN_APPROVED_REGISTRY', message: `Station ${r.code} is no longer in the approved registry`, deploymentIds: [r.id], agentId: r.agent_id, pollingStationCode: r.code, blocking: false });
    }
    const unaccredited = await tx.$queryRaw<Array<{ id: string; agent_id: string; code: string; reference: string }>>`
      SELECT d.id, d.agent_id, d.polling_station_code AS code, a.reference FROM deployments d JOIN agents a ON a.id = d.agent_id
      LEFT JOIN agent_accreditations ac ON ac.agent_id = d.agent_id AND ac.election_cycle_id = d.election_cycle_id
      WHERE d.election_cycle_id = ${cycleId}::uuid AND d.status IN ${active} AND ${dScope('d')}
        AND (ac.id IS NULL OR ac.status NOT IN ('APPROVED','NOT_APPLICABLE'))
      ORDER BY d.polling_station_code LIMIT ${CONFLICT_LIMIT}`;
    for (const r of unaccredited) {
      out.push({ kind: 'AGENT_NOT_ACCREDITED', message: `Agent ${r.reference} at ${r.code} has no approved accreditation for this election`, deploymentIds: [r.id], agentId: r.agent_id, pollingStationCode: r.code, blocking: false });
    }
    return out.slice(0, CONFLICT_LIMIT);
  }

  /* --------------------------------- planner -------------------------------- */

  private async createInTx(tx: TenantTx, auth: AuthContext, dto: CreateDeployment, replacesId: string | null = null): Promise<{ id: string; warnings: DeploymentConflict[] }> {
    const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), dto.electionCycleId);
    const loc = await resolveStationByCode(tx, cycle.id, dto.pollingStationCode);
    if (!scopeAllows(this.permissions.scopeFor(auth, 'field.deployment.plan'), fieldGeoLocation(loc))) {
      throw AppException.outOfScope('The polling station is outside your planning area');
    }
    const agent = await this.assertAssignableAgent(tx, auth, dto.agentId, 'agentId');
    if (dto.supervisorAgentId) {
      if (dto.supervisorAgentId === dto.agentId) throw AppException.validation('An agent cannot supervise themself', [{ path: ['supervisorAgentId'], message: 'Choose another agent' }]);
      const sup = await tx.agent.findUnique({ where: { id: dto.supervisorAgentId }, select: { id: true } });
      if (!sup) throw AppException.validation('Unknown supervisor', [{ path: ['supervisorAgentId'], message: 'Agent not found' }]);
    }
    await this.lockSlot(tx, { agentId: dto.agentId, electionCycleId: cycle.id, pollingStationCode: loc.pollingStationCode, role: dto.role });
    const blocking = await this.blockingConflicts(tx, { agentId: dto.agentId, electionCycleId: cycle.id, pollingStationCode: loc.pollingStationCode, role: dto.role, shift: dto.shift });
    if (blocking.length > 0) throw AppException.conflict(blocking.map((c) => c.message).join('; '), { conflicts: blocking });
    let created: { id: string };
    try {
      created = await tx.deployment.create({
        data: {
          tenantId: auth.tenantId,
          electionCycleId: cycle.id,
          agentId: dto.agentId,
          pollingStationCode: loc.pollingStationCode,
          countyId: loc.countyId!,
          constituencyId: loc.constituencyId!,
          wardId: loc.wardId!,
          pollingCentreId: loc.pollingCentreId,
          role: dto.role,
          shift: dto.shift,
          supervisorAgentId: dto.supervisorAgentId,
          instructions: dto.instructions,
          replacesDeploymentId: replacesId,
          createdById: auth.userId,
        },
        select: { id: true },
      });
    } catch (e) {
      // Partial unique indexes are the backstop for concurrent planners.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw AppException.conflict('The slot was taken or the agent was booked by someone else just now. Reload and try again.', {
          conflicts: [{ kind: 'SLOT_ALREADY_FILLED', message: 'Concurrent assignment', deploymentIds: [], agentId: dto.agentId, pollingStationCode: loc.pollingStationCode, blocking: true }],
        });
      }
      throw e;
    }
    await this.event(tx, auth, created.id, 'CREATED', null, 'ASSIGNED', { note: replacesId ? 'Replacement assignment' : null });
    const warnings = await this.slotWarnings(tx, { id: created.id, agentId: dto.agentId, electionCycleId: cycle.id, pollingStationCode: loc.pollingStationCode });
    await this.audit.record(
      {
        tenantId: auth.tenantId,
        action: AUDIT_ACTIONS.DEPLOYMENT_CREATED,
        entityType: FIELD_ENTITY.DEPLOYMENT,
        entityId: created.id,
        after: { agentId: dto.agentId, electionCycleId: cycle.id, pollingStationCode: loc.pollingStationCode, role: dto.role, shift: dto.shift, status: 'ASSIGNED', replacesDeploymentId: replacesId, warnings: warnings.map((w) => w.kind) },
      },
      tx,
    );
    await this.notifyAssigned(tx, auth, agent.userId, dto.role, loc.pollingStationCode);
    return { id: created.id, warnings };
  }

  create(auth: AuthContext, dto: CreateDeployment): Promise<DeploymentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const { id } = await this.createInTx(tx, auth, dto);
      return this.detailInTx(tx, auth, id);
    });
  }

  /** Bulk assignment: each item in its own transaction; one refusal never rolls back another. */
  async bulkCreate(auth: AuthContext, dto: BulkCreateDeployment): Promise<BulkDeploymentResult> {
    const filter = new AllExceptionsFilter();
    const results: BulkDeploymentResult['results'] = [];
    for (const [index, item] of dto.items.entries()) {
      try {
        const r = await this.prisma.tenantTx((tx) => this.createInTx(tx, auth, item));
        results.push({ index, outcome: 'CREATED', deploymentId: r.id, warnings: r.warnings, error: null });
      } catch (e) {
        const err = filter.toApiError(e);
        if (err.statusCode >= 500) throw e;
        results.push({ index, outcome: 'REFUSED', deploymentId: null, warnings: [], error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
      }
    }
    return { created: results.filter((r) => r.outcome === 'CREATED').length, refused: results.filter((r) => r.outcome === 'REFUSED').length, results };
  }

  update(auth: AuthContext, id: string, dto: UpdateDeployment): Promise<DeploymentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const d = await this.load(tx, id);
      if (d.status !== 'ASSIGNED' && d.status !== 'CONFIRMED') throw immutableRecord(`A ${d.status.toLowerCase().replace('_', ' ')} deployment cannot be edited`);
      if (d.version !== dto.expectedVersion) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.DeploymentUncheckedUpdateManyInput = {};
      if (dto.shift !== undefined && dto.shift !== d.shift) {
        await this.lockSlot(tx, d);
        const blocking = await this.blockingConflicts(tx, { agentId: d.agentId, electionCycleId: d.electionCycleId, pollingStationCode: d.pollingStationCode, role: d.role, shift: dto.shift }, [id]);
        if (blocking.length > 0) throw AppException.conflict(blocking.map((c) => c.message).join('; '), { conflicts: blocking });
        before.shift = d.shift;
        after.shift = dto.shift;
        data.shift = dto.shift;
      }
      if (dto.supervisorAgentId !== undefined && dto.supervisorAgentId !== d.supervisorAgentId) {
        if (dto.supervisorAgentId === d.agentId) throw AppException.validation('An agent cannot supervise themself', [{ path: ['supervisorAgentId'], message: 'Choose another agent' }]);
        if (dto.supervisorAgentId && !(await tx.agent.findUnique({ where: { id: dto.supervisorAgentId }, select: { id: true } }))) {
          throw AppException.validation('Unknown supervisor', [{ path: ['supervisorAgentId'], message: 'Agent not found' }]);
        }
        before.supervisorAgentId = d.supervisorAgentId;
        after.supervisorAgentId = dto.supervisorAgentId;
        data.supervisorAgentId = dto.supervisorAgentId;
      }
      if (dto.instructions !== undefined && dto.instructions !== d.instructions) {
        before.instructions = d.instructions ? 'set' : null;
        after.instructions = dto.instructions ? 'set' : null;
        data.instructions = dto.instructions;
      }
      if (Object.keys(after).length > 0) {
        try {
          const r = await tx.deployment.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
          if (r.count === 0) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppException.conflict('The agent or slot was booked by someone else just now. Reload and try again.');
          throw e;
        }
        await this.event(tx, auth, id, 'UPDATED', d.status, d.status, { note: dto.reason ?? null });
        await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_UPDATED, entityType: FIELD_ENTITY.DEPLOYMENT, entityId: id, before, after, reason: dto.reason ?? null }, tx);
      }
      return this.detailInTx(tx, auth, id);
    });
  }

  replace(auth: AuthContext, id: string, dto: ReplaceDeployment): Promise<ReplaceDeploymentResult> {
    return this.prisma.tenantTx(async (tx) => {
      const d = await this.load(tx, id);
      if (!canTransitionDeployment(d.status, 'REPLACED')) throw AppException.invalidTransition(d.status, 'REPLACED');
      if (d.version !== dto.expectedVersion) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
      if (dto.successorAgentId === d.agentId) throw AppException.validation('Choose a different agent as the replacement', [{ path: ['successorAgentId'], message: 'Same agent' }]);
      const r = await tx.deployment.updateMany({ where: { id, version: dto.expectedVersion }, data: { status: 'REPLACED', version: { increment: 1 } } });
      if (r.count === 0) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
      await this.event(tx, auth, id, 'REPLACED', d.status, 'REPLACED', { note: dto.reason });
      const successor = await this.createInTx(
        tx,
        auth,
        { electionCycleId: d.electionCycleId, agentId: dto.successorAgentId, pollingStationCode: d.pollingStationCode, role: d.role, shift: d.shift, supervisorAgentId: d.supervisorAgentId, instructions: d.instructions },
        id,
      );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DEPLOYMENT_REPLACED,
          entityType: FIELD_ENTITY.DEPLOYMENT,
          entityId: id,
          before: { status: d.status, agentId: d.agentId },
          after: { status: 'REPLACED', successorDeploymentId: successor.id, successorAgentId: dto.successorAgentId },
          reason: dto.reason,
        },
        tx,
      );
      return { replaced: await this.detailInTx(tx, auth, id), successor: await this.detailInTx(tx, auth, successor.id) };
    });
  }

  cancel(auth: AuthContext, id: string, dto: CancelDeployment): Promise<DeploymentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const d = await this.load(tx, id);
      if (d.status !== 'ASSIGNED' && d.status !== 'CONFIRMED') throw AppException.invalidTransition(d.status, 'CANCELLED');
      if (d.version !== dto.expectedVersion) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
      const r = await tx.deployment.updateMany({ where: { id, version: dto.expectedVersion }, data: { status: 'CANCELLED', cancelledReason: dto.reason, version: { increment: 1 } } });
      if (r.count === 0) throw serverChanged(d.version, await this.detailInTx(tx, auth, id));
      await this.event(tx, auth, id, 'CANCELLED', d.status, 'CANCELLED', { note: dto.reason });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_STATUS_CHANGED, entityType: FIELD_ENTITY.DEPLOYMENT, entityId: id, before: { status: d.status }, after: { status: 'CANCELLED' }, reason: dto.reason },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  /* ------------------------------ agent (mobile) ----------------------------- */

  /**
   * True when the only change since `expectedVersion` is the agent's own confirmation (one
   * version step, latest event CONFIRMED by the caller): a check-in queued right after a
   * confirmation carries the pre-confirmation version and is not a conflict. Any change by a
   * coordinator (an UPDATED event or a second version step) still is.
   */
  private async onlyOwnConfirmationSince(tx: TenantTx, auth: AuthContext, d: DeploymentRow, expectedVersion: number): Promise<boolean> {
    if (d.status !== 'CONFIRMED' || d.version !== expectedVersion + 1) return false;
    const last = await tx.deploymentEvent.findFirst({ where: { deploymentId: d.id }, orderBy: { createdAt: 'desc' }, select: { type: true, actorId: true } });
    return last?.type === 'CONFIRMED' && last.actorId === auth.userId;
  }

  /** Own deployment only, and never one that was replaced or cancelled (409 SERVER_CHANGED). */
  private async loadOwn(tx: TenantTx, auth: AuthContext, id: string, expectedVersion: number): Promise<DeploymentRow> {
    const d = await this.load(tx, id);
    if (d.agent.userId !== auth.userId) throw AppException.forbidden('You can only act on your own assignments');
    if (d.status === 'REPLACED' || d.status === 'CANCELLED') {
      throw serverChanged(d.version, await this.summary(tx, id), `This assignment was ${d.status.toLowerCase()} by your coordinator.`);
    }
    if (d.version !== expectedVersion && (d.status === 'ASSIGNED' || d.status === 'CONFIRMED') && !(await this.onlyOwnConfirmationSince(tx, auth, d, expectedVersion))) {
      throw serverChanged(d.version, await this.summary(tx, id), 'Your assignment was changed by your coordinator. Review it and try again.');
    }
    return d;
  }

  private auditMeta(ctx: FieldWriteContext) {
    return { via: ctx.via, deviceId: ctx.deviceId };
  }

  /** ASSIGNED → CONFIRMED (no ledger: the caller wraps it). Already confirmed or later: unchanged. */
  async confirmInTx(tx: TenantTx, auth: AuthContext, id: string, dto: ConfirmDeployment, ctx: FieldWriteContext): Promise<DeploymentDetail> {
    assertOfflineAge(await this.modules.fieldConfig(tx), dto.clientCreatedAt);
    const d = await this.loadOwn(tx, auth, id, dto.expectedVersion);
    if (d.status === 'ASSIGNED') {
      const r = await tx.deployment.updateMany({ where: { id, version: d.version }, data: { status: 'CONFIRMED', confirmedAt: new Date(dto.clientCreatedAt), version: { increment: 1 } } });
      if (r.count === 0) throw serverChanged(d.version, await this.summary(tx, id));
      await this.event(tx, auth, id, 'CONFIRMED', 'ASSIGNED', 'CONFIRMED', { submittedOffline: dto.submittedOffline, clientCreatedAt: dto.clientCreatedAt });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_STATUS_CHANGED, entityType: FIELD_ENTITY.DEPLOYMENT, entityId: id, before: { status: 'ASSIGNED' }, after: { status: 'CONFIRMED', submittedOffline: dto.submittedOffline, ...this.auditMeta(ctx) } },
        tx,
      );
    }
    return this.detailInTx(tx, auth, id);
  }

  /** CONFIRMED → CHECKED_IN (from ASSIGNED: CONFIRMED then CHECKED_IN, two events). */
  async checkInInTx(tx: TenantTx, auth: AuthContext, id: string, dto: CheckIn, ctx: FieldWriteContext): Promise<DeploymentDetail> {
    const config = await this.modules.fieldConfig(tx);
    assertOfflineAge(config, dto.clientCreatedAt);
    assertOfflineAge(config, dto.checkedInAt);
    if (dto.location && !config.checkInLocationEnabled) {
      throw AppException.validation('Location is not collected with check-ins in this organisation', [{ path: ['location'], message: 'Not enabled' }]);
    }
    const d = await this.loadOwn(tx, auth, id, dto.expectedVersion);
    if (d.status === 'ASSIGNED' || d.status === 'CONFIRMED') {
      const r = await tx.deployment.updateMany({
        where: { id, version: d.version },
        data: {
          status: 'CHECKED_IN',
          confirmedAt: d.confirmedAt ?? new Date(dto.checkedInAt),
          checkedInAt: new Date(dto.checkedInAt),
          checkInLatitude: dto.location ? new Prisma.Decimal(dto.location.latitude.toFixed(6)) : null,
          checkInLongitude: dto.location ? new Prisma.Decimal(dto.location.longitude.toFixed(6)) : null,
          checkInAccuracyMetres: dto.location?.accuracyMetres != null ? Math.round(dto.location.accuracyMetres) : null,
          version: { increment: 1 },
        },
      });
      if (r.count === 0) throw serverChanged(d.version, await this.summary(tx, id));
      const meta = { submittedOffline: dto.submittedOffline, clientCreatedAt: dto.clientCreatedAt };
      if (d.status === 'ASSIGNED') await this.event(tx, auth, id, 'CONFIRMED', 'ASSIGNED', 'CONFIRMED', { ...meta, note: 'Confirmed with check-in' });
      await this.event(tx, auth, id, 'CHECKED_IN', 'CONFIRMED', 'CHECKED_IN', { ...meta, hasLocation: !!dto.location });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DEPLOYMENT_CHECKED_IN,
          entityType: FIELD_ENTITY.DEPLOYMENT,
          entityId: id,
          before: { status: d.status },
          after: { status: 'CHECKED_IN', checkedInAt: dto.checkedInAt, hasLocation: !!dto.location, submittedOffline: dto.submittedOffline, ...this.auditMeta(ctx) },
        },
        tx,
      );
    }
    return this.detailInTx(tx, auth, id);
  }

  private async viaLedger(
    auth: AuthContext,
    kind: 'ASSIGNMENT_CONFIRMATION' | 'CHECK_IN',
    id: string,
    dto: ConfirmDeployment | CheckIn,
    apply: (tx: TenantTx) => Promise<DeploymentDetail>,
  ): Promise<{ replayed: boolean; result: DeploymentDetail }> {
    return this.prisma.tenantTx((tx) =>
      this.ledger.run(
        tx,
        auth,
        { idempotencyKey: dto.clientIdempotencyKey, deviceId: dto.deviceId, kind, clientCreatedAt: dto.clientCreatedAt, payload: { ...dto, deploymentId: id } },
        { type: FIELD_ENTITY.DEPLOYMENT, id: (r) => r.id, reference: (r) => r.location.station?.code ?? null },
        () => apply(tx),
        (resultId) => this.detailInTx(tx, auth, resultId),
      ),
    );
  }

  confirm(auth: AuthContext, id: string, dto: ConfirmDeployment) {
    return this.viaLedger(auth, 'ASSIGNMENT_CONFIRMATION', id, dto, (tx) => this.confirmInTx(tx, auth, id, dto, { via: 'api', deviceId: dto.deviceId }));
  }

  checkIn(auth: AuthContext, id: string, dto: CheckIn) {
    return this.viaLedger(auth, 'CHECK_IN', id, dto, (tx) => this.checkInInTx(tx, auth, id, dto, { via: 'api', deviceId: dto.deviceId }));
  }

  checkOut(auth: AuthContext, id: string, dto: CheckOut): Promise<DeploymentDetail> {
    return this.prisma.tenantTx(async (tx) => {
      const d = await this.load(tx, id);
      if (d.agent.userId !== auth.userId) throw AppException.forbidden('You can only act on your own assignments');
      if (!canTransitionDeployment(d.status, 'CHECKED_OUT')) throw AppException.invalidTransition(d.status, 'CHECKED_OUT');
      if (d.version !== dto.expectedVersion) throw serverChanged(d.version, await this.summary(tx, id));
      assertOfflineAge(await this.modules.fieldConfig(tx), dto.checkedOutAt);
      const r = await tx.deployment.updateMany({ where: { id, version: dto.expectedVersion }, data: { status: 'CHECKED_OUT', checkedOutAt: new Date(dto.checkedOutAt), version: { increment: 1 } } });
      if (r.count === 0) throw serverChanged(d.version, await this.summary(tx, id));
      await this.event(tx, auth, id, 'CHECKED_OUT', 'CHECKED_IN', 'CHECKED_OUT', { note: dto.note });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.DEPLOYMENT_STATUS_CHANGED, entityType: FIELD_ENTITY.DEPLOYMENT, entityId: id, before: { status: 'CHECKED_IN' }, after: { status: 'CHECKED_OUT', checkedOutAt: dto.checkedOutAt } },
        tx,
      );
      return this.detailInTx(tx, auth, id);
    });
  }

  /* --------------------------------- export --------------------------------- */

  rosterExport(auth: AuthContext, dto: RosterExport): Promise<SignedUrlResponse> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), dto.electionCycleId);
      const and: Prisma.DeploymentWhereInput[] = [
        (fieldScopeWhere(this.permissions.scopeFor(auth, 'field.deployment.plan')) ?? {}) as Prisma.DeploymentWhereInput,
        { electionCycleId: cycle.id, status: { in: ACTIVE } },
      ];
      if (dto.geographicUnitId) {
        and.push({ OR: [{ countyId: dto.geographicUnitId }, { constituencyId: dto.geographicUnitId }, { wardId: dto.geographicUnitId }, { pollingCentreId: dto.geographicUnitId }] });
      }
      const rows = await tx.deployment.findMany({
        where: { AND: and },
        include: { agent: { select: { reference: true, givenName: true, familyName: true, phoneMasked: true } } },
        orderBy: [{ pollingStationCode: 'asc' }, { role: 'asc' }],
        take: 100_000,
      });
      const reg = await approvedRegistryId(tx, cycle.id);
      const names = new Map<string, string>();
      if (reg && rows.length) {
        const sts = await tx.$queryRaw<Array<{ code: string; name: string }>>`SELECT code, name FROM polling_stations WHERE registry_version_id = ${reg}::uuid`;
        sts.forEach((s) => names.set(s.code, s.name));
      }
      const cell = (v: string | null | undefined) => {
        const s = (v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const demoLabel = await cycleOrTenantDataLabel(tx, auth.tenantId, cycle.id);
      const lines = [
        ...(demoLabel ? exportLabelLines(demoLabel.label, demoLabel.notes).map((l) => `# ${l}`) : []),
        `# ${DATA_PROVENANCE_LABELS[cycle.dataProvenance]}. Internal deployment roster for ${cycle.name}. Contact values are masked.`,
        'station_code,station_name,role,shift,status,agent_reference,agent_name,phone_masked',
        ...rows.map((d) =>
          [d.pollingStationCode, names.get(d.pollingStationCode) ?? '', d.role, d.shift, d.status, d.agent.reference, agentDisplayName(d.agent), d.agent.phoneMasked ?? ''].map(cell).join(','),
        ),
      ];
      const buffer = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
      const { file } = await this.storage.storeImmutable(
        { tenantId: auth.tenantId, uploadedById: auth.userId, buffer, declaredMimeType: 'text/csv', originalFilename: `deployment-roster-${cycle.electionDate.getUTCFullYear()}-${new Date().toISOString().slice(0, 10)}.csv`, purpose: 'EXPORT' },
        tx,
      );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.DEPLOYMENT_ROSTER_EXPORTED,
          entityType: FIELD_ENTITY.DEPLOYMENT,
          entityId: file.id,
          after: { electionCycleId: cycle.id, geographicUnitId: dto.geographicUnitId, rows: rows.length, storedFileId: file.id, sha256: file.sha256 },
          reason: dto.reason,
        },
        tx,
      );
      const { url, expiresAt } = await this.storage.signedUrl(file, 'attachment');
      return { url, expiresAt: expiresAt.toISOString(), sha256: file.sha256 };
    });
  }
}
