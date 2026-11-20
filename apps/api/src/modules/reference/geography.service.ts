import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  GEOGRAPHIC_PARENT_TYPE,
  type CreateGeographicUnit,
  type GeographicUnit,
  type GeographicUnitQuery,
  type Paginated,
  type UpdateGeographicUnit,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionService } from '../../rbac/permission.service';
import { type PermissionScope, pathToUnitIds } from '../../rbac/scope';
import { dateOnly, pageArgs, sortArgs, toGeographicUnit } from './reference.common';

const WITH_CHILD_COUNT = { _count: { select: { children: true } } } as const;

/**
 * Prisma filter limiting geographic units to a caller's scope: granted units and
 * their descendants (by materialised path), plus their ancestors so the
 * county → constituency → ward drill-down still has a starting point.
 */
export async function unitScopeWhere(tx: TenantTx, scope: PermissionScope): Promise<Prisma.GeographicUnitWhereInput> {
  if (scope.orgWide) return {};
  const ancestorIds = new Set<string>();
  if (scope.unitIds.length > 0) {
    const granted = await tx.geographicUnit.findMany({ where: { id: { in: scope.unitIds } }, select: { path: true } });
    for (const g of granted) for (const id of pathToUnitIds(g.path)) ancestorIds.add(id);
  }
  if (scope.stationIds.length > 0) {
    const stations = await tx.pollingStation.findMany({
      where: { id: { in: scope.stationIds } },
      select: { countyId: true, constituencyId: true, wardId: true, pollingCentreId: true },
    });
    for (const s of stations) {
      for (const id of [s.countyId, s.constituencyId, s.wardId, s.pollingCentreId]) if (id) ancestorIds.add(id);
    }
  }
  return {
    OR: [
      ...scope.unitIds.map((id) => ({ path: { contains: `/${id}/` } })),
      { id: { in: [...ancestorIds] } },
    ],
  };
}

@Injectable()
export class GeographyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  list(auth: AuthContext, q: GeographicUnitQuery): Promise<Paginated<GeographicUnit>> {
    return this.prisma.tenantTx(async (tx) => {
      const scopeWhere = await unitScopeWhere(tx, this.permissions.scopeFor(auth, 'reference.view'));
      const where: Prisma.GeographicUnitWhereInput = {
        AND: [
          {
            electionCycleId: q.electionCycleId,
            ...(q.type ? { type: q.type } : {}),
            ...(q.parentId ? { parentId: q.parentId } : {}),
            ...(q.q
              ? {
                  OR: [
                    { officialName: { contains: q.q, mode: 'insensitive' } },
                    { officialCode: { contains: q.q, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          scopeWhere,
        ],
      };
      const [rows, total] = await Promise.all([
        tx.geographicUnit.findMany({
          where,
          include: WITH_CHILD_COUNT,
          ...pageArgs(q),
          orderBy: sortArgs(q, ['officialCode', 'officialName', 'type', 'createdAt'], 'officialCode'),
        }),
        tx.geographicUnit.count({ where }),
      ]);
      return { items: rows.map((r) => toGeographicUnit(r, r._count.children)), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<GeographicUnit> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await tx.geographicUnit.findUnique({ where: { id }, include: WITH_CHILD_COUNT });
      if (!row) throw AppException.notFound('Geographic unit not found');
      return toGeographicUnit(row, row._count.children);
    });
  }

  children(id: string): Promise<GeographicUnit[]> {
    return this.prisma.tenantTx(async (tx) => {
      const parent = await tx.geographicUnit.findUnique({ where: { id }, select: { id: true } });
      if (!parent) throw AppException.notFound('Geographic unit not found');
      const rows = await tx.geographicUnit.findMany({
        where: { parentId: id },
        include: WITH_CHILD_COUNT,
        orderBy: [{ officialCode: 'asc' }],
      });
      return rows.map((r) => toGeographicUnit(r, r._count.children));
    });
  }

  create(tenantId: string, dto: CreateGeographicUnit): Promise<GeographicUnit> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { id: true } });
      if (!cycle) throw AppException.validation('Election cycle not found', [{ path: 'electionCycleId', message: 'Not found' }]);
      const expectedParent = GEOGRAPHIC_PARENT_TYPE[dto.type];
      let parentPath = '/';
      if (expectedParent === null) {
        if (dto.parentId) throw AppException.validation('A county has no parent unit', [{ path: 'parentId', message: 'Must be null for a county' }]);
      } else {
        if (!dto.parentId) {
          throw AppException.validation(`A ${dto.type.toLowerCase()} needs a parent ${expectedParent.toLowerCase()}`, [{ path: 'parentId', message: 'Required' }]);
        }
        const parent = await tx.geographicUnit.findUnique({ where: { id: dto.parentId } });
        if (!parent || parent.electionCycleId !== dto.electionCycleId) {
          throw AppException.validation('Parent unit not found in this election cycle', [{ path: 'parentId', message: 'Not found' }]);
        }
        if (parent.type !== expectedParent) {
          throw AppException.validation(`The parent of a ${dto.type.toLowerCase()} must be a ${expectedParent.toLowerCase()}, not a ${parent.type.toLowerCase()}`, [
            { path: 'parentId', message: `Expected ${expectedParent}` },
          ]);
        }
        parentPath = parent.path;
      }
      const id = randomUUID();
      const row = await tx.geographicUnit.create({
        data: {
          id,
          tenantId,
          electionCycleId: dto.electionCycleId,
          type: dto.type,
          parentId: dto.parentId,
          officialCode: dto.officialCode,
          officialName: dto.officialName,
          path: `${parentPath}${id}/`,
          sourceVersion: dto.sourceVersion,
          validFrom: dateOnly(dto.validFrom) ?? null,
          validTo: dateOnly(dto.validTo) ?? null,
        },
      });
      const out = toGeographicUnit(row, 0);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'GeographicUnit', entityId: id, after: out },
        tx,
      );
      return out;
    });
  }

  /** Codes and parents never change; only the name and validity dates. A boundary change is a new sourceVersion. */
  update(tenantId: string, id: string, dto: UpdateGeographicUnit): Promise<GeographicUnit> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.geographicUnit.findUnique({ where: { id }, include: WITH_CHILD_COUNT });
      if (!current) throw AppException.notFound('Geographic unit not found');
      const validFrom = dto.validFrom !== undefined ? dateOnly(dto.validFrom) : current.validFrom;
      const validTo = dto.validTo !== undefined ? dateOnly(dto.validTo) : current.validTo;
      if (validFrom && validTo && validTo < validFrom) {
        throw AppException.validation('Valid-to must be on or after valid-from', [{ path: 'validTo', message: 'Before valid-from' }]);
      }
      const row = await tx.geographicUnit.update({
        where: { id },
        data: {
          ...(dto.officialName !== undefined ? { officialName: dto.officialName } : {}),
          ...(dto.validFrom !== undefined ? { validFrom } : {}),
          ...(dto.validTo !== undefined ? { validTo } : {}),
        },
      });
      const out = toGeographicUnit(row, current._count.children);
      await this.audit.record(
        {
          tenantId,
          action: AUDIT_ACTIONS.REFERENCE_UPDATED,
          entityType: 'GeographicUnit',
          entityId: id,
          before: toGeographicUnit(current, current._count.children),
          after: out,
        },
        tx,
      );
      return out;
    });
  }
}
