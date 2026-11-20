import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Versioned FinanceLimitSetting rows: creating, superseding (closes the old row's effective_to) and
 * verifying. Value columns are immutable (DB trigger).
 */
@Injectable()
export class FinanceSettingsService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}
