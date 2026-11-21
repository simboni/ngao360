import { HttpStatus, Injectable } from '@nestjs/common';
import { canonicalJson, nextReference, Prisma, sha256Hex, type TenantTx } from '@ngao360/db';
import {
  type AggregateQuery,
  AUDIT_ACTIONS,
  type CreateSnapshot,
  ERROR_CODES,
  FORM_SERIES,
  type GeographyBreakdown,
  type LiveAggregate,
  type Paginated,
  PARALLEL_TALLY_DISCLAIMER,
  type PaginationQuery,
  type PermissionKey,
  type ReleaseSnapshot,
  type ScopeType,
  type SnapshotQuery,
  type SubmissionSummary,
  type TallySnapshot,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { cycleOrTenantDataLabel } from '../../../common/provenance/data-label';
import { PermissionService } from '../../../rbac/permission.service';
import { type PermissionScope, stationScopeWhere } from '../../../rbac/scope';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  type AggCandidate,
  type AggregateResult,
  type AggStation,
  type AggSubmission,
  CALCULATION_VERSION,
  computeAggregate,
  DEFAULT_FIELD_KEYS,
  type CoverageStatus,
  type StationRow,
} from '../domain/aggregation';
import { ENTITY, HOLDING_CASE_TYPES, OPEN_CASE_STATUSES } from '../tally.constants';
import { iso, submissionSummaryInclude, toSubmissionSummary, userRef } from './mappers';
import { caseScopeWhere, snapshotScopeWhere } from './scope-where';

export type { StationCoverageRow } from '@ngao360/shared';
import type { StationCoverageRow } from '@ngao360/shared';

type SubmissionStatusValue = AggSubmission['status'];

export interface ComputeParams {
  electionCycleId: string;
  contestId: string;
  geographicUnitId?: string | null;
  scope?: PermissionScope;
}

export interface ComputedAggregate {
  aggregate: AggregateResult;
  stations: AggStation[];
  submissions: AggSubmission[];
  candidates: AggCandidate[];
  registryVersionId: string | null;
  stationFormNumber: string;
  contest: { id: string; name: string; officeType: string; geographicUnitId: string | null };
}

