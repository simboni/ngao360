import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Runs ReportDefinitions only against REPORT_DATASETS: validateReportDefinition for fields and permissions,
 * tenancy by RLS (tenantTx), scope in the query (organisation / geography / department_geography),
 * exportRequirements for the elevated permission + re-auth, and every export logged in report_exports
 * and audited (REPORT_EXPORTED). Tally datasets carry PARALLEL_TALLY_DISCLAIMER.
 */
@Injectable()
export class ReportBuilderService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}
