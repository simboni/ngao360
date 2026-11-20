import { Module, type OnModuleInit } from '@nestjs/common';
import { GeoScopeService } from '../../rbac/geo-scope.service';
import { AppointmentsModule } from './appointments/appointments.module';
import { CasesModule } from './cases/cases.module';
import { officeGeoLocation } from './common/office-location';
import { CorrespondenceModule } from './correspondence/correspondence.module';
import { OFFICE_GEO_KIND } from './office.constants';
import { ProjectsModule } from './projects/projects.module';
import { OfficePublicModule } from './public/office-public.module';

/**
 * NGAO360 Office (blueprint section 9; docs/API_CONTRACT.md §9–13).
 *
 * - Tenant module `office` must be enabled: every authenticated controller is
 *   tagged `@RequireModule('office')` (ModuleGuard → 403 MODULE_DISABLED).
 * - Office data lives in its own tables behind `office.*` permissions, apart
 *   from campaign and tally data (blueprint 15.2).
 * - Every state change writes an audit event in the same tenant transaction.
 *
 * Sub-modules are owned by separate agents: correspondence/ + appointments/
 * (incl. meetings), cases/ (incl. the public case controller), projects/
 * (incl. institutions and the public project controller). Shared helpers are
 * in common/ and public/ (rate limiter, abuse check, tenant resolution).
 */
@Module({
  imports: [CorrespondenceModule, AppointmentsModule, CasesModule, ProjectsModule, OfficePublicModule],
})
export class OfficeModule implements OnModuleInit {
  constructor(private readonly geo: GeoScopeService) {}

  onModuleInit(): void {
    const select = { countyId: true, constituencyId: true, wardId: true, geographicUnitId: true } as const;
    this.geo.register(OFFICE_GEO_KIND.CASE, async (tx, id) => {
      const row = await tx.citizenCase.findUnique({ where: { id }, select });
      return row ? officeGeoLocation(row) : null;
    });
    this.geo.register(OFFICE_GEO_KIND.PROJECT, async (tx, id) => {
      const row = await tx.project.findUnique({ where: { id }, select });
      return row ? officeGeoLocation(row) : null;
    });
  }
}
