import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateInstitution,
  type Institution,
  type InstitutionQuery,
  type Paginated,
  type UpdateInstitution,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { changedFields, paging } from '../common';

const ENTITY = 'Institution';
type Row = Prisma.InstitutionGetPayload<object>;

/**
 * Institution registry: the bodies legally responsible for projects and the
 * destinations of case referrals (API contract §12.5). Never deleted; an
 * institution is deactivated and stays on existing projects and referrals.
 */
@Injectable()
export class InstitutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(q: InstitutionQuery): Promise<Paginated<Institution>> {
    const and: Prisma.InstitutionWhereInput[] = [{ isActive: q.active ?? true }];
    if (q.type) and.push({ type: q.type });
    if (q.q) and.push({ OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { shortName: { contains: q.q, mode: 'insensitive' } }] });
    const where: Prisma.InstitutionWhereInput = { AND: and };
    return this.prisma.tenantTx(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.institution.findMany({ where, orderBy: [{ name: q.sort === 'name' ? q.order : 'asc' }], ...paging(q) }),
        tx.institution.count({ where }),
      ]);
      return { items: rows.map(toInstitution), page: q.page, pageSize: q.pageSize, total };
    });
  }

  get(id: string): Promise<Institution> {
    return this.prisma.tenantTx(async (tx) => toInstitution(await this.load(tx, id)));
  }

  create(auth: AuthContext, dto: CreateInstitution): Promise<Institution> {
    return this.prisma.tenantTx(async (tx) => {
      if (dto.parentId) await this.load(tx, dto.parentId, 'parentId');
      await this.assertNameFree(tx, dto.name);
      const row = await tx.institution.create({
        data: {
          tenantId: auth.tenantId,
          name: dto.name,
          shortName: dto.shortName ?? null,
          type: dto.type,
          parentId: dto.parentId ?? null,
          contactEmail: dto.contactEmail ?? null,
          contactPhone: dto.contactPhone ?? null,
          physicalAddress: dto.physicalAddress ?? null,
          mandate: dto.mandate ?? null,
        },
      });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INSTITUTION_CREATED, entityType: ENTITY, entityId: row.id, after: { name: row.name, type: row.type, parentId: row.parentId } },
        tx,
      );
      return toInstitution(row);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateInstitution): Promise<Institution> {
    return this.prisma.tenantTx(async (tx) => {
      const row = await this.load(tx, id);
      if (dto.parentId && dto.parentId !== row.parentId) {
        if (dto.parentId === id) throw AppException.validation('An institution cannot be its own parent', [{ path: ['parentId'], message: 'Invalid' }]);
        await this.load(tx, dto.parentId, 'parentId');
      }
      if (dto.name && dto.name !== row.name) await this.assertNameFree(tx, dto.name);
      const diff = changedFields(row as unknown as Record<string, unknown>, dto as Record<string, unknown>);
      if (diff.keys.length === 0) return toInstitution(row);
      const updated = await tx.institution.update({ where: { id }, data: dto });
      await this.audit.record(
        { tenantId: auth.tenantId, action: AUDIT_ACTIONS.INSTITUTION_UPDATED, entityType: ENTITY, entityId: id, before: diff.before, after: diff.after },
        tx,
      );
      return toInstitution(updated);
    });
  }

  private async load(tx: TenantTx, id: string, path?: string): Promise<Row> {
    const row = await tx.institution.findUnique({ where: { id } });
    if (!row) {
      if (path) throw AppException.validation('Unknown institution', [{ path: [path], message: 'Not found' }]);
      throw AppException.notFound('Institution not found');
    }
    return row;
  }

  private async assertNameFree(tx: TenantTx, name: string): Promise<void> {
    const clash = await tx.institution.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (clash) throw AppException.conflict('An institution with this name already exists');
  }
}

export function toInstitution(r: Row): Institution {
  return {
    id: r.id,
    name: r.name,
    shortName: r.shortName,
    type: r.type,
    parentId: r.parentId,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    physicalAddress: r.physicalAddress,
    mandate: r.mandate,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
