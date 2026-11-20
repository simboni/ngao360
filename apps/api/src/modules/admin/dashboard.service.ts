import { Injectable } from '@nestjs/common';
import type { Prisma, SubmissionStatus, TenantTx } from '@ngao360/db';
import type {
  DashboardActivity,
  DashboardKpi,
  DashboardQuery,
  DashboardQueueItem,
  DashboardSummaryExtended,
} from '@ngao360/shared';
import type { AuthContext } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionService } from '../../rbac/permission.service';
import { type PermissionScope, stationScopeWhere } from '../../rbac/scope';
import { TenantModulesService } from '../../tenant-modules/tenant-modules.service';

const PENDING_STATUSES: SubmissionStatus[] = ['SUBMITTED', 'OCR_COMPLETE', 'DATA_ENTRY_REVIEWED', 'SECOND_REVIEW_PENDING'];
const REJECTED_STATUSES: SubmissionStatus[] = ['RETURNED', 'DISPUTED', 'QUARANTINED', 'EXCLUDED_FROM_AGGREGATE'];
const RECEIVED_EXCLUDED: SubmissionStatus[] = ['DRAFT', 'ARCHIVED'];
const OPEN_DISCREPANCY = ['OPEN', 'UNDER_REVIEW', 'ESCALATED'] as const;

type ContestRow = { id: string; name: string; officeType: string; formSeries: string; geographicUnitId: string | null };

/** Stations inside the contest's electoral area (county for governor, etc.). */
function contestAreaWhere(c: ContestRow | null): Prisma.PollingStationWhereInput {
  if (!c || !c.geographicUnitId) return {};
  switch (c.officeType) {
    case 'NATIONAL_ASSEMBLY':
      return { constituencyId: c.geographicUnitId };
    case 'COUNTY_ASSEMBLY':
      return { wardId: c.geographicUnitId };
    case 'PRESIDENT':
      return {};
    default:
      return { countyId: c.geographicUnitId };
  }
}

const qs = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};

