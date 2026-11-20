import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import { AUDIT_ACTIONS } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { resolveFieldCycle } from '../common/field-cycle';
import { expectedStationSql, withHashJoins } from '../common/field-sql';
import { FIELD_ENTITY } from '../field.constants';
import { viewOf, WarRoomService } from './warroom.service';

export interface RecorderRunResult {
  tenantId: string;
  electionCycleId: string;
  changed: number;
}

/**
 * Derived station-status history (blueprint 7.2), recorded by a periodic job
 * instead of by War Room reads:
 *
 * - every FIELD_WARROOM_RECORD_SECONDS (default 60; 0 disables the timer) it
 *   computes the full derived status (tally intake included) of every expected
 *   station of each tenant's field cycle, in one set-based query;
 * - one statement upserts `station_statuses` only where the derived status
 *   changed, and appends a DERIVED `station_status_events` row only for the rows
 *   it actually inserted or changed; a per-tenant, per-cycle advisory lock
 *   serialises concurrent runs (several API instances are harmless);
 * - one SYSTEM audit event per run with changes (count and codes).
 *
 * Event times are therefore "observed at", within one interval of the change,
 * never the time somebody happened to open a page.
 */
@Injectable()
export class StationStatusRecorderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StationStatusRecorderService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly modules: TenantModulesService,
    private readonly warroom: WarRoomService,
  ) {}

  onApplicationBootstrap(): void {
    const s = Number(process.env.FIELD_WARROOM_RECORD_SECONDS ?? 60);
    if (!Number.isFinite(s) || s <= 0) return;
    this.timer = setInterval(() => void this.runSafely(), s * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runAll();
    } catch (err) {
      this.logger.warn(`Station status recording failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass over every active tenant with the field module on. */
  async runAll(): Promise<RecorderRunResult[]> {
    const tenants = await this.prisma.client.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    const out: RecorderRunResult[] = [];
    for (const t of tenants) {
      const r = await this.recordForTenant(t.id);
      if (r) out.push(r);
    }
    return out;
  }

  /** Record derived-status changes for the tenant's field cycle. Null when nothing applies. */
  recordForTenant(tenantId: string): Promise<RecorderRunResult | null> {
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        if (!(await this.modules.isEnabled(tx, 'field'))) return null;
        let cycle: { id: string; electionDate: Date };
        try {
          cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx));
        } catch {
          return null;
        }
        const registry = await tx.registryVersion.findFirst({
          where: { electionCycleId: cycle.id, status: 'APPROVED' },
          orderBy: { approvedAt: 'desc' },
          select: { id: true },
        });
        if (!registry) return null;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`station-status:${tenantId}:${cycle.id}`}, 0))`;
        const stations = await withHashJoins(tx, () =>
          this.warroom.readStations(tx, cycle, expectedStationSql(registry.id)),
        );
        const codes = await this.write(
          tx,
          tenantId,
          cycle.id,
          stations.map((c) => ({ c, v: viewOf(c, true) })),
        );
        if (codes.length > 0) {
          await this.audit.record(
            {
              tenantId,
              actorId: null,
              actorType: 'SYSTEM',
              action: AUDIT_ACTIONS.STATION_STATUS_DERIVED_RECORDED,
              entityType: FIELD_ENTITY.STATION_STATUS,
              entityId: cycle.id,
              after: {
                electionCycleId: cycle.id,
                changed: codes.length,
                pollingStationCodes: codes.slice(0, 500),
              },
            },
            tx,
          );
        }
        return { tenantId, electionCycleId: cycle.id, changed: codes.length };
      },
      { timeout: 120_000 },
    );
  }

  /** One set-based write: upsert changed rows, then events for exactly those rows. Returns the changed codes. */
  private async write(
    tx: TenantTx,
    tenantId: string,
    cycleId: string,
    rows: Array<{
      c: Awaited<ReturnType<WarRoomService['readStations']>>[number];
      v: ReturnType<typeof viewOf>;
    }>,
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    const codes = rows.map((r) => r.c.code);
    const counties = rows.map((r) => r.c.cols.countyId);
    const constituencies = rows.map((r) => r.c.cols.constituencyId);
    const wards = rows.map((r) => r.c.cols.wardId);
    const centres = rows.map((r) => r.c.cols.pollingCentreId ?? '');
    const derived = rows.map((r) => r.v.derived);
    const components = rows.map((r) =>
      JSON.stringify({
        deploymentStatus: r.c.deploymentStatus,
        hasFieldUpdate: !!r.c.lastFieldReportAt,
        formStatus: r.c.formStatus,
        openIncidents: r.c.openIncidents,
        highestOpenSeverity: r.c.highestOpenSeverity,
      }),
    );
    const changed = await tx.$queryRaw<Array<{ code: string }>>`
      WITH incoming AS (
        SELECT u.code, u.county_id::uuid AS county_id, u.constituency_id::uuid AS constituency_id, u.ward_id::uuid AS ward_id,
          NULLIF(u.polling_centre_id, '')::uuid AS polling_centre_id, u.derived, u.components
        FROM unnest(${codes}::text[], ${counties}::text[], ${constituencies}::text[], ${wards}::text[], ${centres}::text[], ${derived}::text[], ${components}::text[])
          AS u(code, county_id, constituency_id, ward_id, polling_centre_id, derived, components)
      ),
      prev AS (
        SELECT ss.polling_station_code AS code, ss.derived_status::text AS derived
        FROM station_statuses ss WHERE ss.election_cycle_id = ${cycleId}::uuid
      ),
      todo AS (
        SELECT i.* , p.derived AS prev_derived FROM incoming i LEFT JOIN prev p ON p.code = i.code
        WHERE (p.code IS NULL AND i.derived <> 'NOT_ASSIGNED') OR (p.code IS NOT NULL AND p.derived <> i.derived)
      ),
      up AS (
        INSERT INTO station_statuses (id, tenant_id, election_cycle_id, polling_station_code, county_id, constituency_id, ward_id, polling_centre_id,
          status, source, derived_status, components, computed_at, created_at, updated_at)
        SELECT gen_random_uuid(), ${tenantId}::uuid, ${cycleId}::uuid, t.code, t.county_id, t.constituency_id, t.ward_id, t.polling_centre_id,
          t.derived::"OperationalStatus", 'DERIVED', t.derived::"OperationalStatus", t.components::jsonb, now(), now(), now()
        FROM todo t
        ON CONFLICT (tenant_id, election_cycle_id, polling_station_code) DO UPDATE
          SET derived_status = EXCLUDED.derived_status,
              status = COALESCE(station_statuses.manual_status, EXCLUDED.derived_status),
              components = EXCLUDED.components,
              computed_at = now(),
              updated_at = now()
          WHERE station_statuses.derived_status IS DISTINCT FROM EXCLUDED.derived_status
        RETURNING id, polling_station_code
      ),
      ev AS (
        INSERT INTO station_status_events (id, tenant_id, station_status_id, from_status, to_status, source, created_at)
        SELECT gen_random_uuid(), ${tenantId}::uuid, up.id, COALESCE(t.prev_derived, 'NOT_ASSIGNED')::"OperationalStatus", t.derived::"OperationalStatus", 'DERIVED', now()
        FROM up JOIN todo t ON t.code = up.polling_station_code
        RETURNING station_status_id
      )
      SELECT up.polling_station_code AS code FROM up WHERE EXISTS (SELECT 1 FROM ev WHERE ev.station_status_id = up.id) ORDER BY 1`;
    return changed.map((r) => r.code);
  }
}
