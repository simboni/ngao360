import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS, type CreateTallyCentre, type Paginated, type TallyCentre, type TallyCentreLevel } from '@ngao360/shared';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import type { TallyCentreQuerySchema } from './reference.dto';
import { contains, pageArgs, sortArgs, toTallyCentre } from './reference.common';
import { TALLY_CENTRE_UNIT_TYPE } from '@ngao360/shared';

type TallyCentreQuery = z.infer<typeof TallyCentreQuerySchema>;

@Injectable()
export class TallyCentresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(q: TallyCentreQuery): Promise<Paginated<TallyCentre>> {
    return this.prisma.tenantTx(async (tx) => {
      const where = {
        electionCycleId: q.electionCycleId,
        ...(q.level ? { level: q.level } : {}),
        ...(q.q ? { name: contains(q.q) } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.tallyCentre.findMany({ where, ...pageArgs(q), orderBy: sortArgs(q, ['code', 'name', 'level', 'createdAt'], 'code') }),
        tx.tallyCentre.count({ where }),
      ]);
      return { items: rows.map(toTallyCentre), page: q.page, pageSize: q.pageSize, total };
    });
  }

  /** Constituency/county centres sit on a unit of that type in the same cycle; the national centre has none. */
  private async checkLevelUnit(tx: TenantTx, electionCycleId: string, level: TallyCentreLevel, geographicUnitId: string | null) {
    const expected = TALLY_CENTRE_UNIT_TYPE[level];
    if (expected === null) {
      if (geographicUnitId) throw AppException.validation('The national tallying centre has no geographic unit', [{ path: 'geographicUnitId', message: 'Must be null' }]);
      return;
    }
    if (!geographicUnitId) {
      throw AppException.validation(`A ${level.toLowerCase()} tallying centre needs its ${expected.toLowerCase()}`, [{ path: 'geographicUnitId', message: 'Required' }]);
    }
    const unit = await tx.geographicUnit.findUnique({ where: { id: geographicUnitId }, select: { type: true, electionCycleId: true } });
    if (!unit || unit.electionCycleId !== electionCycleId) {
      throw AppException.validation('Geographic unit not found in this election cycle', [{ path: 'geographicUnitId', message: 'Not found' }]);
    }
    if (unit.type !== expected) {
      throw AppException.validation(`Expected a ${expected.toLowerCase()}, got a ${unit.type.toLowerCase()}`, [{ path: 'geographicUnitId', message: `Expected ${expected}` }]);
    }
  }

  create(tenantId: string, dto: CreateTallyCentre): Promise<TallyCentre> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await tx.electionCycle.findUnique({ where: { id: dto.electionCycleId }, select: { id: true } });
      if (!cycle) throw AppException.validation('Election cycle not found', [{ path: 'electionCycleId', message: 'Not found' }]);
      await this.checkLevelUnit(tx, dto.electionCycleId, dto.level, dto.geographicUnitId);
      const row = await tx.tallyCentre.create({
        data: { tenantId, electionCycleId: dto.electionCycleId, level: dto.level, geographicUnitId: dto.geographicUnitId, code: dto.code, name: dto.name },
      });
      const out = toTallyCentre(row);
      await this.audit.record({ tenantId, action: AUDIT_ACTIONS.REFERENCE_CREATED, entityType: 'TallyCentre', entityId: row.id, after: out }, tx);
      return out;
    });
  }

  update(tenantId: string, id: string, dto: Partial<CreateTallyCentre>): Promise<TallyCentre> {
    return this.prisma.tenantTx(async (tx) => {
      const current = await tx.tallyCentre.findUnique({ where: { id } });
      if (!current) throw AppException.notFound('Tally centre not found');
      if (dto.electionCycleId && dto.electionCycleId !== current.electionCycleId) {
        throw AppException.validation('A tally centre cannot move to another election cycle', [{ path: 'electionCycleId', message: 'Immutable' }]);
      }
      const level = dto.level ?? current.level;
      const unitId = dto.geographicUnitId !== undefined ? dto.geographicUnitId : current.geographicUnitId;
      if (dto.level !== undefined || dto.geographicUnitId !== undefined) await this.checkLevelUnit(tx, current.electionCycleId, level, unitId);
      const row = await tx.tallyCentre.update({
        where: { id },
        data: {
          level,
          geographicUnitId: unitId,
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
        },
      });
      const out = toTallyCentre(row);
      await this.audit.record(
        { tenantId, action: AUDIT_ACTIONS.REFERENCE_UPDATED, entityType: 'TallyCentre', entityId: id, before: toTallyCentre(current), after: out },
        tx,
      );
      return out;
    });
  }
}
