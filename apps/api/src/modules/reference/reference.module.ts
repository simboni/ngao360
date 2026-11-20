import { Module } from '@nestjs/common';

/**
 * REFERENCE module (owned by the reference module agent; edit only within
 * apps/api/src/modules/reference/).
 *
 * Scope: election cycles, geography (county/constituency/ward/centre), registry
 * versions + CSV import, polling stations, tally centres, contests, candidate
 * references, form-template registry. Endpoints: docs/API_CONTRACT.md §4.
 *
 * Use: PrismaService.tenantTx(), AuditService.record(…, tx), @RequirePermission,
 * PermissionService.scopeFor() for list filtering, DTOs from @ngao360/shared.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class ReferenceModule {}
