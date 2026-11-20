import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Departments (materialised path, cycle-safe moves), teams and membership history.
 * Every change writes its audit action (AUDIT_ACTIONS.DEPARTMENT_* / TEAM_*) in the same tenant transaction.
 */
@Injectable()
export class OrgService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}
