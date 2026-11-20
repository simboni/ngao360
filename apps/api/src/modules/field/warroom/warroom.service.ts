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

/**
 * Per-station components, independent of who is looking (cached once per
 * tenant, cycle and registry). The status a caller sees is computed per caller
 * by `viewOf`, because tally-derived states need tally.view over the station.
 */
export interface StationComponents {
  code: string;
  cols: { electionCycleId: string; pollingStationCode: string; countyId: string; constituencyId: string; wardId: string; pollingCentreId: string | null };
  deploymentStatus: DeploymentStatus | null;
  lastCheckInAt: Date | null;
  lastFieldReportAt: Date | null;
  openIncidents: number;
  highestOpenSeverity: IncidentSeverity | null;
  /** Tally intake state of the station's forms (never shown without tally.view over the station). */
  formStatus: FormStatus;
  manual: 'FLAGGED' | 'CLOSED' | null;
  manualNote: string | null;
  pollsClosed: boolean;
  updatedAt: Date | null;
}

/** A station as one caller sees it. */
export interface StationState extends StationComponents {
  /** False when the caller lacks tally.view over the station: forms are ignored and `formStatus` is withheld. */
  tallyVisible: boolean;
  derived: OperationalStatus;
  status: OperationalStatus;
  /** Any field update, or (with tally visibility) a form received: the station has reported. */
  hasUpdate: boolean;
}

type DeploymentTotals = { assigned: number; confirmed: number; checkedIn: number; trainedAgents: number };

interface Snapshot {
  at: Date;
  stations: StationComponents[];
}

/** Status of a station as a caller sees it: tally-derived states only with tally visibility. */
export function viewOf(c: StationComponents, tallyVisible: boolean): StationState {
  const formStatus: FormStatus = tallyVisible ? c.formStatus : 'NONE';
  const derived = deriveStationStatus({
    manual: null,
    deploymentStatus: c.deploymentStatus,
    hasFieldUpdate: !!c.lastFieldReportAt,
    formStatus,
    openSevereIncident: c.highestOpenSeverity === 'HIGH' || c.highestOpenSeverity === 'CRITICAL',
    pollsClosed: c.pollsClosed,
  });
  return {
    ...c,
    tallyVisible,
    derived,
    status: c.manual ?? derived,
    hasUpdate: !!c.lastCheckInAt || !!c.lastFieldReportAt || formStatus !== 'NONE',
  };
}

/** In-memory twin of `scopeSql` (scope flattened for the cycle). */
export function stationInScope(scope: PermissionScope, c: StationComponents['cols']): boolean {
  if (scope.orgWide) return true;
  if (scope.stationKeys.includes(`${c.electionCycleId}:${c.pollingStationCode}`)) return true;
  return [c.countyId, c.constituencyId, c.wardId, c.pollingCentreId].some((u) => !!u && scope.unitIds.includes(u));
}

function inUnit(unitId: string | null | undefined, c: StationComponents['cols']): boolean {
  if (!unitId) return true;
  return c.countyId === unitId || c.constituencyId === unitId || c.wardId === unitId || c.pollingCentreId === unitId;
}

function inArea(area: { countyId?: string; constituencyId?: string; wardId?: string }, c: StationComponents['cols']): boolean {
  return (!area.countyId || c.countyId === area.countyId) && (!area.constituencyId || c.constituencyId === area.constituencyId) && (!area.wardId || c.wardId === area.wardId);
}

