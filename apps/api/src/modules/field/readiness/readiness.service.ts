import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type GenerateReadiness,
  type GenerateReadinessResult,
  type Paginated,
  READINESS_CATEGORIES,
  READINESS_STATUSES,
  type ReadinessCategory,
  type ReadinessChecklist,
  type ReadinessQuery,
  type ReadinessStatus,
  type ReadinessSummary,
  type UpdateReadinessItem,
  deriveReadinessStatus,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { resolveFieldCycle } from '../common/field-cycle';
import { fieldScopeWhere, loadFieldLocations } from '../common/field-location';
import { STATION_COLS, areaFilterSql, expectedStationSql, scopeSql, unitSql, withHashJoins } from '../common/field-sql';
import { USER_REF, iso, paging, serverChanged } from '../common/field-support';
import { FIELD_ENTITY } from '../field.constants';

const CHECKLIST_INCLUDE = {
  items: { include: { updatedBy: USER_REF }, orderBy: { category: 'asc' as const } },
} satisfies Prisma.ReadinessChecklistInclude;
type ChecklistRow = Prisma.ReadinessChecklistGetPayload<{ include: typeof CHECKLIST_INCLUDE }>;

/**
 * Election readiness (S15): one checklist per station code and cycle, one item
 * per category; the checklist status is derived from its items on every change.
 * Stations without a checklist count as not started, never as ready.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
  ) {}

  private async toDtos(tx: TenantTx, rows: ChecklistRow[]): Promise<ReadinessChecklist[]> {
    const locations = await loadFieldLocations(tx, rows);
    return rows.map((c, i) => ({
      id: c.id,
      location: locations[i]!,
      status: c.status,
      items: c.items.map((it) => ({
        id: it.id,
        category: it.category,
        status: it.status,
        note: it.note,
        dueAt: iso(it.dueAt),
        updatedBy: it.updatedBy,
        updatedAt: it.updatedAt.toISOString(),
        version: it.version,
      })),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  private async detailInTx(tx: TenantTx, id: string): Promise<ReadinessChecklist> {
    const c = await tx.readinessChecklist.findUnique({ where: { id }, include: CHECKLIST_INCLUDE });
    if (!c) throw AppException.notFound('Readiness checklist not found');
    return (await this.toDtos(tx, [c]))[0]!;
  }

  summary(auth: AuthContext, q: ReadinessQuery): Promise<ReadinessSummary> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const registry = await tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' }, select: { id: true } });
      const base = { electionCycleId: cycle.id, asOf: new Date().toISOString() };
      const zeroCats = READINESS_CATEGORIES.map((category) => ({ category, done: 0, blocked: 0, notApplicable: 0, pending: 0 }));
      if (!registry) {
        return { ...base, expectedStations: 0, stationsWithChecklist: 0, byStatus: READINESS_STATUSES.map((status) => ({ status, count: 0 })), byCategory: zeroCats, stationsWithoutAgent: 0, agentsTrainingCompleted: 0, agentsDeployed: 0, agentsAccredited: 0 };
      }
      const scope = this.permissions.scopeFor(auth, 'field.readiness.view', cycle.id);
      const where = Prisma.sql`${expectedStationSql(registry.id)} AND ${scopeSql(scope, cycle.id, STATION_COLS('ps'))} AND ${areaFilterSql(q, STATION_COLS('ps'))}`;
      const statusRows = await withHashJoins(tx, () => tx.$queryRaw<Array<{ status: ReadinessStatus | null; n: bigint }>>`
        SELECT rc.status::text AS status, count(*) AS n FROM polling_stations ps
        LEFT JOIN readiness_checklists rc ON rc.election_cycle_id = ${cycle.id}::uuid AND rc.polling_station_code = ps.code
        WHERE ${where} GROUP BY rc.status`);
      const expected = statusRows.reduce((s, r) => s + Number(r.n), 0);
      const withChecklist = statusRows.filter((r) => r.status !== null).reduce((s, r) => s + Number(r.n), 0);
      const byStatus = READINESS_STATUSES.map((status) => ({
        status,
        count: statusRows.filter((r) => r.status === status || (status === 'NOT_STARTED' && r.status === null)).reduce((s, r) => s + Number(r.n), 0),
      }));
      const catRows = await withHashJoins(tx, () => tx.$queryRaw<Array<{ category: ReadinessCategory; status: string; n: bigint }>>`
        SELECT ri.category::text AS category, ri.status::text AS status, count(*) AS n FROM polling_stations ps
        JOIN readiness_checklists rc ON rc.election_cycle_id = ${cycle.id}::uuid AND rc.polling_station_code = ps.code
        JOIN readiness_items ri ON ri.checklist_id = rc.id
        WHERE ${where} GROUP BY ri.category, ri.status`);
      const byCategory = READINESS_CATEGORIES.map((category) => {
        const count = (st: string) => catRows.filter((r) => r.category === category && r.status === st).reduce((s, r) => s + Number(r.n), 0);
        const done = count('DONE');
        const blocked = count('BLOCKED');
        const notApplicable = count('NOT_APPLICABLE');
        return { category, done, blocked, notApplicable, pending: Math.max(0, expected - done - blocked - notApplicable) };
      });
      const active = Prisma.sql`d.election_cycle_id = ${cycle.id}::uuid AND d.polling_station_code = ps.code AND d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN')`;
      const [agentRow] = await tx.$queryRaw<Array<{ without_agent: bigint; deployed: bigint; accredited: bigint; trained: bigint }>>`
        WITH st AS (SELECT ps.code FROM polling_stations ps WHERE ${where}),
        ag AS (SELECT DISTINCT d.agent_id FROM deployments d JOIN st ps ON ${active})
        SELECT
          (SELECT count(*) FROM st ps WHERE NOT EXISTS (SELECT 1 FROM deployments d WHERE ${active})) AS without_agent,
          (SELECT count(*) FROM ag) AS deployed,
          (SELECT count(*) FROM ag WHERE EXISTS (SELECT 1 FROM agent_accreditations ac WHERE ac.agent_id = ag.agent_id AND ac.election_cycle_id = ${cycle.id}::uuid AND ac.status = 'APPROVED')) AS accredited,
          (SELECT count(*) FROM ag WHERE EXISTS (SELECT 1 FROM agent_trainings t WHERE t.agent_id = ag.agent_id AND t.status = 'COMPLETED' AND (t.election_cycle_id IS NULL OR t.election_cycle_id = ${cycle.id}::uuid))) AS trained`;
      return {
        ...base,
        expectedStations: expected,
        stationsWithChecklist: withChecklist,
        byStatus,
        byCategory,
        stationsWithoutAgent: Number(agentRow!.without_agent),
        agentsTrainingCompleted: Number(agentRow!.trained),
        agentsDeployed: Number(agentRow!.deployed),
        agentsAccredited: Number(agentRow!.accredited),
      };
    });
  }

  list(auth: AuthContext, q: ReadinessQuery): Promise<Paginated<ReadinessChecklist>> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const and: Prisma.ReadinessChecklistWhereInput[] = [
        (fieldScopeWhere(this.permissions.scopeFor(auth, 'field.readiness.view')) ?? {}) as Prisma.ReadinessChecklistWhereInput,
        { electionCycleId: cycle.id },
      ];
      if (q.status) and.push({ status: q.status });
      if (q.countyId) and.push({ countyId: q.countyId });
      if (q.constituencyId) and.push({ constituencyId: q.constituencyId });
      if (q.wardId) and.push({ wardId: q.wardId });
      if (q.q) and.push({ pollingStationCode: { contains: q.q, mode: 'insensitive' } });
      if (q.category || q.itemStatus) and.push({ items: { some: { ...(q.category ? { category: q.category } : {}), ...(q.itemStatus ? { status: q.itemStatus } : {}) } } });
      const where: Prisma.ReadinessChecklistWhereInput = { AND: and };
      const orderBy: Prisma.ReadinessChecklistOrderByWithRelationInput[] =
        q.sort === 'updatedAt' ? [{ updatedAt: q.order }] : q.sort === 'status' ? [{ status: q.order }, { pollingStationCode: 'asc' }] : [{ pollingStationCode: 'asc' }];
      const [rows, total] = await Promise.all([
        tx.readinessChecklist.findMany({ where, include: CHECKLIST_INCLUDE, orderBy, ...paging(q) }),
        tx.readinessChecklist.count({ where }),
      ]);
      return { items: await this.toDtos(tx, rows), page: q.page, pageSize: q.pageSize, total };
    });
  }

  detail(_auth: AuthContext, id: string): Promise<ReadinessChecklist> {
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, id));
  }

  /** Create missing checklists for approved-registry stations in the caller's update scope (set-based SQL). */
  generate(auth: AuthContext, dto: GenerateReadiness): Promise<GenerateReadinessResult> {
    return this.prisma.tenantTx(
      async (tx) => {
        const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), dto.electionCycleId);
        const registry = await tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' }, select: { id: true } });
        if (!registry) throw AppException.conflict('No station registry version is approved for this election yet');
        if (dto.geographicUnitId && !(await tx.geographicUnit.findUnique({ where: { id: dto.geographicUnitId }, select: { id: true } }))) {
          throw AppException.validation('Unknown area', [{ path: ['geographicUnitId'], message: 'Not found' }]);
        }
        const scope = this.permissions.scopeFor(auth, 'field.readiness.update', cycle.id);
        const where = Prisma.sql`${expectedStationSql(registry.id)} AND ${scopeSql(scope, cycle.id, STATION_COLS('ps'))} AND ${unitSql(dto.geographicUnitId, STATION_COLS('ps'))}`;
        const [{ n: inScope }] = (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM polling_stations ps WHERE ${where}`) as [{ n: bigint }];
        const created = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO readiness_checklists (id, tenant_id, election_cycle_id, polling_station_code, county_id, constituency_id, ward_id, polling_centre_id, status, created_at, updated_at)
          SELECT gen_random_uuid(), ${auth.tenantId}::uuid, ${cycle.id}::uuid, ps.code, ps.county_id, ps.constituency_id, ps.ward_id, ps.polling_centre_id, 'NOT_STARTED', now(), now()
          FROM polling_stations ps WHERE ${where}
          ON CONFLICT (tenant_id, election_cycle_id, polling_station_code) DO NOTHING
          RETURNING id`;
        const categories = [...new Set(dto.categories)];
        if (created.length > 0) {
          await tx.$executeRaw`
            INSERT INTO readiness_items (id, tenant_id, checklist_id, category, status, version, created_at, updated_at)
            SELECT gen_random_uuid(), ${auth.tenantId}::uuid, c.id, cat::"ReadinessCategory", 'NOT_STARTED', 1, now(), now()
            FROM unnest(${created.map((c) => c.id)}::uuid[]) AS c(id) CROSS JOIN unnest(${categories}::text[]) AS cat`;
        }
        const result = { created: created.length, existing: Number(inScope) - created.length };
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.READINESS_GENERATED,
            entityType: FIELD_ENTITY.READINESS_CHECKLIST,
            entityId: cycle.id,
            after: { electionCycleId: cycle.id, geographicUnitId: dto.geographicUnitId, categories, ...result },
          },
          tx,
        );
        return result;
      },
      { timeout: 120_000 },
    );
  }

  updateItem(auth: AuthContext, id: string, itemId: string, dto: UpdateReadinessItem): Promise<ReadinessChecklist> {
    return this.prisma.tenantTx(async (tx) => {
      // Lock the checklist row first: concurrent updates of different items of one checklist
      // are serialised, so the recomputed checklist status always sees every item's latest status.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM readiness_checklists WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw AppException.notFound('Readiness item not found on this checklist');
      const item = await tx.readinessItem.findUnique({ where: { id: itemId } });
      if (!item || item.checklistId !== id) throw AppException.notFound('Readiness item not found on this checklist');
      if (item.version !== dto.expectedVersion) throw serverChanged(item.version, await this.detailInTx(tx, id));
      const needsReason = dto.status === 'BLOCKED' || dto.status === 'NOT_APPLICABLE' || (item.status === 'DONE' && dto.status !== 'DONE');
      if (needsReason && !dto.reason) throw AppException.validation('Give a reason for this change', [{ path: ['reason'], message: 'Required' }]);
      const checklist = await tx.readinessChecklist.findUniqueOrThrow({ where: { id }, select: { status: true } });
      const r = await tx.readinessItem.updateMany({
        where: { id: itemId, version: dto.expectedVersion },
        data: {
          status: dto.status,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.dueAt !== undefined ? { dueAt: dto.dueAt ? new Date(dto.dueAt) : null } : {}),
          updatedById: auth.userId,
          version: { increment: 1 },
        },
      });
      if (r.count === 0) throw serverChanged(item.version, await this.detailInTx(tx, id));
      const items = await tx.readinessItem.findMany({ where: { checklistId: id }, select: { status: true } });
      const derived = deriveReadinessStatus(items);
      await tx.readinessChecklist.update({ where: { id }, data: { status: derived } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.READINESS_ITEM_UPDATED,
          entityType: FIELD_ENTITY.READINESS_ITEM,
          entityId: itemId,
          before: { checklistId: id, category: item.category, status: item.status, checklistStatus: checklist.status },
          after: { checklistId: id, category: item.category, status: dto.status, checklistStatus: derived },
          reason: dto.reason ?? null,
        },
        tx,
      );
      return this.detailInTx(tx, id);
    });
  }
}