/**
 * S04 Executive / Tally Command Centre summary (API contract §7).
 * Every count is computed live inside the caller's tenant (RLS) and geography
 * scope. Missing stations are reported as missing, never as zero.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
  ) {}

  summary(auth: AuthContext, q: DashboardQuery): Promise<DashboardSummaryExtended> {
    return this.prisma.tenantTx(async (tx) => {
      const now = new Date();
      const asOf = now.toISOString();
      const has = (p: Parameters<PermissionService['has']>[1]) => this.permissions.has(auth, p);
      const includesTally = has('tally.view');
      const cycle = q.electionCycleId
        ? await tx.electionCycle.findUnique({ where: { id: q.electionCycleId } })
        : ((await tx.electionCycle.findFirst({ where: { status: 'ACTIVE' }, orderBy: { electionDate: 'desc' } })) ??
          (await tx.electionCycle.findFirst({ where: { status: { not: 'ARCHIVED' } }, orderBy: { electionDate: 'desc' } })));

      // Tally figures are for one cycle: only grants that apply to it count.
      const tallyScope = this.permissions.scopeFor(auth, 'tally.view', cycle?.id ?? null);
      const refScope = this.permissions.scopeFor(auth, 'reference.view');
      const scope: PermissionScope | null = includesTally ? tallyScope : refScope.held ? refScope : null;

      const registry = cycle
        ? await tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' } })
        : null;
      const contestRows = cycle
        ? await tx.contest.findMany({
            where: { electionCycleId: cycle.id },
            select: { id: true, name: true, officeType: true, formSeries: true, geographicUnitId: true, status: true },
            orderBy: { name: 'asc' },
          })
        : [];
      // Active contests first, then drafts, then closed.
      const rank = { ACTIVE: 0, DRAFT: 1, CLOSED: 2 } as const;
      const contests: ContestRow[] = [...contestRows].sort((a, b) => rank[a.status] - rank[b.status]);
      const contest = (q.contestId ? contests.find((c) => c.id === q.contestId) : contests[0]) ?? null;

      const kpis: DashboardKpi[] = [];
      const base = { asOf, trend: null, unit: 'count' as const, breakdown: [], availability: 'AVAILABLE' as const };
      const cycleQ = { electionCycleId: cycle?.id, contestId: contest?.id };

      // Expected stations: approved registry, contest area, caller scope.
      let expected: number | null = null;
      const stationWhere: Prisma.PollingStationWhereInput | null =
        registry && scope
          ? { AND: [{ registryVersionId: registry.id, status: { not: 'INACTIVE' } }, contestAreaWhere(contest), stationScopeWhere(scope) ?? {}] }
          : null;
      if (scope) {
        expected = stationWhere ? await tx.pollingStation.count({ where: stationWhere }) : null;
        kpis.push({
          ...base,
          key: 'expected_stations',
          label: 'Expected stations',
          value: expected,
          denominator: null,
          definition: registry
            ? `Stations in approved registry version ${registry.version}${contest ? ` within the ${contest.name} area` : ''}${scope.orgWide ? '' : ' and your assigned geography'}.`
            : 'No station registry version is approved for this election cycle yet.',
          href: `/reference/stations${qs({ electionCycleId: cycle?.id, registryVersionId: registry?.id })}`,
          availability: registry ? 'AVAILABLE' : 'NO_DATA',
        });
      }

      let priorityQueue: DashboardQueueItem[] = [];
      if (includesTally && cycle && contest) {
        const subScope: Prisma.ResultSubmissionWhereInput = tallyScope.orgWide
          ? {}
          : { pollingStation: { is: stationScopeWhere(tallyScope) ?? {} } };
        const stationLevel: Prisma.ResultSubmissionWhereInput = {
          AND: [{ electionCycleId: cycle.id, contestId: contest.id, formTemplate: { formLevel: 'POLLING_STATION' } }, subScope],
        };
        // Expected stations with a matching submission, matched by station code within
        // the cycle: forms filed against an earlier registry version still count for
        // the same station in the approved version (station lineage, never row id).
        const stationsWith = async (where: Prisma.ResultSubmissionWhereInput): Promise<number> => {
          if (!stationWhere) return 0;
          const filed = await tx.resultSubmission.findMany({
            where: { AND: [stationLevel, where, { pollingStationId: { not: null } }] },
            select: { pollingStation: { select: { code: true } } },
            distinct: ['pollingStationId'],
          });
          const codes = [...new Set(filed.map((f) => f.pollingStation?.code).filter((c): c is string => !!c))];
          if (codes.length === 0) return 0;
          return tx.pollingStation.count({ where: { AND: [stationWhere, { code: { in: codes } }] } });
        };

        const [received, verified, pending, rejected, duplicates, awaiting] = await Promise.all([
          stationsWith({ status: { notIn: RECEIVED_EXCLUDED } }),
          stationsWith({ status: 'VERIFIED', isCanonical: true }),
          tx.resultSubmission.count({ where: { AND: [stationLevel, { status: { in: PENDING_STATUSES } }] } }),
          tx.resultSubmission.count({ where: { AND: [stationLevel, { status: { in: REJECTED_STATUSES } }] } }),
          tx.resultSubmission.count({ where: { AND: [stationLevel, { duplicateFlag: true, isCanonical: false }] } }),
          tx.resultSubmission.count({ where: { AND: [stationLevel, { status: 'SECOND_REVIEW_PENDING' }] } }),
        ]);
        const missing = expected === null ? null : Math.max(0, expected - received);
        const inbox = (extra: Record<string, string | undefined>) => `/tally/inbox${qs({ ...cycleQ, ...extra })}`;
        kpis.push(
          {
            ...base,
            key: 'forms_received',
            label: 'Forms received',
            value: received,
            denominator: expected,
            definition: `Expected stations with at least one Form ${contest.formSeries}A submission (excluding drafts and archived records).`,
            href: inbox({}),
          },
          {
            ...base,
            key: 'form_verification_progress',
            label: 'Form verification progress',
            value: verified,
            denominator: expected,
            definition: `Stations with a canonical, two-person verified Form ${contest.formSeries}A ÷ expected stations in the approved registry. Missing stations are never counted as zero votes.`,
            href: inbox({ status: 'VERIFIED' }),
            breakdown: [
              { label: 'Missing', value: missing ?? 0, href: `/tally/results${qs({ ...cycleQ, status: 'MISSING' })}` },
              { label: 'Pending review', value: pending, href: inbox({ status: 'SECOND_REVIEW_PENDING' }) },
              { label: 'Returned, disputed or excluded', value: rejected, href: inbox({ status: 'RETURNED' }) },
              { label: 'Possible duplicates', value: duplicates, href: inbox({ duplicateOnly: 'true' }) },
            ],
            availability: expected === null ? 'NO_DATA' : 'AVAILABLE',
          },
          {
            ...base,
            key: 'awaiting_review',
            label: 'Awaiting second review',
            value: awaiting,
            denominator: null,
            definition: 'Submissions captured and waiting for an independent verifier.',
            href: inbox({ view: has('tally.verify') ? 'awaiting_me' : undefined, status: 'SECOND_REVIEW_PENDING' }),
          },
        );

        if (has('tally.discrepancy.view')) {
          const discScope: Prisma.DiscrepancyCaseWhereInput = tallyScope.orgWide ? {} : { links: { some: { submission: subScope } } };
          const discWhere: Prisma.DiscrepancyCaseWhereInput = { AND: [{ electionCycleId: cycle.id, status: { in: [...OPEN_DISCREPANCY] } }, discScope] };
          const open = await tx.discrepancyCase.count({ where: discWhere });
          kpis.push({
            ...base,
            key: 'open_discrepancies',
            label: 'Open discrepancies',
            value: open,
            denominator: null,
            definition: 'Discrepancy cases that are open, under review or escalated.',
            href: `/tally/discrepancies${qs({ electionCycleId: cycle.id, status: 'OPEN' })}`,
          });
          const cases = await tx.discrepancyCase.findMany({
            where: discWhere,
            orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
            take: 5,
            select: { id: true, reference: true, title: true, status: true, severity: true, createdAt: true },
          });
          priorityQueue = priorityQueue.concat(
            cases.map((c) => ({
              kind: 'OPEN_DISCREPANCY' as const,
              id: c.id,
              reference: c.reference,
              title: c.title,
              status: c.status,
              severity: c.severity,
              since: c.createdAt.toISOString(),
              href: `/tally/discrepancies/${c.id}`,
            })),
          );
        }

        if (has('tally.verify') || has('tally.approve')) {
          const subs = await tx.resultSubmission.findMany({
            where: { AND: [stationLevel, { status: 'SECOND_REVIEW_PENDING', submitterId: { not: auth.userId } }] },
            orderBy: { updatedAt: 'asc' },
            take: 5,
            select: { id: true, reference: true, status: true, updatedAt: true, formNumber: true, pollingStation: { select: { name: true, code: true } } },
          });
          const awaitingItems: DashboardQueueItem[] = subs.map((s) => ({
              kind: 'SUBMISSION_AWAITING_REVIEW' as const,
              id: s.id,
              reference: s.reference,
              title: `Form ${s.formNumber}${s.pollingStation ? ` · ${s.pollingStation.name} (${s.pollingStation.code})` : ''}`,
              status: s.status,
              severity: null,
              since: s.updatedAt.toISOString(),
              href: `/tally/verify/${s.id}`,
          }));
          priorityQueue = awaitingItems.concat(priorityQueue);
        }
      }

      // Agent coverage (blueprint 4.2): stations of the approved registry in the caller's
      // field deployment scope with a confirmed or checked-in chief / station agent.
      // Needs the field module and field.deployment.view; otherwise "not available".
      const fieldOn = cycle && registry && has('field.deployment.view') && (await this.modules.isEnabled(tx, 'field'));
      if (fieldOn) {
        const fieldScope = this.permissions.scopeFor(auth, 'field.deployment.view', cycle.id);
        const fieldStations: Prisma.PollingStationWhereInput = { AND: [{ registryVersionId: registry.id, status: { not: 'INACTIVE' } }, stationScopeWhere(fieldScope) ?? {}] };
        const planned = await tx.pollingStation.count({ where: fieldStations });
        const confirmedCodes = await tx.deployment.findMany({
          where: { electionCycleId: cycle.id, role: { in: ['CHIEF_AGENT', 'STATION_AGENT'] }, status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] } },
          select: { pollingStationCode: true },
          distinct: ['pollingStationCode'],
        });
        const covered = confirmedCodes.length
          ? await tx.pollingStation.count({ where: { AND: [fieldStations, { code: { in: confirmedCodes.map((d) => d.pollingStationCode) } }] } })
          : 0;
        kpis.push({
          ...base,
          key: 'agent_coverage',
          label: 'Agent deployment coverage',
          value: covered,
          denominator: planned,
          definition:
            'Approved-registry stations in your field scope with a confirmed or checked-in chief or station agent ÷ all such stations. Stations without one are not covered (never counted as zero agents reporting). Not a measure of voter preference or support.',
          href: '/field/deployment',
          availability: 'AVAILABLE',
        });
      } else {
        kpis.push({
          ...base,
          key: 'agent_coverage',
          label: 'Agent deployment coverage',
          value: null,
          denominator: expected,
          definition: 'Stations with a confirmed or checked-in chief or station agent ÷ approved-registry stations. Available when the field module is on, to holders of the field deployment view permission. Not a measure of voter preference or support.',
          href: null,
          availability: 'NOT_AVAILABLE',
        });
      }

      const recentActivity = await this.recentActivity(tx, auth);
      return {
        kpis,
        recentActivity,
        priorityQueue,
        electionCycle: cycle ? { id: cycle.id, name: cycle.name, dataProvenance: cycle.dataProvenance } : null,
        registryVersion: registry ? { id: registry.id, version: registry.version, stationCount: registry.stationCount } : null,
        contest: contest ? { id: contest.id, name: contest.name, officeType: contest.officeType, formSeries: contest.formSeries } : null,
        contests: contests.map((c) => ({ id: c.id, name: c.name })),
        generatedAt: asOf,
        includesTally,
        scoped: includesTally ? !tallyScope.orgWide : scope ? !scope.orgWide : false,
      };
    });
  }

  /** Audit viewers see the workspace feed; everyone else sees their own actions only. */
  private async recentActivity(tx: TenantTx, auth: AuthContext): Promise<DashboardActivity[]> {
    const rows = await tx.auditEvent.findMany({
      where: {
        ...(this.permissions.has(auth, 'audit.view') ? {} : { actorId: auth.userId }),
        NOT: { action: { startsWith: 'auth.' } },
      },
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: { seq: 'desc' },
      take: 10,
    });
    return rows.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      actor: e.actor ? { id: e.actor.id, displayName: e.actor.displayName } : null,
      reason: e.reason,
      occurredAt: e.occurredAt.toISOString(),
    }));
  }
}
