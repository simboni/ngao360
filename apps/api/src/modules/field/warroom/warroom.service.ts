import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type Completeness,
  type DeploymentStatus,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type IncidentSeverity,
  OPERATIONAL_STATUSES,
  type OperationalStatus,
  type SetStationStatus,
  type StationStatusDetail,
  type StationStatusList,
  type StationStatusQuery,
  type StationStatusRow,
  WAR_ROOM_LABEL,
  type WarRoomOverview,
  type WarRoomQuery,
  completeness,
  deriveStationStatus,
} from '@ngao360/shared';
import { Redis } from 'ioredis';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import type { PermissionScope } from '../../../rbac/scope';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { HOLDING_CASE_TYPES, OPEN_CASE_STATUSES } from '../../tally/tally.constants';
import { resolveFieldCycle } from '../common/field-cycle';
import { loadFieldLocations } from '../common/field-location';
import { FIELD_COLS, STATION_COLS, areaFilterSql, expectedStationSql, scopeSql, unitSql, withHashJoins } from '../common/field-sql';
import { USER_REF, asArray, paging, pollsClosed } from '../common/field-support';
import { FIELD_ENTITY } from '../field.constants';

type FormStatus = NonNullable<StationStatusRow['formStatus']>;
const SEVERITY_BY_RANK: Record<number, IncidentSeverity> = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' };
const DEPLOYMENT_BY_RANK: Record<number, DeploymentStatus> = { 1: 'ASSIGNED', 2: 'CONFIRMED', 3: 'CHECKED_OUT', 4: 'CHECKED_IN' };
const ATTENTION: OperationalStatus[] = ['FLAGGED', 'NOT_ASSIGNED', 'FORM_EXPECTED'];

/** Per-station components read in one set-based query (one row per approved-registry station in scope). */
interface RawStation {
  code: string;
  county_id: string;
  constituency_id: string;
  ward_id: string;
  polling_centre_id: string | null;
  dep_rank: number | null;
  last_check_in: Date | null;
  last_report: Date | null;
  open_incidents: number | null;
  max_open_sev: number | null;
  form_flagged: boolean | null;
  form_verified: boolean | null;
  form_pending: boolean | null;
  form_received: boolean | null;
  manual_status: 'FLAGGED' | 'CLOSED' | null;
  manual_note: string | null;
  ss_updated_at: Date | null;
}

export interface StationState {
  code: string;
  cols: { electionCycleId: string; pollingStationCode: string; countyId: string; constituencyId: string; wardId: string; pollingCentreId: string | null };
  deploymentStatus: DeploymentStatus | null;
  lastCheckInAt: Date | null;
  lastFieldReportAt: Date | null;
  openIncidents: number;
  highestOpenSeverity: IncidentSeverity | null;
  formStatus: FormStatus;
  manual: 'FLAGGED' | 'CLOSED' | null;
  manualNote: string | null;
  derived: OperationalStatus;
  status: OperationalStatus;
  /** Any field or tally update (check-in, field report or form received): the station has reported. */
  hasUpdate: boolean;
  updatedAt: Date | null;
}

interface Snapshot {
  at: Date;
  stations: StationState[];
  deployments: { assigned: number; confirmed: number; checkedIn: number; trainedAgents: number };
}

/**
 * S16 War Room (blueprint 7). Station status (7.2 taxonomy) is derived at read
 * time from deployments, field reports, open HIGH/CRITICAL incidents and tally
 * intake matched by station code, combined with a manual override. All figures
 * are labelled unofficial / internal and carry completeness; a station with no
 * update is counted as missing, never as zero. Per-station components are read
 * with one set-based query (about 55k stations in 2027) and cached briefly per
 * tenant, cycle and scope (`asOf` says when they were computed).
 */
