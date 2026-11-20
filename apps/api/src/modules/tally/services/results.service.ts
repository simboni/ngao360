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
  type CoverageStatus,
  type StationRow,
} from '../domain/aggregation';
import { ENTITY, HOLDING_CASE_TYPES, OPEN_CASE_STATUSES } from '../tally.constants';
import { iso, submissionSummaryInclude, toSubmissionSummary, userRef } from './mappers';
import { caseScopeWhere, snapshotScopeWhere } from './scope-where';

export type { StationCoverageRow } from '@ngao360/shared';
import type { StationCoverageRow } from '@ngao360/shared';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

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
    const rawSubs = await tx.resultSubmission.findMany({
      where: {
        contestId: contest.id,
        formNumber: stationFormNumber,
        pollingStation: { electionCycleId: p.electionCycleId, code: { in: [...stationIdByCode.keys()] } },
      },
      select: {
        id: true,
        status: true,
        isCanonical: true,
        pollingStation: { select: { code: true } },
        discrepancyLinks: {
          where: { case: { status: { in: OPEN_CASE_STATUSES } } },
          select: { case: { select: { varianceType: true } } },
        },
      },
    });
    const subs = rawSubs.map((s) => ({
      ...s,
      pollingStationId: s.pollingStation ? (stationIdByCode.get(s.pollingStation.code) ?? null) : null,
      hasOpenHoldingCase: s.discrepancyLinks.some((l) => HOLDING_CASE_TYPES.includes(l.case.varianceType)),
    }));
    const includedIds = subs.filter((s) => s.isCanonical && s.status === 'VERIFIED' && !s.hasOpenHoldingCase).map((s) => s.id);
    const values = includedIds.length
      ? await tx.resultValue.findMany({
          where: { submissionId: { in: includedIds } },
          select: { submissionId: true, fieldKey: true, candidateReferenceId: true, numericValue: true },
        })
      : [];
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
      hasOpenDiscrepancy: s.discrepancyLinks.length > 0,
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
      const c = await this.compute(tx, { ...q, scope });
      const caseWhere: Prisma.DiscrepancyCaseWhereInput = {
        AND: [
          { electionCycleId: q.electionCycleId, contestId: q.contestId, status: { in: OPEN_CASE_STATUSES } },
          caseScopeWhere(scope) ?? {},
        ],
      };
      const [openDiscrepancyCount, latest] = await Promise.all([
        tx.discrepancyCase.count({ where: caseWhere }),
        tx.tallySnapshot.findFirst({
          where: { contestId: q.contestId, geographicUnitId: q.geographicUnitId ?? null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
      ]);
      const a = c.aggregate;
      return {
        electionCycleId: q.electionCycleId,
        contestId: q.contestId,
        geographyScopeType: q.geographyScopeType,
        geographicUnitId: q.geographicUnitId ?? null,
        calculationVersion: a.calculationVersion,
        computedAt: new Date().toISOString(),
        coverage: a.coverage,
        totalVerifiedValidVotes: a.totalVerifiedValidVotes,
        rejectedBallots: a.rejectedBallots,
        candidates: a.candidates,
        includedStationCount: a.includedStationCount,
        openDiscrepancyCount,
        latestSnapshotId: latest?.id ?? null,
        disclaimer: PARALLEL_TALLY_DISCLAIMER,
      };
    });
  }

  /* -------------------------------- Breakdown -------------------------------- */

  breakdown(auth: AuthContext, q: AggregateQuery & { parentUnitId?: string }): Promise<GeographyBreakdown> {
    return this.prisma.tenantTx(async (tx) => {
      const scope = this.scope(auth, 'tally.results.view', q.electionCycleId);
      const contest = await tx.contest.findUnique({ where: { id: q.contestId }, select: { geographicUnitId: true } });
      const parentId = q.parentUnitId ?? q.geographicUnitId ?? contest?.geographicUnitId ?? null;
      const c = await this.compute(tx, { ...q, geographicUnitId: parentId, scope });

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
      const c = await this.compute(tx, { ...q, scope });
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
      const totals = {
        totalVerifiedValidVotes: a.totalVerifiedValidVotes,
        rejectedBallots: a.rejectedBallots,
        candidates: a.candidates,
        stationFormNumber: c.stationFormNumber,
        stations: a.stations,
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
  };
}
