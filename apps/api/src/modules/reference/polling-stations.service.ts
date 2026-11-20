import { Injectable } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreatePollingStation,
  type Paginated,
  type PollingStation,
  type PollingStationQuery,
  type UpdatePollingStation,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionService } from '../../rbac/permission.service';
import { pathToUnitIds, stationScopeWhere } from '../../rbac/scope';
import { immutable, pageArgs, sortArgs, STATION_NAME_INCLUDE, toPollingStation } from './reference.common';

/**
 * Derive county / constituency / ward / centre ids from the unit a station is
 * attached to (a ward, or a polling centre under a ward).
 */
async function stationAncestry(tx: TenantTx, geographicUnitId: string, electionCycleId: string) {
  const unit = await tx.geographicUnit.findUnique({ where: { id: geographicUnitId } });
  if (!unit || unit.electionCycleId !== electionCycleId) {
    throw AppException.validation('Geographic unit not found in this election cycle', [{ path: 'geographicUnitId', message: 'Not found' }]);
  }
  if (unit.type !== 'WARD' && unit.type !== 'POLLING_CENTRE') {
    throw AppException.validation('A polling station belongs to a ward or a polling centre', [
      { path: 'geographicUnitId', message: `Expected WARD or POLLING_CENTRE, got ${unit.type}` },
    ]);
  }
  const ids = pathToUnitIds(unit.path);
  const ancestors = await tx.geographicUnit.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } });
  const byType = new Map(ancestors.map((a) => [a.type, a.id]));
  const countyId = byType.get('COUNTY');
  const constituencyId = byType.get('CONSTITUENCY');
  const wardId = byType.get('WARD');
  if (!countyId || !constituencyId || !wardId) {
    throw AppException.validation('The unit is not under a complete county / constituency / ward hierarchy', [
      { path: 'geographicUnitId', message: 'Incomplete hierarchy' },
    ]);
  }
  return { countyId, constituencyId, wardId, pollingCentreId: byType.get('POLLING_CENTRE') ?? null };
}

@Injectable()
export class PollingStationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  list(auth: AuthContext, q: PollingStationQuery): Promise<Paginated<PollingStation>> {
    return this.prisma.tenantTx(async (tx) => {
      // Default to the approved registry version (the coverage denominator) when none is given.
      let registryVersionId = q.registryVersionId;
      if (!registryVersionId) {
        const approved = await tx.registryVersion.findFirst({
          where: { electionCycleId: q.electionCycleId, status: 'APPROVED' },
          orderBy: { approvedAt: 'desc' },
          select: { id: true },
        });
        registryVersionId = approved?.id;
      }
      const scope = stationScopeWhere(this.permissions.scopeFor(auth, 'reference.view'));
      const where: Prisma.PollingStationWhereInput = {
        AND: [
          {
            electionCycleId: q.electionCycleId,
            ...(registryVersionId ? { registryVersionId } : {}),
            ...(q.countyId ? { countyId: q.countyId } : {}),
            ...(q.constituencyId ? { constituencyId: q.constituencyId } : {}),
            ...(q.wardId ? { wardId: q.wardId } : {}),
            ...(q.pollingCentreId ? { pollingCentreId: q.pollingCentreId } : {}),
            ...(q.status ? { status: q.status } : {}),
            ...(q.q
              ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }] }
              : {}),
          },
          scope ?? {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.pollingStation.findMany({
          where,
          include: STATION_NAME_INCLUDE,
          ...pageArgs(q),
          orderBy: sortArgs(q, ['code', 'name', 'registeredVoters', 'status', 'createdAt'], 'code'),
        }),
        tx.pollingStation.count({ where }),
      ]);
      return { items: rows.map(toPollingStation), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<PollingStation> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.pollingStation.findUnique({ where: { id }, include: STATION_NAME_INCLUDE });
      if (!row) throw AppException.notFound('Polling station not found');
      return toPollingStation(row);
    });
  }

  create(tenantId: string, dto: CreatePollingStation): Promise<PollingStation> {
    return this.prisma.tenantTx(async (tx) => {
      const version = await tx.registryVersion.findUnique({ where: { id: dto.registryVersionId } });
      if (!version || version.electionCycleId !== dto.electionCycleId) {
        throw AppException.validation('Registry version not found in this election cycle', [{ path: 'registryVersionId', message: 'Not found' }]);
      }
      if (version.status !== 'DRAFT') {
        throw immutable(`Registry version ${version.version} is ${version.status.toLowerCase()}; add stations to a new draft version`);
      }
      const ancestry = await stationAncestry(tx, dto.geographicUnitId, dto.electionCycleId);
      const row = await tx.pollingStation.create({
        data: {
          tenantId,
          electionCycleId: dto.electionCycleId,
          registryVersionId: dto.registryVersionId,
          geographicUnitId: dto.geographicUnitId,
          ...ancestry,
          code: dto.code,
          name: dto.name,
          streamNumber: dto.streamNumber ?? null,
          registeredVoters: dto.registeredVoters ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          locationSource: dto.locationSource ?? null,
        },
        include: STATION_NAME_INCLUDE,
      });
      await tx.registryVersion.update({ where: { id: version.id }, data: { stationCount: { increment: 1 } } });
      const out = toPollingStation(row);
      await this.audit.record({ tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'PollingStation', entityId: row.id, after: out }, tx);
      return out;
    });
  }

  update(tenantId: string, id: string, dto: UpdatePollingStation): Promise<PollingStation> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.pollingStation.findUnique({ where: { id }, include: { ...STATION_NAME_INCLUDE, registryVersion: true } });
      if (!current) throw AppException.notFound('Polling station not found');
      if (current.registryVersion.status !== 'DRAFT') {
        throw immutable(
          `Registry version ${current.registryVersion.version} is ${current.registryVersion.status.toLowerCase()}; create a new version to change stations`,
        );
      }
      const ancestry =
        dto.geographicUnitId && dto.geographicUnitId !== current.geographicUnitId
          ? await stationAncestry(tx, dto.geographicUnitId, current.electionCycleId)
          : null;
      const row = await tx.pollingStation.update({
        where: { id },
        data: {
          ...(ancestry ? { geographicUnitId: dto.geographicUnitId, ...ancestry } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.streamNumber !== undefined ? { streamNumber: dto.streamNumber } : {}),
          ...(dto.registeredVoters !== undefined ? { registeredVoters: dto.registeredVoters } : {}),
          ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
          ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
          ...(dto.locationSource !== undefined ? { locationSource: dto.locationSource } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
        include: STATION_NAME_INCLUDE,
      });
      const { registryVersion: _rv, ...before } = current;
      const out = toPollingStation(row);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_UPDATED, entityType: 'PollingStation', entityId: id, before: toPollingStation(before), after: out },
        tx,
      );
      return out;
    });
  }
}
