import { Module, type OnModuleInit } from '@nestjs/common';
import { GeoScopeService } from '../../rbac/geo-scope.service';
import { AgentsModule } from './agents/agents.module';
import { FieldCommonModule } from './common/field-common.module';
import { currentFieldCycleId } from './common/field-cycle';
import { fieldGeoLocation } from './common/field-location';
import { DeploymentModule } from './deployment/deployment.module';
import { FIELD_GEO_KIND } from './field.constants';
import { IncidentsModule } from './incidents/incidents.module';
import { ReadinessModule } from './readiness/readiness.module';
import { ReportsModule } from './reports/reports.module';
import { SyncModule } from './sync/sync.module';
import { WarRoomModule } from './warroom/warroom.module';

/**
 * Field and election operations (blueprint 6, 7, 11.3, 13.4; docs/API_CONTRACT.md §15–22).
 *
 * - Tenant module `field` must be enabled: every controller is tagged
 *   `@RequireModule('field')`; the War Room needs `field` and `tally`.
 * - Records reference polling stations by (election cycle, station code)
 *   (station lineage), never by registry row id.
 * - Every state change writes an audit event in the same tenant transaction;
 *   histories (agent status, deployment, incident, station status) are
 *   append-only and nothing is ever deleted (DB triggers).
 *
 * Sub-modules are owned by separate agents (docs/ARCHITECTURE.md §1):
 * agents/ + deployment/ + readiness/; reports/ + incidents/ + sync/ (and the
 * mobile PWA); warroom/. Shared helpers live in common/ and field.dto.ts.
 */
@Module({
  imports: [FieldCommonModule, AgentsModule, DeploymentModule, ReadinessModule, ReportsModule, IncidentsModule, WarRoomModule, SyncModule],
})
export class FieldModule implements OnModuleInit {
  constructor(private readonly geo: GeoScopeService) {}

  onModuleInit(): void {
    const loc = {
      electionCycleId: true,
      pollingStationCode: true,
      countyId: true,
      constituencyId: true,
      wardId: true,
      pollingCentreId: true,
    } as const;
    this.geo.register(FIELD_GEO_KIND.DEPLOYMENT, async (tx, id) => {
      const row = await tx.deployment.findUnique({ where: { id }, select: loc });
      return row ? fieldGeoLocation(row) : null;
    });
    this.geo.register(FIELD_GEO_KIND.READINESS_CHECKLIST, async (tx, id) => {
      const row = await tx.readinessChecklist.findUnique({ where: { id }, select: loc });
      return row ? fieldGeoLocation(row) : null;
    });
    this.geo.register(FIELD_GEO_KIND.FIELD_REPORT, async (tx, id) => {
      const row = await tx.fieldReport.findUnique({ where: { id }, select: loc });
      return row ? fieldGeoLocation(row) : null;
    });
    this.geo.register(FIELD_GEO_KIND.INCIDENT, async (tx, id) => {
      const row = await tx.incident.findUnique({ where: { id }, select: loc });
      return row ? fieldGeoLocation(row) : null;
    });
    // Agents are not cycle-bound: home area, plus the stations of their active
    // deployments in the current field cycle (an area coordinator sees agents
    // deployed into the area). Deployments of other cycles never widen access.
    this.geo.register(FIELD_GEO_KIND.AGENT, async (tx, id) => {
      const cycleId = await currentFieldCycleId(tx);
      const a = await tx.agent.findUnique({
        where: { id },
        select: {
          homeCountyId: true,
          homeConstituencyId: true,
          homeWardId: true,
          deployments: cycleId
            ? { where: { electionCycleId: cycleId, status: { in: ['ASSIGNED', 'CONFIRMED', 'CHECKED_IN'] } }, select: loc }
            : { where: { id: { in: [] } }, select: loc },
        },
      });
      if (!a) return null;
      const unitIds = new Set<string>([a.homeCountyId, a.homeConstituencyId, a.homeWardId]);
      let stationKey: string | null = null;
      for (const d of a.deployments) {
        const g = fieldGeoLocation(d);
        g.unitIds.forEach((u) => unitIds.add(u));
        stationKey = stationKey ?? g.stationKey ?? null;
      }
      return { unitIds: [...unitIds], stationId: null, stationKey };
    });
    // Personal data (reveal / edit): the agent's home area only, and only grants that
    // apply to every cycle or to the current field cycle (a grant limited to a past
    // cycle or a by-election does not reach personal data).
    this.geo.register(FIELD_GEO_KIND.AGENT_PERSONAL, async (tx, id) => {
      const a = await tx.agent.findUnique({ where: { id }, select: { homeCountyId: true, homeConstituencyId: true, homeWardId: true } });
      if (!a) return null;
      return { unitIds: [a.homeCountyId, a.homeConstituencyId, a.homeWardId], stationId: null, electionCycleId: await currentFieldCycleId(tx) };
    });
  }
}