@Injectable()
export class ResultsService {
  /**
   * Read-path cache of computed aggregates (live, breakdown, stations), per tenant, cycle, contest,
   * area and caller scope. An entry is reused only while the contest's data stamp (submissions,
   * discrepancy cases and links, candidates, approved registry) is unchanged, so a cached answer is
   * never older than the last committed change (unless TALLY_AGGREGATE_MAX_STALE_SECONDS allows it);
   * TALLY_AGGREGATE_CACHE_SECONDS bounds its age anyway.
   * Concurrent requests for the same key share one computation (single flight). Snapshots always
   * compute fresh in their own transaction. Load test: docs/OPERATIONS.md.
   */
  private readonly aggCache = new Map<string, { at: Date; stamp: string; value: ComputedAggregate }>();
  /**
   * TALLY_AGGREGATE_MAX_STALE_SECONDS (default 0 = always current): during an intake burst every new
   * form changes the stamp; a few seconds of tolerated staleness (computedAt says how old) stops the
   * 55k-station aggregate from being recomputed for every viewer request. See docs/RUNBOOKS.md.
   */
  private readonly aggMaxStaleMs = (() => {
    const v = Number(process.env.TALLY_AGGREGATE_MAX_STALE_SECONDS ?? 0);
    return Number.isFinite(v) && v >= 0 ? v * 1000 : 0;
  })();
  private readonly aggInflight = new Map<string, Promise<{ at: Date; stamp: string; value: ComputedAggregate }>>();
  private readonly aggTtlMs = (() => {
    const v = Number(process.env.TALLY_AGGREGATE_CACHE_SECONDS ?? 30);
    return Number.isFinite(v) && v >= 0 ? v * 1000 : 30_000;
  })();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  /** Cheap fingerprint of everything compute() reads that can change for a contest. */
  private async dataStamp(tx: TenantTx, p: ComputeParams): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ stamp: string }>>`
      SELECT concat_ws('|',
        (SELECT concat_ws(':', count(*), sum(version), max(updated_at)) FROM result_submissions WHERE contest_id = ${p.contestId}::uuid),
        (SELECT concat_ws(':', count(*), max(updated_at)) FROM discrepancy_cases WHERE contest_id = ${p.contestId}::uuid),
        (SELECT count(*) FROM discrepancy_case_submissions dcs JOIN discrepancy_cases c ON c.id = dcs.case_id WHERE c.contest_id = ${p.contestId}::uuid),
        (SELECT concat_ws(':', count(*), max(updated_at)) FROM candidate_references WHERE contest_id = ${p.contestId}::uuid),
        (SELECT string_agg(id::text, ',' ORDER BY id) FROM registry_versions WHERE election_cycle_id = ${p.electionCycleId}::uuid AND status = 'APPROVED')
      ) AS stamp`;
    return rows[0]?.stamp ?? '';
  }

  /** compute() through the read-path cache; returns when the figures were computed. */
  async computeCached(tx: TenantTx, tenantId: string, p: ComputeParams): Promise<{ at: Date; value: ComputedAggregate }> {
    if (this.aggTtlMs === 0) return { at: new Date(), value: await this.compute(tx, p) };
    const scope = p.scope
      ? JSON.stringify([p.scope.orgWide, [...p.scope.unitIds].sort(), [...p.scope.stationIds].sort(), [...p.scope.stationKeys].sort()])
      : 'none';
    const key = [tenantId, p.electionCycleId, p.contestId, p.geographicUnitId ?? '', scope].join('|');
    const stamp = await this.dataStamp(tx, p);
    const hit = this.aggCache.get(key);
    const age = hit ? Date.now() - hit.at.getTime() : Infinity;
    if (hit && age < this.aggTtlMs && (hit.stamp === stamp || age < this.aggMaxStaleMs)) return hit;
    const running = this.aggInflight.get(key);
    if (running) {
      try {
        const r = await running;
        if (r.stamp === stamp) return r;
      } catch {
        // compute below with this caller's transaction
      }
    }
    const work = (async () => {
      const at = new Date();
      const value = await this.compute(tx, p);
      const entry = { at, stamp, value };
      while (this.aggCache.size >= 64) this.aggCache.delete(this.aggCache.keys().next().value as string);
      this.aggCache.set(key, entry);
      return entry;
    })();
    this.aggInflight.set(key, work);
    try {
      return await work;
    } finally {
      if (this.aggInflight.get(key) === work) this.aggInflight.delete(key);
    }
  }

  /* ------------------------------- Computation ------------------------------- */

  /** Load expected stations and station-level submissions, then aggregate (pure). */
  async compute(tx: TenantTx, p: ComputeParams): Promise<ComputedAggregate> {
    const contest = await tx.contest.findUnique({
      where: { id: p.contestId },
      include: { candidates: { orderBy: { ballotOrder: 'asc' } } },
    });
    if (!contest || contest.electionCycleId !== p.electionCycleId) {
      throw AppException.validation('The contest does not belong to the selected election cycle');
    }
    const stationFormNumber = FORM_SERIES[contest.officeType].station;
    const registry = await tx.registryVersion.findFirst({
      where: { electionCycleId: p.electionCycleId, status: 'APPROVED' },
      select: { id: true },
    });
    const candidates: AggCandidate[] = contest.candidates.map((c) => ({
      id: c.id,
      candidateNameAsPublished: c.candidateNameAsPublished,
      partyLabel: c.partyLabel,
      ballotOrder: c.ballotOrder,
    }));
    if (!registry) {
      return {
        aggregate: computeAggregate([], [], candidates),
        stations: [],
        submissions: [],
        candidates,
        registryVersionId: null,
        stationFormNumber,
        contest,
      };
    }

    const and: Prisma.PollingStationWhereInput[] = [
      { registryVersionId: registry.id },
      { status: { not: 'INACTIVE' } },
    ];
    if (contest.geographicUnitId) {
      const a = contest.geographicUnitId;
      and.push({ OR: [{ countyId: a }, { constituencyId: a }, { wardId: a }] });
    }
    if (p.geographicUnitId) {
      const u = p.geographicUnitId;
      and.push({ OR: [{ countyId: u }, { constituencyId: u }, { wardId: u }, { pollingCentreId: u }] });
    }
    const scoped = p.scope ? stationScopeWhere(p.scope) : undefined;
    if (scoped) and.push(scoped as Prisma.PollingStationWhereInput);
    const stationWhere: Prisma.PollingStationWhereInput = { AND: and };

    const stations = await tx.pollingStation.findMany({
      where: stationWhere,
      select: {
        id: true,
        code: true,
        name: true,
        countyId: true,
        constituencyId: true,
        wardId: true,
        pollingCentreId: true,
        geographicUnitId: true,
      },
      orderBy: { code: 'asc' },
    });
    // Submissions keep the station row they were filed against. A later
    // registry version creates new station rows, so records are matched to the
    // current registry by the stable station code (within this cycle), never
    // by row id: a received form must never be reported as missing.
    const stationIdByCode = new Map(stations.map((st) => [st.code, st.id] as const));
    // Load-test findings (docs/OPERATIONS.md): a Prisma `in: [...]` list binds one parameter per
    // element and fails above 32,767 (any contest larger than ~32k stations, e.g. a national tally);
    // `= ANY(array)` is a linear scan per row (55k x 55k comparisons, 19 s); a join on unnest(array)
    // depends on row estimates and degenerated to minutes on freshly loaded, unanalysed tables, and so did
    // a self-join on the station code. So the database only selects the contest's station forms (by
    // contest and the station row's primary key) and the match to the approved registry by stable code,
    // with the caller's scope and area already applied to `stations`, happens in memory.
    const openStatuses = OPEN_CASE_STATUSES.map(String);
    const holdingTypes = HOLDING_CASE_TYPES.map(String);
    // Contest-wide reads: hash joins regardless of row estimates. Right after a bulk registry import or
    // an intake burst the statistics say "1 row" and the planner picks nested loops that rescan an
    // index per row (47 s for 40k stations in the regression test; 0.1 s with hash joins).
    await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = off');
    const rawSubs = await tx.$queryRaw<Array<{ id: string; status: SubmissionStatusValue; is_canonical: boolean; code: string }>>`
      SELECT rs.id, rs.status::text AS status, rs.is_canonical, ps.code
      FROM result_submissions rs
      JOIN polling_stations ps ON ps.id = rs.polling_station_id
      WHERE rs.contest_id = ${contest.id}::uuid
        AND rs.form_number = ${stationFormNumber}
        AND rs.election_cycle_id = ${p.electionCycleId}::uuid
        AND ps.election_cycle_id = ${p.electionCycleId}::uuid`;
    // Open discrepancy links of the contest (few), merged in memory rather than probed per submission.
    const openLinks = await tx.$queryRaw<Array<{ submission_id: string; has_holding: boolean }>>`
      SELECT dcs.submission_id, bool_or(c.variance_type::text = ANY(${holdingTypes}::text[])) AS has_holding
      FROM discrepancy_cases c
      JOIN discrepancy_case_submissions dcs ON dcs.case_id = c.id
      JOIN result_submissions ls ON ls.id = dcs.submission_id
      WHERE ls.contest_id = ${contest.id}::uuid AND c.status::text = ANY(${openStatuses}::text[])
      GROUP BY dcs.submission_id`;
    const linkBySub = new Map(openLinks.map((l) => [l.submission_id, l.has_holding] as const));
    const subs = rawSubs
      .filter((s) => stationIdByCode.has(s.code))
      .map((s) => ({
        id: s.id,
        status: s.status,
        isCanonical: s.is_canonical,
        pollingStationId: stationIdByCode.get(s.code) ?? null,
        hasOpenDiscrepancy: linkBySub.has(s.id),
        hasOpenHoldingCase: linkBySub.get(s.id) === true,
      }));
    const includedIds = subs.filter((s) => s.isCanonical && s.status === 'VERIFIED' && !s.hasOpenHoldingCase).map((s) => s.id);
    const included = new Set(includedIds);
    // Only the fields the aggregate reads (candidate votes, valid votes, rejected ballots).
    const aggKeys = [DEFAULT_FIELD_KEYS.candidateVotes, DEFAULT_FIELD_KEYS.totalValidVotes, DEFAULT_FIELD_KEYS.rejectedBallots];
    const values = includedIds.length
      ? (
          await tx.$queryRaw<Array<{ submissionId: string; fieldKey: string; candidateReferenceId: string | null; numericValue: number | null }>>`
            SELECT rv.submission_id AS "submissionId", rv.field_key AS "fieldKey", rv.candidate_reference_id AS "candidateReferenceId",
                   rv.numeric_value AS "numericValue"
            FROM result_values rv
            JOIN result_submissions rs ON rs.id = rv.submission_id
            WHERE rs.contest_id = ${contest.id}::uuid AND rs.form_number = ${stationFormNumber}
              AND rs.status = 'VERIFIED' AND rs.is_canonical AND rv.field_key = ANY(${aggKeys}::text[])`
        ).filter((v) => included.has(v.submissionId))
      : [];
    await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = on');
    const bySub = new Map<string, AggSubmission['values'][number][]>();
    for (const v of values) {
      const list = bySub.get(v.submissionId) ?? [];
      list.push(v);
      bySub.set(v.submissionId, list);
    }
    const submissions: AggSubmission[] = subs.map((s) => ({
      id: s.id,
      pollingStationId: s.pollingStationId,
      status: s.status,
      isCanonical: s.isCanonical,
      hasOpenDiscrepancy: s.hasOpenDiscrepancy,
      hasOpenHoldingCase: s.hasOpenHoldingCase,
      values: bySub.get(s.id) ?? [],
    }));
    return {
      aggregate: computeAggregate(stations, submissions, candidates),
      stations,
      submissions,
      candidates,
      registryVersionId: registry.id,
      stationFormNumber,
      contest,
    };
  }

  /** Scope of `permission` for records of one election cycle (cycle-limited grants honoured). */
  private scope(auth: AuthContext, permission: PermissionKey, electionCycleId?: string | null): PermissionScope {
    return this.permissions.scopeFor(auth, permission, electionCycleId);
  }

  /* ---------------------------------- Live ----------------------------------- */

  live(auth: AuthContext, q: AggregateQuery): Promise<LiveAggregate> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.results.view', q.electionCycleId);
      const { at: computedAt, value: c } = await this.computeCached(tx, auth.tenantId, { ...q, scope });
      const caseWhere: Prisma.DiscrepancyCaseWhereInput = {
        AND: [
          { electionCycleId: q.electionCycleId, contestId: q.contestId, status: { in: OPEN_CASE_STATUSES } },
          caseScopeWhere(scope) ?? {},
        ],
      };
      const [openDiscrepancyCount, latest, dataLabel] = await Promise.all([
        tx.discrepancyCase.count({ where: caseWhere }),
        tx.tallySnapshot.findFirst({
          where: { contestId: q.contestId, geographicUnitId: q.geographicUnitId ?? null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
        cycleOrTenantDataLabel(tx, auth.tenantId, q.electionCycleId),
      ]);
      const a = c.aggregate;
      return {
        electionCycleId: q.electionCycleId,
        contestId: q.contestId,
        geographyScopeType: q.geographyScopeType,
        geographicUnitId: q.geographicUnitId ?? null,
        calculationVersion: a.calculationVersion,
        computedAt: computedAt.toISOString(),
        coverage: a.coverage,
        totalVerifiedValidVotes: a.totalVerifiedValidVotes,
        rejectedBallots: a.rejectedBallots,
        candidates: a.candidates,
        includedStationCount: a.includedStationCount,
        openDiscrepancyCount,
        latestSnapshotId: latest?.id ?? null,
        disclaimer: PARALLEL_TALLY_DISCLAIMER,
        dataLabel: dataLabel?.label ?? null,
      };
    });
  }

  /* -------------------------------- Breakdown -------------------------------- */

  breakdown(auth: AuthContext, q: AggregateQuery & { parentUnitId?: string }): Promise<GeographyBreakdown> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.results.view', q.electionCycleId);
      const contest = await tx.contest.findUnique({ where: { id: q.contestId }, select: { geographicUnitId: true } });
      const parentId = q.parentUnitId ?? q.geographicUnitId ?? contest?.geographicUnitId ?? null;
      const { value: c } = await this.computeCached(tx, auth.tenantId, { ...q, geographicUnitId: parentId, scope });

      const children = await tx.geographicUnit.findMany({
        where: parentId
          ? { parentId, electionCycleId: q.electionCycleId }
          : { type: 'COUNTY', electionCycleId: q.electionCycleId },
        select: { id: true, officialCode: true, officialName: true },
        orderBy: { officialCode: 'asc' },
      });
      const rows: GeographyBreakdown['rows'] = [];
      for (const unit of children) {
        const group = c.stations.filter(
          (s) => s.countyId === unit.id || s.constituencyId === unit.id || s.wardId === unit.id || s.pollingCentreId === unit.id,
        );
        if (group.length === 0) continue;
        const a = computeAggregate(group, c.submissions, c.candidates);
        rows.push({
          geographicUnitId: unit.id,
          pollingStationId: null,
          code: unit.officialCode,
          name: unit.officialName,
          coverage: a.coverage,
          // Units with no verified station show no candidate figures rather than zeros.
          candidates:
            a.includedStationCount === 0
              ? []
              : a.candidates.map((x) => ({ candidateReferenceId: x.candidateReferenceId, verifiedVotes: x.verifiedVotes })),
        });
      }
      if (parentId) {
        const direct = c.stations.filter((s) => s.geographicUnitId === parentId);
        for (const st of direct) {
          const a = computeAggregate([st], c.submissions, c.candidates);
          const row = a.stations[0]!;
          rows.push({
            geographicUnitId: null,
            pollingStationId: st.id,
            code: st.code,
            name: st.name,
            coverage: a.coverage,
            candidates: row.candidateVotes
              ? Object.entries(row.candidateVotes).map(([candidateReferenceId, verifiedVotes]) => ({
                  candidateReferenceId,
                  verifiedVotes,
                }))
              : [],
          });
        }
      }
      return { parentUnitId: parentId, rows, disclaimer: PARALLEL_TALLY_DISCLAIMER };
    });
  }

  /* --------------------------------- Stations -------------------------------- */

  stations(
    auth: AuthContext,
    q: AggregateQuery & PaginationQuery & { status?: CoverageStatus },
  ): Promise<Paginated<StationCoverageRow>> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.results.view', q.electionCycleId);
      const { value: c } = await this.computeCached(tx, auth.tenantId, { ...q, scope });
      let rows: StationRow[] = c.aggregate.stations;
      if (q.status) rows = rows.filter((r) => r.coverageStatus === q.status);
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((r) => r.code.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle));
      }
      const total = rows.length;
      const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      const subIds = page.map((r) => r.submissionId).filter((v): v is string => !!v);
      const [summaries, stationInfo] = await Promise.all([
        tx.resultSubmission.findMany({ where: { id: { in: subIds } }, include: submissionSummaryInclude }),
        tx.pollingStation.findMany({
          where: { id: { in: page.map((r) => r.pollingStationId) } },
          select: {
            id: true,
            ward: { select: { officialName: true } },
            constituency: { select: { officialName: true } },
            county: { select: { officialName: true } },
          },
        }),
      ]);
      const sumMap = new Map(summaries.map((s) => [s.id, toSubmissionSummary(s)] as const));
      const infoMap = new Map(stationInfo.map((s) => [s.id, s] as const));
      const items: StationCoverageRow[] = page.map((r) => {
        const s = r.submissionId ? sumMap.get(r.submissionId) : undefined;
        const info = infoMap.get(r.pollingStationId);
        const base = {
          contestId: c.contest.id,
          contestName: c.contest.name,
          officeType: c.contest.officeType as SubmissionSummary['officeType'],
          electionCycleId: q.electionCycleId,
          pollingStationCode: r.code,
          pollingStationName: r.name,
          tallyCentreId: null,
          tallyCentreName: null,
          wardName: info?.ward.officialName ?? null,
          constituencyName: info?.constituency.officialName ?? null,
          countyName: info?.county.officialName ?? null,
          openDiscrepancyCount: s?.openDiscrepancyCount ?? 0,
        };
        return {
          ...base,
          id: s?.id ?? null,
          reference: s?.reference ?? null,
          formNumber: s?.formNumber ?? null,
          formLevel: s?.formLevel ?? null,
          formTemplateVersion: s?.formTemplateVersion ?? null,
          status: s?.status ?? null,
          sourceType: s?.sourceType ?? null,
          isCanonical: s?.isCanonical ?? null,
          duplicateFlag: s?.duplicateFlag ?? null,
          submitter: s?.submitter ?? null,
          submittedAt: s?.submittedAt ?? null,
          createdAt: s?.createdAt ?? null,
          updatedAt: s?.updatedAt ?? null,
          pollingStationId: r.pollingStationId,
          coverageStatus: r.coverageStatus,
          candidateVotes: r.candidateVotes,
        };
      });
      return { items, page: q.page, pageSize: q.pageSize, total };
    });
  }

  /* -------------------------------- Snapshots -------------------------------- */

  /**
   * POST /tally/snapshots. Immutable: stores included submission ids, totals,
   * coverage (with per-station statuses) and a SHA-256 content hash. A newer
   * verified record produces a new snapshot; existing ones are never rewritten.
   */
  createSnapshot(auth: AuthContext, body: CreateSnapshot): Promise<TallySnapshot> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.snapshot.create', body.electionCycleId);
      if (!scope.orgWide && !body.geographicUnitId) {
        throw AppException.outOfScope('Choose an area within your assignment for this snapshot');
      }
      let geographyScopeType: ScopeType = body.geographyScopeType;
      if (body.geographicUnitId) {
        const unit = await tx.geographicUnit.findUnique({
          where: { id: body.geographicUnitId },
          select: { type: true, path: true },
        });
        if (!unit) throw AppException.validation('Unknown geographic unit');
        if (!scope.orgWide && !scope.unitIds.some((u) => unit.path.includes(`/${u}/`))) throw AppException.outOfScope();
        geographyScopeType = unit.type;
      } else {
        geographyScopeType = 'ORGANISATION';
      }
      const c = await this.compute(tx, { ...body, scope });
      const a = c.aggregate;
      const includedSubmissionIds = [...a.includedSubmissionIds].sort();
      // A historical demo snapshot carries its label inside the immutable, hashed content.
      const dataLabel = await cycleOrTenantDataLabel(tx, auth.tenantId, body.electionCycleId);
      const totals = {
        totalVerifiedValidVotes: a.totalVerifiedValidVotes,
        rejectedBallots: a.rejectedBallots,
        candidates: a.candidates,
        stationFormNumber: c.stationFormNumber,
        stations: a.stations,
        ...(dataLabel ? { dataLabel: dataLabel.label, dataNotice: dataLabel.notice } : {}),
      };
      const content = {
        electionCycleId: body.electionCycleId,
        contestId: body.contestId,
        geographyScopeType,
        geographicUnitId: body.geographicUnitId ?? null,
        calculationVersion: CALCULATION_VERSION,
        registryVersionId: c.registryVersionId,
        stationFormNumber: c.stationFormNumber,
        includedSubmissionIds,
        totals,
        coverage: a.coverage,
      };
      const contentHash = sha256Hex(canonicalJson(content));
      const reference = await nextReference(tx, auth.tenantId, 'SNP');
      const snap = await tx.tallySnapshot.create({
        data: {
          tenantId: auth.tenantId,
          reference,
          electionCycleId: body.electionCycleId,
          contestId: body.contestId,
          geographyScopeType,
          geographicUnitId: body.geographicUnitId ?? null,
          calculationVersion: CALCULATION_VERSION,
          includedSubmissionIds,
          totalsJson: totals as unknown as Prisma.InputJsonValue,
          coverageJson: a.coverage as unknown as Prisma.InputJsonValue,
          expectedStations: a.coverage.expectedStations,
          includedStations: a.includedStationCount,
          registryVersionId: c.registryVersionId,
          contentHash,
          note: body.note ?? null,
          createdById: auth.userId,
        },
        include: { createdBy: userRef, releasedBy: userRef },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.SNAPSHOT_CREATED,
          entityType: ENTITY.SNAPSHOT,
          entityId: snap.id,
          after: {
            reference,
            contentHash,
            calculationVersion: CALCULATION_VERSION,
            includedStations: a.includedStationCount,
            expectedStations: a.coverage.expectedStations,
            registryVersionId: c.registryVersionId,
          },
          reason: body.note ?? null,
        },
        tx,
      );
      return toSnapshot(snap);
    });
  }

  listSnapshots(auth: AuthContext, q: SnapshotQuery): Promise<Paginated<TallySnapshot>> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.results.view');
      const and: Prisma.TallySnapshotWhereInput[] = [];
      if (q.electionCycleId) and.push({ electionCycleId: q.electionCycleId });
      if (q.contestId) and.push({ contestId: q.contestId });
      if (q.releasedOnly) and.push({ releasedAt: { not: null } });
      const scoped = snapshotScopeWhere(scope);
      if (scoped) and.push(scoped);
      const where = { AND: and };
      const [total, rows] = await Promise.all([
        tx.tallySnapshot.count({ where }),
        tx.tallySnapshot.findMany({
          where,
          include: { createdBy: userRef, releasedBy: userRef },
          orderBy: [{ createdAt: q.order }, { id: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]);
      return { items: rows.map(toSnapshot), page: q.page, pageSize: q.pageSize, total };
    });
  }

  getSnapshot(auth: AuthContext, id: string): Promise<TallySnapshot> {
    return this.prisma.tenantTx(async (tx) => {
      const s = await this.loadSnapshotInScope(tx, auth, id, 'tally.results.view');
      return toSnapshot(s);
    });
  }

  async loadSnapshotInScope(tx: TenantTx, auth: AuthContext, id: string, permission: PermissionKey) {
    const s = await tx.tallySnapshot.findUnique({
      where: { id },
      include: { createdBy: userRef, releasedBy: userRef, geographicUnit: { select: { path: true } } },
    });
    if (!s) throw AppException.notFound('Snapshot not found');
    const scope = this.scope(auth, permission, s.electionCycleId);
    if (!scope.held) throw AppException.forbidden(undefined, { required: [permission] });
    if (!scope.orgWide) {
      const path = s.geographicUnit?.path;
      if (!path || !scope.unitIds.some((u) => path.includes(`/${u}/`))) throw AppException.outOfScope();
    }
    return s;
  }

  /**
   * POST /tally/snapshots/:id/release. Internal release to authorised viewers
   * only, never a public declaration. Allowed once (DB trigger enforces it too).
   */
  releaseSnapshot(auth: AuthContext, id: string, body: ReleaseSnapshot): Promise<TallySnapshot> {
    return this.prisma.tenantTx(async (tx) => {
      const s = await this.loadSnapshotInScope(tx, auth, id, 'tally.release');
      if (s.releasedAt) {
        throw new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, 'This snapshot has already been released');
      }
      const updated = await tx.tallySnapshot.update({
        where: { id },
        data: { releasedAt: new Date(), releasedById: auth.userId },
        include: { createdBy: userRef, releasedBy: userRef },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.SNAPSHOT_RELEASED,
          entityType: ENTITY.SNAPSHOT,
          entityId: id,
          before: { releasedAt: null },
          after: { releasedAt: updated.releasedAt, releasedById: auth.userId, contentHash: s.contentHash },
          reason: body.reason,
        },
        tx,
      );
      return toSnapshot(updated);
    });
  }
}

