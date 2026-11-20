import { Module, type OnModuleInit } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { GeoScopeService } from '../../rbac/geo-scope.service';
import { type GeoLocation, pathToUnitIds } from '../../rbac/scope';
import { CAMPAIGN_GEO_KIND } from './campaign.constants';
import { CampaignCommonModule } from './common/campaign-common.module';
import { CommsModule } from './comms/comms.module';
import { EventsModule } from './events/events.module';
import { FinanceModule } from './finance/finance.module';
import { NotificationCenterModule } from './notifications/notification-center.module';
import { OrgModule } from './org/org.module';
import { CampaignReportsModule } from './reports/reports.module';
import { SecurityModule } from './security/security.module';
import { TasksModule } from './tasks/tasks.module';

/**
 * Campaign and organisational operations (blueprint 5, 10, 15.3, 15.4;
 * docs/API_CONTRACT.md §23–30).
 *
 * - Tenant module `campaign` must be enabled for org/, tasks/, events/,
 *   comms/ and finance/ (`@RequireModule('campaign')`). The report builder,
 *   notification centre and breach register are platform features: report
 *   datasets each name their own module.
 * - Campaign records follow the department scope (common/campaign-scope.ts);
 *   finance is organisation-level behind its own `finance.*` permissions.
 * - Every state change writes an audit event in the same tenant transaction;
 *   histories are append-only, approved ledger entries immutable (DB triggers).
 *
 * Sub-modules are owned by separate agents (docs/ARCHITECTURE.md §1):
 * org/ + tasks/ + events/; finance/ + comms/; reports/ + notifications/ +
 * security/. Shared helpers live in common/, campaign.dto.ts and
 * campaign.constants.ts.
 */
@Module({
  imports: [
    CampaignCommonModule,
    OrgModule,
    TasksModule,
    EventsModule,
    CommsModule,
    FinanceModule,
    CampaignReportsModule,
    NotificationCenterModule,
    SecurityModule,
  ],
})
export class CampaignModule implements OnModuleInit {
  constructor(private readonly geo: GeoScopeService) {}

  onModuleInit(): void {
    const unitLocation = async (tx: TenantTx, unitId: string | null): Promise<GeoLocation> => {
      if (!unitId) return { unitIds: [], stationId: null };
      const unit = await tx.geographicUnit.findUnique({ where: { id: unitId }, select: { path: true } });
      return { unitIds: unit ? pathToUnitIds(unit.path) : [], stationId: null };
    };
    this.geo.register(CAMPAIGN_GEO_KIND.TEAM, async (tx, id) => {
      const row = await tx.team.findUnique({ where: { id }, select: { geographicUnitId: true } });
      return row ? unitLocation(tx, row.geographicUnitId) : null;
    });
    this.geo.register(CAMPAIGN_GEO_KIND.TASK, async (tx, id) => {
      const row = await tx.task.findUnique({ where: { id }, select: { geographicUnitId: true } });
      return row ? unitLocation(tx, row.geographicUnitId) : null;
    });
    this.geo.register(CAMPAIGN_GEO_KIND.EVENT, async (tx, id) => {
      const row = await tx.campaignEvent.findUnique({ where: { id }, select: { geographicUnitId: true } });
      return row ? unitLocation(tx, row.geographicUnitId) : null;
    });
  }
}
