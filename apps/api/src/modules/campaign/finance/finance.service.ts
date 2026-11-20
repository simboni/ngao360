import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

/**
 * Ledger in integer minor units. Maker-checker: requester ≠ approver ≠ payer (financeSodViolation, DB checks);
 * approval needs category, counterparty, reference and a document (financeApprovalBlockers, DB trigger);
 * approved entries are immutable and corrected by REVERSAL entries. Compliance findings come from
 * evaluateContribution / evaluateExpense against the tenant's FinanceLimitSetting rows (never hardcoded).
 */
@Injectable()
export class FinanceService {
  constructor(
    readonly prisma: PrismaService,
    readonly audit: AuditService,
    readonly permissions: PermissionService,
    readonly modules: TenantModulesService,
  ) {}
}