type SnapshotRow = Prisma.TallySnapshotGetPayload<{ include: { createdBy: typeof userRef; releasedBy: typeof userRef } }>;

export function toSnapshot(s: SnapshotRow): TallySnapshot {
  const totals = s.totalsJson as unknown as TallySnapshot['totals'];
  return {
    id: s.id,
    reference: s.reference,
    electionCycleId: s.electionCycleId,
    contestId: s.contestId,
    geographyScopeType: s.geographyScopeType,
    geographicUnitId: s.geographicUnitId,
    calculationVersion: s.calculationVersion,
    includedSubmissionIds: s.includedSubmissionIds,
    totals: {
      totalVerifiedValidVotes: totals.totalVerifiedValidVotes,
      rejectedBallots: totals.rejectedBallots,
      candidates: totals.candidates,
    },
    coverage: s.coverageJson as unknown as TallySnapshot['coverage'],
    registryVersionId: s.registryVersionId,
    contentHash: s.contentHash,
    createdBy: s.createdBy,
    createdAt: iso(s.createdAt),
    releasedAt: iso(s.releasedAt),
    releasedBy: s.releasedBy,
    disclaimer: PARALLEL_TALLY_DISCLAIMER,
    dataLabel: (s.totalsJson as { dataLabel?: string } | null)?.dataLabel ?? null,
  };
}