/** Operational statuses that can only come from tally intake. */
export const TALLY_STATES: OperationalStatus[] = ['FORM_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED_FOR_PARALLEL_TALLY'];
const SNAPSHOT_CACHE_MAX = 8;
const TOTALS_CACHE_MAX = 500;

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
  /** One org-wide snapshot per tenant, cycle and registry (bounded, expired entries evicted on write). */
  private readonly cache = new Map<string, Snapshot>();
  /** Deployment totals per scope and area (small objects; bounded, expired entries evicted on write). */
  private readonly totalsCache = new Map<string, { at: Date; totals: DeploymentTotals }>();
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

  async readStations(tx: TenantTx, cycle: { id: string; electionDate: Date }, where: Prisma.Sql): Promise<StationComponents[]> {
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
      return {
        code: r.code,
        cols: { electionCycleId: c, pollingStationCode: r.code, countyId: r.county_id, constituencyId: r.constituency_id, wardId: r.ward_id, pollingCentreId: r.polling_centre_id },
        deploymentStatus: DEPLOYMENT_BY_RANK[depRank] ?? null,
        lastCheckInAt: r.last_check_in,
        lastFieldReportAt: r.last_report,
        openIncidents: Number(r.open_incidents ?? 0),
        highestOpenSeverity: SEVERITY_BY_RANK[sevRank] ?? null,
        formStatus,
        manual: r.manual_status,
        manualNote: r.manual_note,
        pollsClosed: closed,
        updatedAt: r.ss_updated_at,
      };
    });
  }

  /**
   * Deployment slot totals. One definition for the figures and the panel's completeness:
   * a CHECKED_OUT slot is still assigned and confirmed, and its agent has checked in.
   */
  private async readDeploymentTotals(tx: TenantTx, cycleId: string, where: Prisma.Sql): Promise<DeploymentTotals> {
    const [row] = await tx.$queryRaw<Array<{ assigned: bigint; confirmed: bigint; checked_in: bigint; trained: bigint }>>`
      SELECT
        count(*) FILTER (WHERE d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN','CHECKED_OUT')) AS assigned,
        count(*) FILTER (WHERE d.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')) AS confirmed,
        count(*) FILTER (WHERE d.status IN ('CHECKED_IN','CHECKED_OUT')) AS checked_in,
        count(DISTINCT d.agent_id) FILTER (WHERE d.status IN ('ASSIGNED','CONFIRMED','CHECKED_IN','CHECKED_OUT') AND EXISTS (
          SELECT 1 FROM agent_trainings t WHERE t.agent_id = d.agent_id AND t.status = 'COMPLETED' AND (t.election_cycle_id IS NULL OR t.election_cycle_id = ${cycleId}::uuid))) AS trained
      FROM deployments d
      WHERE d.election_cycle_id = ${cycleId}::uuid AND d.polling_station_code IN (SELECT ps.code FROM polling_stations ps WHERE ${where})`;
    return { assigned: Number(row!.assigned), confirmed: Number(row!.confirmed), checkedIn: Number(row!.checked_in), trainedAgents: Number(row!.trained) };
  }

  private static evictExpired<V extends { at: Date }>(map: Map<string, V>, ttlMs: number, max: number): void {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at.getTime() >= ttlMs) map.delete(k);
    while (map.size >= max) map.delete(map.keys().next().value as string);
  }

  /**
   * Components of every expected station of the cycle's approved registry, from the
   * short-lived cache when fresh. One snapshot per tenant, cycle and registry is shared
   * by every caller; scope and area filters are applied in memory (`stationInScope`).
   */
  private async snapshot(tx: TenantTx, auth: AuthContext, cycle: { id: string; electionDate: Date }, registryId: string): Promise<Snapshot> {
    const key = [auth.tenantId, cycle.id, registryId].join('|');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at.getTime() < this.ttlMs) {
      // LRU: move to the end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const at = new Date();
    const stations = await withHashJoins(tx, () => this.readStations(tx, cycle, expectedStationSql(registryId)));
    const snap = { at, stations };
    if (this.ttlMs > 0) {
      WarRoomService.evictExpired(this.cache, this.ttlMs, SNAPSHOT_CACHE_MAX);
      this.cache.set(key, snap);
    }
    return snap;
  }

  /** Deployment totals for a scope and area (cached briefly; tiny entries). */
  private async deploymentTotals(tx: TenantTx, auth: AuthContext, cycleId: string, registryId: string, scope: PermissionScope, unitId: string | null | undefined): Promise<DeploymentTotals> {
    const key = [auth.tenantId, cycleId, registryId, this.scopeKey(scope), unitId ?? ''].join('|');
    const hit = this.totalsCache.get(key);
    if (hit && Date.now() - hit.at.getTime() < this.ttlMs) return hit.totals;
    const at = new Date();
    const totals = await withHashJoins(tx, () => this.readDeploymentTotals(tx, cycleId, this.stationWhere(registryId, scope, cycleId, { unitId })));
    if (this.ttlMs > 0) {
      WarRoomService.evictExpired(this.totalsCache, this.ttlMs, TOTALS_CACHE_MAX);
      this.totalsCache.set(key, { at, totals });
    }
    return totals;
  }

  /** Tally scope of the caller for the cycle, or null without tally.view. */
  private tallyScope(auth: AuthContext, cycleId: string): PermissionScope | null {
    return auth.permissions.has('tally.view') ? this.permissions.scopeFor(auth, 'tally.view', cycleId) : null;
  }

  /** The caller's view of the stations in `scope` (and area): status computed per caller. */
  private views(
    stations: StationComponents[],
    scope: PermissionScope,
    tally: PermissionScope | null,
    filter: { unitId?: string | null; area?: { countyId?: string; constituencyId?: string; wardId?: string } },
  ): StationState[] {
    const out: StationState[] = [];
    for (const c of stations) {
      if (!stationInScope(scope, c.cols) || !inUnit(filter.unitId, c.cols) || !inArea(filter.area ?? {}, c.cols)) continue;
      out.push(viewOf(c, !!tally && stationInScope(tally, c.cols)));
    }
    return out;
  }

  private invalidate(tenantId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}|`)) this.cache.delete(k);
    for (const k of this.totalsCache.keys()) if (k.startsWith(`${tenantId}|`)) this.totalsCache.delete(k);
  }

  private reportedCompleteness(stations: StationState[]): Completeness {
    return completeness(stations.length, stations.filter((s) => s.hasUpdate).length);
  }

  private async toRows(tx: TenantTx, auth: AuthContext, states: StationState[], asOf: Date): Promise<StationStatusRow[]> {
    const locations = await loadFieldLocations(tx, states.map((s) => s.cols));
    return states.map((s, i) => ({
      location: locations[i]!,
      status: s.status,
      source: s.manual ? 'MANUAL' : 'DERIVED',
      deploymentStatus: s.deploymentStatus,
      lastCheckInAt: s.lastCheckInAt ? s.lastCheckInAt.toISOString() : null,
      lastFieldReportAt: s.lastFieldReportAt ? s.lastFieldReportAt.toISOString() : null,
      openIncidents: s.openIncidents,
      highestOpenSeverity: s.highestOpenSeverity,
      formStatus: s.tallyVisible ? s.formStatus : null,
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
      const tally = this.tallyScope(auth, cycle.id);
      const snap = registry ? await this.snapshot(tx, auth, cycle, registry.id) : { at: new Date(), stations: [] as StationComponents[] };
      const deployments = registry ? await this.deploymentTotals(tx, auth, cycle.id, registry.id, scope, q.geographicUnitId) : { assigned: 0, confirmed: 0, checkedIn: 0, trainedAgents: 0 };
      const stations = this.views(snap.stations, scope, tally, { unitId: q.geographicUnitId });
      const asOf = snap.at.toISOString();
      const expected = stations.length;
      const reported = this.reportedCompleteness(stations);
      const tallyAvailable = !!tally;
      // Tally panels cover the stations inside both the War Room and the tally.view scope.
      const tallyStations = stations.filter((s) => s.tallyVisible);
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
        const where = Prisma.sql`${this.stationWhere(registry.id, scope, cycle.id, { unitId: q.geographicUnitId })} AND ${scopeSql(tally!, cycle.id, STATION_COLS('ps'))}`;
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
      const formsReceived = tallyStations.filter((s) => s.formStatus !== 'NONE').length;
      const verified = tallyStations.filter((s) => s.formStatus === 'VERIFIED').length;
      const tallyExpected = tallyStations.length;
      const tallyZero = { received: 0, awaitingCapture: 0, awaitingSecondReview: 0, verified: 0, flagged: 0 };

      return {
        label: WAR_ROOM_LABEL,
        electionCycleId: cycle.id,
        electionCycleName: cycle.name,
        dataProvenance: cycle.dataProvenance,
        asOf,
        agentOperations: panel(
          {
            assignedSlots: deployments.assigned,
            confirmed: deployments.confirmed,
            checkedIn: deployments.checkedIn,
            stationsNotAssigned: count((s) => s.deploymentStatus === null),
            trainingCompletedAgents: deployments.trainedAgents,
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
          tallyAvailable ? { received: formsReceived, awaitingCapture, awaitingSecondReview, verified, flagged: tallyStations.filter((s) => s.formStatus === 'FLAGGED').length } : tallyZero,
          tallyAvailable ? completeness(tallyExpected, formsReceived) : completeness(expected, 0),
          tallyAvailable,
        ),
        tallyVerification: panel(
          tallyAvailable ? { verifiedStations: verified, openDiscrepancies, lastSnapshotAt: lastSnapshotAt ? lastSnapshotAt.toISOString() : null } : { verifiedStations: 0, openDiscrepancies: 0, lastSnapshotAt: null },
          tallyAvailable ? completeness(tallyExpected, verified) : completeness(expected, 0),
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
    return this.prisma.tenantTx(async (tx) => {
      const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), q.electionCycleId);
      const registry = await this.approvedRegistry(tx, cycle.id);
      const scope = this.permissions.scopeFor(auth, 'warroom.view', cycle.id);
      const snap = registry ? await this.snapshot(tx, auth, cycle, registry.id) : { at: new Date(), stations: [] as StationComponents[] };
      const all = this.views(snap.stations, scope, this.tallyScope(auth, cycle.id), { area: { countyId: q.countyId, constituencyId: q.constituencyId, wardId: q.wardId } });
      const statuses = asArray(q.status);
      let list = all;
      if (statuses) list = list.filter((s) => statuses.includes(s.status));
      if (q.attentionOnly) list = list.filter((s) => ATTENTION.includes(s.status) || s.highestOpenSeverity === 'HIGH' || s.highestOpenSeverity === 'CRITICAL');
      if (q.q) {
        const needle = q.q.toLowerCase();
        list = list.filter((s) => s.code.toLowerCase().includes(needle));
      }
      const { skip, take } = paging(q);
      const page = list.slice(skip, skip + take);
      return {
        label: WAR_ROOM_LABEL,
        asOf: snap.at.toISOString(),
        completeness: this.reportedCompleteness(all),
        items: await this.toRows(tx, auth, page, snap.at),
        page: q.page,
        pageSize: q.pageSize,
        total: list.length,
      } satisfies StationStatusList;
    });
  }

  /** One station of the approved registry inside the caller's scope for `perm` (404 otherwise). */
  private async stationState(tx: TenantTx, auth: AuthContext, code: string, cycleId: string | undefined, perm: 'warroom.view' | 'warroom.command') {
    const cycle = await resolveFieldCycle(tx, await this.modules.fieldConfig(tx), cycleId);
    const registry = await this.approvedRegistry(tx, cycle.id);
    if (!registry) throw AppException.notFound('Polling station not found');
    const scope = this.permissions.scopeFor(auth, perm, cycle.id);
    const [components] = await this.readStations(tx, cycle, this.stationWhere(registry.id, scope, cycle.id, { code }));
    if (!components) throw AppException.notFound('Polling station not found');
    const tally = this.tallyScope(auth, cycle.id);
    return { cycle, components, state: viewOf(components, !!tally && stationInScope(tally, components.cols)) };
  }

  private async detailInTx(tx: TenantTx, auth: AuthContext, state: StationState): Promise<StationStatusDetail> {
    const now = new Date();
    const [row] = await this.toRows(tx, auth, [state], now);
    const ss = await tx.stationStatus.findFirst({ where: { electionCycleId: state.cols.electionCycleId, pollingStationCode: state.code }, select: { id: true } });
    const all = ss
      ? await tx.stationStatusEvent.findMany({ where: { stationStatusId: ss.id }, include: { actor: USER_REF }, orderBy: { createdAt: 'desc' }, take: 200 })
      : [];
    // Recorded derived statuses include tally intake; without tally visibility over the
    // station, derived events touching a tally-derived state (or FLAGGED, which a form
    // flag can cause) are left out, and so is any event ending in a tally-derived
    // state. Other manual events stay, without a tally-derived "from" status.
    const hidden: OperationalStatus[] = [...TALLY_STATES, 'FLAGGED'];
    const events = state.tallyVisible
      ? all
      : all
          .filter((e) => !TALLY_STATES.includes(e.toStatus) && (e.source !== 'DERIVED' || !(hidden.includes(e.fromStatus as OperationalStatus) || hidden.includes(e.toStatus))))
          .map((e) => (e.fromStatus && TALLY_STATES.includes(e.fromStatus) ? { ...e, fromStatus: null } : e));
    return {
      ...row!,
      label: WAR_ROOM_LABEL,
      events: events.map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, source: e.source, reason: e.reason, actor: e.actor, createdAt: e.createdAt.toISOString() })),
    };
  }

  async station(auth: AuthContext, code: string, cycleId?: string): Promise<StationStatusDetail> {
    return this.prisma.tenantTx(async (tx) => this.detailInTx(tx, auth, (await this.stationState(tx, auth, code, cycleId, 'warroom.view')).state));
  }

  /** Manual FLAGGED / CLOSED with a reason, or `null` to return to the derived status. Internal only. */
  async setStatus(auth: AuthContext, code: string, dto: SetStationStatus): Promise<StationStatusDetail> {
    const result = await this.prisma.tenantTx(async (tx) => {
      const { cycle, components, state } = await this.stationState(tx, auth, code, dto.electionCycleId, 'warroom.command');
      // The stored record keeps the full derived status (tally intake included); the
      // response shows the caller's view.
      const full = viewOf(components, true);
      const current = await tx.stationStatus.findFirst({ where: { electionCycleId: cycle.id, pollingStationCode: code } });
      const before = current?.status ?? full.derived;
      const next: OperationalStatus = dto.status ?? full.derived;
      const data = {
        status: next,
        source: dto.status ? ('MANUAL' as const) : ('DERIVED' as const),
        derivedStatus: full.derived,
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
      const updated: StationState = { ...state, manual: dto.status, manualNote: data.manualNote, status: dto.status ?? state.derived, updatedAt: new Date() };
      return this.detailInTx(tx, auth, updated);
    });
    this.invalidate(auth.tenantId);
    return result;
  }
}