@Injectable()
export class WarRoomService {
  private readonly logger = new Logger(WarRoomService.name);
  private readonly cache = new Map<string, Snapshot>();
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly config: AppConfig,
  ) {
    const s = Number(process.env.FIELD_WARROOM_CACHE_SECONDS ?? 15);
    this.ttlMs = Number.isFinite(s) && s >= 0 ? s * 1000 : 15_000;
  }

  /* ------------------------------ station states ----------------------------- */

  private scopeKey(scope: PermissionScope): string {
    return JSON.stringify([scope.orgWide, [...scope.unitIds].sort(), [...scope.stationKeys].sort()]);
  }

  private async approvedRegistry(tx: TenantTx, cycleId: string) {
    return tx.registryVersion.findFirst({ where: { electionCycleId: cycleId, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' }, select: { id: true, version: true } });
  }

  private stationWhere(registryId: string, scope: PermissionScope, cycleId: string, filter: { unitId?: string | null; area?: { countyId?: string; constituencyId?: string; wardId?: string }; code?: string }): Prisma.Sql {
    const cols = STATION_COLS('ps');
    return Prisma.sql`${expectedStationSql(registryId)} AND ${scopeSql(scope, cycleId, cols)} AND ${unitSql(filter.unitId, cols)} AND ${areaFilterSql(filter.area ?? {}, cols)}
      ${filter.code ? Prisma.sql`AND ps.code = ${filter.code}` : Prisma.empty}`;
  }

  private async readStations(tx: TenantTx, cycle: { id: string; electionDate: Date }, where: Prisma.Sql): Promise<StationState[]> {
    const c = cycle.id;
    const raw = await tx.$queryRaw<RawStation[]>`
      WITH st AS (
        SELECT ps.code, ps.county_id, ps.constituency_id, ps.ward_id, ps.polling_centre_id FROM polling_stations ps WHERE ${where}
      ),
      dep AS (
        SELECT d.polling_station_code AS code,
          max(CASE d.status WHEN 'CHECKED_IN' THEN 4 WHEN 'CHECKED_OUT' THEN 3 WHEN 'CONFIRMED' THEN 2 WHEN 'ASSIGNED' THEN 1 ELSE 0 END) AS rank,
          max(d.checked_in_at) AS last_check_in
        FROM deployments d
        WHERE d.election_cycle_id = ${c}::uuid AND d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN','CHECKED_OUT') AND d.polling_station_code IN (SELECT code FROM st)
        GROUP BY d.polling_station_code
      ),
      rep AS (
        SELECT fr.polling_station_code AS code, max(fr.received_at) AS last_report FROM field_reports fr
        WHERE fr.election_cycle_id = ${c}::uuid AND fr.polling_station_code IN (SELECT code FROM st)
        GROUP BY fr.polling_station_code
      ),
      inc AS (
        SELECT i.polling_station_code AS code, count(*)::int AS open,
          max(CASE i.severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END) AS max_sev
        FROM incidents i
        WHERE i.election_cycle_id = ${c}::uuid AND i.status <> 'CLOSED' AND i.polling_station_code IN (SELECT code FROM st)
        GROUP BY i.polling_station_code
      ),
      frm AS (
        SELECT ps2.code,
          bool_or(rs.status IN ('DISPUTED','QUARANTINED') OR EXISTS (
            SELECT 1 FROM discrepancy_case_submissions dcs JOIN discrepancy_cases dc ON dc.id = dcs.case_id
            WHERE dcs.submission_id = rs.id AND dc.status::text = ANY(${[...OPEN_CASE_STATUSES]}::text[]) AND dc.variance_type::text = ANY(${[...HOLDING_CASE_TYPES]}::text[])
          )) AS flagged,
          bool_or(rs.status = 'VERIFIED' AND rs.is_canonical) AS verified,
          bool_or(rs.status IN ('DATA_ENTRY_REVIEWED','SECOND_REVIEW_PENDING')) AS pending,
          bool_or(true) AS received
        FROM result_submissions rs
        JOIN polling_stations ps2 ON ps2.id = rs.polling_station_id
        JOIN form_templates ft ON ft.id = rs.form_template_id AND ft.form_level = 'POLLING_STATION'
        WHERE rs.election_cycle_id = ${c}::uuid AND ps2.election_cycle_id = ${c}::uuid AND rs.status NOT IN ('DRAFT','ARCHIVED') AND ps2.code IN (SELECT code FROM st)
        GROUP BY ps2.code
      )
      SELECT st.code, st.county_id, st.constituency_id, st.ward_id, st.polling_centre_id,
        dep.rank AS dep_rank, dep.last_check_in, rep.last_report, inc.open AS open_incidents, inc.max_sev AS max_open_sev,
        frm.flagged AS form_flagged, frm.verified AS form_verified, frm.pending AS form_pending, frm.received AS form_received,
        ss.manual_status::text AS manual_status, ss.manual_note, ss.updated_at AS ss_updated_at
      FROM st
      LEFT JOIN dep ON dep.code = st.code
      LEFT JOIN rep ON rep.code = st.code
      LEFT JOIN inc ON inc.code = st.code
      LEFT JOIN frm ON frm.code = st.code
      LEFT JOIN station_statuses ss ON ss.election_cycle_id = ${c}::uuid AND ss.polling_station_code = st.code
      ORDER BY st.code`;
    const closed = pollsClosed(cycle.electionDate);
    return raw.map((r) => {
      const formStatus: FormStatus = r.form_flagged ? 'FLAGGED' : r.form_verified ? 'VERIFIED' : r.form_pending ? 'VERIFICATION_PENDING' : r.form_received ? 'RECEIVED' : 'NONE';
      const depRank = Number(r.dep_rank ?? 0);
      const sevRank = Number(r.max_open_sev ?? 0);
      const deploymentStatus = DEPLOYMENT_BY_RANK[depRank] ?? null;
      const input = {
        manual: null,
        deploymentStatus,
        hasFieldUpdate: !!r.last_report,
        formStatus,
        openSevereIncident: sevRank >= 3,
        pollsClosed: closed,
      };
      const derived = deriveStationStatus(input);
      const manual = r.manual_status;
      return {
        code: r.code,
        cols: { electionCycleId: c, pollingStationCode: r.code, countyId: r.county_id, constituencyId: r.constituency_id, wardId: r.ward_id, pollingCentreId: r.polling_centre_id },
        deploymentStatus,
        lastCheckInAt: r.last_check_in,
        lastFieldReportAt: r.last_report,
        openIncidents: Number(r.open_incidents ?? 0),
        highestOpenSeverity: SEVERITY_BY_RANK[sevRank] ?? null,
        formStatus,
        manual,
        manualNote: r.manual_note,
        derived,
        status: manual ?? derived,
        hasUpdate: !!r.last_check_in || !!r.last_report || formStatus !== 'NONE',
        updatedAt: r.ss_updated_at,
      };
    });
  }

  private async readDeploymentTotals(tx: TenantTx, cycleId: string, where: Prisma.Sql): Promise<Snapshot['deployments']> {
    const [row] = await tx.$queryRaw<Array<{ assigned: bigint; confirmed: bigint; checked_in: bigint; trained: bigint }>>`
      SELECT
        count(*) FILTER (WHERE d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN')) AS assigned,
        count(*) FILTER (WHERE d.status IN ('CONFIRMED','CHECKED_IN')) AS confirmed,
        count(*) FILTER (WHERE d.status = 'CHECKED_IN') AS checked_in,
        count(DISTINCT d.agent_id) FILTER (WHERE d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN') AND EXISTS (
          SELECT 1 FROM agent_trainings t WHERE t.agent_id = d.agent_id AND t.status = 'COMPLETED' AND (t.election_cycle_id IS NULL OR t.election_cycle_id = ${cycleId}::uuid))) AS trained
      FROM deployments d
      WHERE d.election_cycle_id = ${cycleId}::uuid AND d.polling_station_code IN (SELECT ps.code FROM polling_stations ps WHERE ${where})`;
    return { assigned: Number(row!.assigned), confirmed: Number(row!.confirmed), checkedIn: Number(row!.checked_in), trainedAgents: Number(row!.trained) };
  }

  /** Station states for a scope and filter, from the short-lived cache when fresh. */
  private async snapshot(
    tx: TenantTx,
    auth: AuthContext,
    cycle: { id: string; electionDate: Date },
    registryId: string,
    scope: PermissionScope,
    filter: { unitId?: string | null; area?: { countyId?: string; constituencyId?: string; wardId?: string } },
  ): Promise<Snapshot> {
    const key = [auth.tenantId, cycle.id, registryId, this.scopeKey(scope), filter.unitId ?? '', filter.area?.countyId ?? '', filter.area?.constituencyId ?? '', filter.area?.wardId ?? ''].join('|');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at.getTime() < this.ttlMs) return hit;
    const where = this.stationWhere(registryId, scope, cycle.id, filter);
    const at = new Date();
    const { stations, deployments } = await withHashJoins(tx, async () => ({
      stations: await this.readStations(tx, cycle, where),
      deployments: await this.readDeploymentTotals(tx, cycle.id, where),
    }));
    const snap = { at, stations, deployments };
    if (this.ttlMs > 0) {
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, snap);
    }
    return snap;
  }

  private invalidate(tenantId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}|`)) this.cache.delete(k);
  }

  private reportedCompleteness(stations: StationState[]): Completeness {
    return completeness(stations.length, stations.filter((s) => s.hasUpdate).length);
  }

  /**
   * Record observed derived-status changes for the stations a read returned:
   * station_statuses.derived_status plus an append-only DERIVED event. Runs in
   * its own transaction and never fails the read.
   */
  private async recordDerived(auth: AuthContext, states: StationState[]): Promise<void> {
    if (states.length === 0) return;
    try {
      await this.prisma.withTenant(auth.tenantId, async (tx) => {
        const cycleId = states[0]!.cols.electionCycleId;
        const stored = await tx.stationStatus.findMany({
          where: { electionCycleId: cycleId, pollingStationCode: { in: states.map((s) => s.code) } },
          select: { id: true, pollingStationCode: true, derivedStatus: true, manualStatus: true },
        });
        const byCode = new Map(stored.map((s) => [s.pollingStationCode, s]));
        for (const s of states) {
          const row = byCode.get(s.code);
          const components = {
            deploymentStatus: s.deploymentStatus,
            hasFieldUpdate: !!s.lastFieldReportAt,
            formStatus: s.formStatus,
            openIncidents: s.openIncidents,
            highestOpenSeverity: s.highestOpenSeverity,
          };
          if (!row) {
            if (s.derived === 'NOT_ASSIGNED') continue;
            const created = await tx.stationStatus.upsert({
              where: { tenantId_electionCycleId_pollingStationCode: { tenantId: auth.tenantId, electionCycleId: cycleId, pollingStationCode: s.code } },
              create: {
                tenantId: auth.tenantId,
                electionCycleId: cycleId,
                pollingStationCode: s.code,
                countyId: s.cols.countyId,
                constituencyId: s.cols.constituencyId,
                wardId: s.cols.wardId,
                pollingCentreId: s.cols.pollingCentreId,
                status: s.derived,
                source: 'DERIVED',
                derivedStatus: s.derived,
                components,
              },
              update: {},
              select: { id: true },
            });
            await tx.stationStatusEvent.create({ data: { tenantId: auth.tenantId, stationStatusId: created.id, fromStatus: 'NOT_ASSIGNED', toStatus: s.derived, source: 'DERIVED' } });
          } else if (row.derivedStatus !== s.derived) {
            const updated = await tx.stationStatus.updateMany({
              where: { id: row.id, derivedStatus: row.derivedStatus },
              data: { derivedStatus: s.derived, status: row.manualStatus ?? s.derived, components, computedAt: new Date() },
            });
            if (updated.count > 0) {
              await tx.stationStatusEvent.create({ data: { tenantId: auth.tenantId, stationStatusId: row.id, fromStatus: row.derivedStatus, toStatus: s.derived, source: 'DERIVED' } });
            }
          }
        }
      });
    } catch (e) {
      this.logger.warn(`Could not record derived station status: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async toRows(tx: TenantTx, auth: AuthContext, states: StationState[], asOf: Date): Promise<StationStatusRow[]> {
    const locations = await loadFieldLocations(tx, states.map((s) => s.cols));
    const tallyVisible = auth.permissions.has('tally.view');
    return states.map((s, i) => ({
      location: locations[i]!,
      status: s.status,
      source: s.manual ? 'MANUAL' : 'DERIVED',
      deploymentStatus: s.deploymentStatus,
      lastCheckInAt: s.lastCheckInAt ? s.lastCheckInAt.toISOString() : null,
      lastFieldReportAt: s.lastFieldReportAt ? s.lastFieldReportAt.toISOString() : null,
      openIncidents: s.openIncidents,
      highestOpenSeverity: s.highestOpenSeverity,
      formStatus: tallyVisible ? s.formStatus : null,
      manualNote: s.manualNote,
      updatedAt: (s.updatedAt ?? asOf).toISOString(),
    }));
  }

  /* --------------------------------- overview -------------------------------- */

  overview(auth: AuthContext, q: WarRoomQuery): Promise<WarRoomOverview> {
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const registry = await this.approvedRegistry(tx, cycle.id);
      const scope = this.permissions.scopeFor(auth, 'warroom.view', cycle.id);
      const snap = registry
        ? await this.snapshot(tx, auth, cycle, registry.id, scope, { unitId: q.geographicUnitId })
        : { at: new Date(), stations: [], deployments: { assigned: 0, confirmed: 0, checkedIn: 0, trainedAgents: 0 } };
      const stations = snap.stations;
      const asOf = snap.at.toISOString();
      const expected = stations.length;
      const reported = this.reportedCompleteness(stations);
      const tallyAvailable = auth.permissions.has('tally.view');
      const panel = <T>(data: T, c: Completeness, available = true) => ({ label: WAR_ROOM_LABEL as typeof WAR_ROOM_LABEL, asOf, completeness: c, available, data });

      const statusCounts = new Map<OperationalStatus, number>();
      for (const s of stations) statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
      const count = (pred: (s: StationState) => boolean) => stations.filter(pred).length;

      // Incidents (counts only) in the War Room scope and area.
      const incWhere = Prisma.sql`i.election_cycle_id = ${cycle.id}::uuid AND ${scopeSql(scope, cycle.id, FIELD_COLS('i'))} AND ${unitSql(q.geographicUnitId, FIELD_COLS('i'))}`;
      const incRows = await tx.$queryRaw<Array<{ status: string; severity: string; category: string; unassigned: boolean; n: bigint; oldest: Date | null }>>`
        SELECT i.status::text AS status, i.severity::text AS severity, i.category::text AS category,
          (i.assignee_id IS NULL AND i.status IN ('REPORTED','TRIAGED','ESCALATED')) AS unassigned,
          count(*) AS n, min(i.reported_at) AS oldest
        FROM incidents i WHERE ${incWhere} GROUP BY 1, 2, 3, 4`;
      const openRows = incRows.filter((r) => r.status !== 'CLOSED');
      const sum = (rows: typeof incRows) => rows.reduce((a, r) => a + Number(r.n), 0);
      const oldest = openRows.reduce<Date | null>((m, r) => (r.oldest && (!m || r.oldest < m) ? r.oldest : m), null);

      // Tally intake (station-level forms, counts only).
      let awaitingCapture = 0;
      let awaitingSecondReview = 0;
      let openDiscrepancies = 0;
      let lastSnapshotAt: Date | null = null;
      if (tallyAvailable && registry) {
        const where = this.stationWhere(registry.id, scope, cycle.id, { unitId: q.geographicUnitId });
        const [t] = await withHashJoins(tx, () => tx.$queryRaw<Array<{ capture: bigint; second: bigint; discrepancies: bigint }>>`
          WITH subs AS (
            SELECT rs.id, rs.status FROM result_submissions rs
            JOIN polling_stations ps2 ON ps2.id = rs.polling_station_id
            JOIN form_templates ft ON ft.id = rs.form_template_id AND ft.form_level = 'POLLING_STATION'
            WHERE rs.election_cycle_id = ${cycle.id}::uuid AND ps2.election_cycle_id = ${cycle.id}::uuid
              AND EXISTS (SELECT 1 FROM polling_stations ps WHERE ps.code = ps2.code AND ${where})
          )
          SELECT
            (SELECT count(*) FROM subs WHERE status IN ('SUBMITTED','OCR_COMPLETE')) AS capture,
            (SELECT count(*) FROM subs WHERE status = 'SECOND_REVIEW_PENDING') AS second,
            (SELECT count(DISTINCT dc.id) FROM discrepancy_cases dc JOIN discrepancy_case_submissions dcs ON dcs.case_id = dc.id
              WHERE dc.status::text = ANY(${[...OPEN_CASE_STATUSES]}::text[]) AND dcs.submission_id IN (SELECT id FROM subs)) AS discrepancies`);
        awaitingCapture = Number(t!.capture);
        awaitingSecondReview = Number(t!.second);
        openDiscrepancies = Number(t!.discrepancies);
        const snapRow = await tx.tallySnapshot.findFirst({ where: { electionCycleId: cycle.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        lastSnapshotAt = snapRow?.createdAt ?? null;
      }

      const since = new Date(Date.now() - 15 * 60_000);
      const [syncItems, syncConflicts] = await Promise.all([
        tx.clientSubmission.count({ where: { lastSeenAt: { gte: since } } }),
        tx.clientSubmission.count({ where: { lastSeenAt: { gte: since }, outcome: 'CONFLICT' } }),
      ]);
      const formsReceived = count((s) => s.formStatus !== 'NONE');
      const verified = count((s) => s.formStatus === 'VERIFIED');
      const tallyZero = { received: 0, awaitingCapture: 0, awaitingSecondReview: 0, verified: 0, flagged: 0 };

      return {
        label: WAR_ROOM_LABEL,
        electionCycleId: cycle.id,
        electionCycleName: cycle.name,
        dataProvenance: cycle.dataProvenance,
        asOf,
        agentOperations: panel(
          {
            assignedSlots: snap.deployments.assigned,
            confirmed: snap.deployments.confirmed,
            checkedIn: snap.deployments.checkedIn,
            stationsNotAssigned: count((s) => s.deploymentStatus === null),
            trainingCompletedAgents: snap.deployments.trainedAgents,
          },
          completeness(expected, count((s) => s.deploymentStatus === 'CHECKED_IN' || s.deploymentStatus === 'CHECKED_OUT')),
        ),
        stationStatus: panel(
          OPERATIONAL_STATUSES.map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
          reported,
        ),
        incidentQueue: panel(
          {
            open: sum(openRows),
            bySeverity: INCIDENT_SEVERITIES.map((severity) => ({ severity, count: sum(openRows.filter((r) => r.severity === severity)) })),
            byStatus: INCIDENT_STATUSES.map((status) => ({ status, count: sum(incRows.filter((r) => r.status === status)) })),
            byCategory: INCIDENT_CATEGORIES.map((category) => ({ category, count: sum(openRows.filter((r) => r.category === category)) })).filter((c) => c.count > 0),
            oldestOpenMinutes: oldest ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 60_000)) : null,
            unassigned: sum(openRows.filter((r) => r.unassigned)),
          },
          reported,
        ),
        formIntake: panel(
          tallyAvailable ? { received: formsReceived, awaitingCapture, awaitingSecondReview, verified, flagged: count((s) => s.formStatus === 'FLAGGED') } : tallyZero,
          tallyAvailable ? completeness(expected, formsReceived) : completeness(expected, 0),
          tallyAvailable,
        ),
        tallyVerification: panel(
          tallyAvailable ? { verifiedStations: verified, openDiscrepancies, lastSnapshotAt: lastSnapshotAt ? lastSnapshotAt.toISOString() : null } : { verifiedStations: 0, openDiscrepancies: 0, lastSnapshotAt: null },
          tallyAvailable ? completeness(expected, verified) : completeness(expected, 0),
          tallyAvailable,
        ),
        systemHealth: panel(
          { apiOk: true, databaseOk: true, queueOk: await this.queueOk(), syncItemsLast15m: syncItems, syncConflictsLast15m: syncConflicts },
          reported,
        ),
      };
    });
  }

  private async queueOk(): Promise<boolean | null> {
    if (!this.config.values.QUEUES_ENABLED) return null;
    const redis = new Redis(this.config.values.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
    try {
      await redis.connect();
      await redis.ping();
      return true;
    } catch {
      return false;
    } finally {
      redis.disconnect();
    }
  }

  /* --------------------------------- stations -------------------------------- */

  stations(auth: AuthContext, q: StationStatusQuery): Promise<StationStatusList> {
    return this.prisma
      .tenantTx(async (tx) => {
        const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
        const registry = await this.approvedRegistry(tx, cycle.id);
        const scope = this.permissions.scopeFor(auth, 'warroom.view', cycle.id);
        const snap = registry
          ? await this.snapshot(tx, auth, cycle, registry.id, scope, { area: { countyId: q.countyId, constituencyId: q.constituencyId, wardId: q.wardId } })
          : { at: new Date(), stations: [] as StationState[] };
        const statuses = asArray(q.status);
        let list = snap.stations;
        if (statuses) list = list.filter((s) => statuses.includes(s.status));
        if (q.attentionOnly) list = list.filter((s) => ATTENTION.includes(s.status) || s.highestOpenSeverity === 'HIGH' || s.highestOpenSeverity === 'CRITICAL');
        if (q.q) {
          const needle = q.q.toLowerCase();
          list = list.filter((s) => s.code.toLowerCase().includes(needle));
        }
        const { skip, take } = paging(q);
        const page = list.slice(skip, skip + take);
        return {
          page,
          result: {
            label: WAR_ROOM_LABEL,
            asOf: snap.at.toISOString(),
            completeness: this.reportedCompleteness(snap.stations),
            items: await this.toRows(tx, auth, page, snap.at),
            page: q.page,
            pageSize: q.pageSize,
            total: list.length,
          } satisfies StationStatusList,
        };
      })
      .then(async ({ page, result }) => {
        await this.recordDerived(auth, page);
        return result;
      });
  }

  /** One station of the approved registry inside the caller's scope for `perm` (404 otherwise). */
  private async stationState(tx: TenantTx, auth: AuthContext, code: string, cycleId: string | undefined, perm: 'warroom.view' | 'warroom.command') {
    const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), cycleId);
    const registry = await this.approvedRegistry(tx, cycle.id);
    if (!registry) throw AppException.notFound('Polling station not found');
    const scope = this.permissions.scopeFor(auth, perm, cycle.id);
    const [state] = await this.readStations(tx, cycle, this.stationWhere(registry.id, scope, cycle.id, { code }));
    if (!state) throw AppException.notFound('Polling station not found');
    return { cycle, state };
  }

  private async detailInTx(tx: TenantTx, auth: AuthContext, state: StationState): Promise<StationStatusDetail> {
    const now = new Date();
    const [row] = await this.toRows(tx, auth, [state], now);
    const ss = await tx.stationStatus.findFirst({ where: { electionCycleId: state.cols.electionCycleId, pollingStationCode: state.code }, select: { id: true } });
    const events = ss
      ? await tx.stationStatusEvent.findMany({ where: { stationStatusId: ss.id }, include: { actor: USER_REF }, orderBy: { createdAt: 'desc' }, take: 200 })
      : [];
    return {
      ...row!,
      label: WAR_ROOM_LABEL,
      events: events.map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, source: e.source, reason: e.reason, actor: e.actor, createdAt: e.createdAt.toISOString() })),
    };
  }

  async station(auth: AuthContext, code: string, cycleId?: string): Promise<StationStatusDetail> {
    const state = await this.prisma.tenantTx(async (tx) => (await this.stationState(tx, auth, code, cycleId, 'warroom.view')).state);
    await this.recordDerived(auth, [state]);
    return this.prisma.tenantTx((tx) => this.detailInTx(tx, auth, state));
  }

  /** Manual FLAGGED / CLOSED with a reason, or `null` to return to the derived status. Internal only. */
  async setStatus(auth: AuthContext, code: string, dto: SetStationStatus): Promise<StationStatusDetail> {
    const result = await this.prisma.tenantTx(async (tx) => {
      const { cycle, state } = await this.stationState(tx, auth, code, dto.electionCycleId, 'warroom.command');
      const current = await tx.stationStatus.findFirst({ where: { electionCycleId: cycle.id, pollingStationCode: code } });
      const before = current?.status ?? state.derived;
      const next: OperationalStatus = dto.status ?? state.derived;
      const data = {
        status: next,
        source: dto.status ? ('MANUAL' as const) : ('DERIVED' as const),
        derivedStatus: state.derived,
        manualStatus: dto.status,
        manualNote: dto.status ? dto.reason : null,
        manualSetById: dto.status ? auth.userId : null,
        computedAt: new Date(),
      };
      const row = await tx.stationStatus.upsert({
        where: { tenantId_electionCycleId_pollingStationCode: { tenantId: auth.tenantId, electionCycleId: cycle.id, pollingStationCode: code } },
        create: {
          tenantId: auth.tenantId,
          electionCycleId: cycle.id,
          pollingStationCode: code,
          countyId: state.cols.countyId,
          constituencyId: state.cols.constituencyId,
          wardId: state.cols.wardId,
          pollingCentreId: state.cols.pollingCentreId,
          ...data,
        },
        update: data,
        select: { id: true },
      });
      await tx.stationStatusEvent.create({ data: { tenantId: auth.tenantId, stationStatusId: row.id, fromStatus: before, toStatus: next, source: 'MANUAL', reason: dto.reason, actorId: auth.userId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.STATION_STATUS_SET,
          entityType: FIELD_ENTITY.STATION_STATUS,
          entityId: row.id,
          before: { pollingStationCode: code, status: before, manualStatus: current?.manualStatus ?? null },
          after: { pollingStationCode: code, status: next, manualStatus: dto.status },
          reason: dto.reason,
        },
        tx,
      );
      const updated: StationState = { ...state, manual: dto.status, manualNote: data.manualNote, status: next, updatedAt: new Date() };
      return this.detailInTx(tx, auth, updated);
    });
    this.invalidate(auth.tenantId);
    return result;
  }
}
