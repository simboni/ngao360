/**
 * Row sources for the report builder. One loader per REPORT_DATASETS entry;
 * nothing else is queryable. Every loader runs inside the caller's tenant
 * transaction (RLS) and puts the dataset scope into the Prisma `where`:
 *   - organisation: permission only (finance, audit, breaches);
 *   - geography: unit columns inside the permission's grant, cycle-limited
 *     grants only for their own cycle (incidents, tally coverage);
 *   - department_geography: the campaign department-scope rule.
 * Loaders map rows to the dataset's field keys only; the service then keeps
 * the caller's selected (permitted) fields.
 */
import type { Prisma, TenantTx } from '@ngao360/db';
import { type DatasetDefinition, type ReportDefinition } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { type PermissionScope, pathToUnitIds, scopeAllows, scopeFromGrants } from '../../../rbac/scope';
import {
  type CampaignScope,
  contentScopeWhere,
  eventScopeWhere,
  isoDate,
  loadCampaignScope,
  minorToNumber,
  taskScopeWhere,
} from '../common';

export type ReportRow = Record<string, string | number | boolean | string[] | null>;

export interface LoadedRows {
  rows: ReportRow[];
  /** Plain-language description of the scope applied. */
  appliedScope: string;
  /** More rows matched than the dataset's maxRows. */
  truncated: boolean;
}

const OPEN_TASK = new Set(['DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW']);
const PRIVILEGED_ACTION_PATTERNS = ['export', 'approv', 'role', 'reveal', 'contact_viewed', 'module', 'reauth', 'limit_setting', 'verified', 'finance.', 'security.'];
const VERIFIED_FORM_STATUSES = ['VERIFIED'];
const PENDING_FORM_STATUSES = ['SUBMITTED', 'OCR_COMPLETE', 'DATA_ENTRY_REVIEWED', 'SECOND_REVIEW_PENDING'];

function dateRange(def: ReportDefinition): { gte?: Date; lte?: Date } | undefined {
  if (!def.dateRange?.from && !def.dateRange?.to) return undefined;
  return { ...(def.dateRange.from ? { gte: new Date(def.dateRange.from) } : {}), ...(def.dateRange.to ? { lte: new Date(def.dateRange.to) } : {}) };
}

/** Geography area (flattened for one cycle when given) → Prisma OR over unit columns. */
function unitColumnsWhere(scope: PermissionScope, columns: readonly string[], cycleColumn: string | null): object | undefined {
  if (scope.orgWide) return undefined;
  const area = (unitIds: string[]) => (unitIds.length ? columns.map((c) => ({ [c]: { in: unitIds } })) : []);
  const parts: object[] = [...area(scope.unitIds)];
  if (cycleColumn) {
    for (const [cycleId, a] of Object.entries(scope.cycles ?? {})) {
      if (a.orgWide) parts.push({ [cycleColumn]: cycleId });
      else if (a.unitIds.length) parts.push({ AND: [{ [cycleColumn]: cycleId }, { OR: area(a.unitIds) }] });
    }
  }
  return parts.length ? { OR: parts } : { id: { in: [] } };
}

async function unitLabel(tx: TenantTx, id: string): Promise<string> {
  const u = await tx.geographicUnit.findUnique({ where: { id }, select: { officialName: true } });
  return u?.officialName ?? 'selected area';
}

async function scopeDescription(tx: TenantTx, geo: PermissionScope): Promise<string> {
  if (geo.orgWide) return 'Organisation-wide';
  const ids = [...geo.unitIds, ...Object.values(geo.cycles ?? {}).flatMap((c) => c.unitIds)];
  if (!ids.length) return 'No geography granted';
  const units = await tx.geographicUnit.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { officialName: true } });
  return `Your areas: ${units.map((u) => u.officialName).join(', ')}`;
}

/**
 * Narrowing named in the definition: the area must be inside the caller's
 * grant and the department one of the caller's (403 OUT_OF_SCOPE).
 */
export async function assertNarrowingInScope(tx: TenantTx, auth: AuthContext, ds: DatasetDefinition, def: ReportDefinition): Promise<string[]> {
  const notes: string[] = [];
  if (def.geographicUnitId) {
    if (ds.scope.kind === 'organisation' && !ds.scope.geographyColumn) {
      throw AppException.validation('This dataset cannot be narrowed by area', [{ path: ['geographicUnitId'], message: 'Not supported' }]);
    }
    const unit = await tx.geographicUnit.findUnique({ where: { id: def.geographicUnitId }, select: { path: true, officialName: true } });
    if (!unit) throw AppException.validation('Unknown area', [{ path: ['geographicUnitId'], message: 'Unknown' }]);
    const geo = scopeFromGrants(auth.grants, ds.permission);
    if (!scopeAllows(geo, { unitIds: pathToUnitIds(unit.path), stationId: null, ...(def.electionCycleId ? { electionCycleId: def.electionCycleId } : {}) })) {
      throw AppException.outOfScope('This area is outside your assigned geography');
    }
    notes.push(unit.officialName);
  }
  if (def.departmentId) {
    const dept = await tx.department.findUnique({ where: { id: def.departmentId }, select: { name: true } });
    if (!dept) throw AppException.validation('Unknown department', [{ path: ['departmentId'], message: 'Unknown' }]);
    if (ds.scope.kind === 'department_geography') {
      const scope = await loadCampaignScope(tx, auth, ds.permission);
      if (!scope.allDepartments && !scope.departmentIds.includes(def.departmentId)) throw AppException.outOfScope('This department is not one of yours');
    }
    notes.push(`${dept.name} department`);
  }
  return notes;
}

function campaignScopeLabel(scope: CampaignScope, geoLabel: string): string {
  const dept = scope.allDepartments ? 'all departments' : `your ${scope.departmentIds.length} department(s)`;
  return `Records you are involved in, plus ${dept} within ${geoLabel === 'Organisation-wide' ? 'the whole organisation' : geoLabel.replace('Your areas: ', '')}`;
}

/* --------------------------------------------------------------------------- */

type Loader = (tx: TenantTx, auth: AuthContext, ds: DatasetDefinition, def: ReportDefinition) => Promise<LoadedRows>;

const loadTasks: Loader = async (tx, auth, ds, def) => {
  const scope = await loadCampaignScope(tx, auth, ds.permission);
  const range = dateRange(def);
  const where: Prisma.TaskWhereInput = {
    AND: [
      taskScopeWhere(scope) ?? {},
      range ? { dueAt: range } : {},
      def.departmentId ? { departmentId: def.departmentId } : {},
      def.geographicUnitId ? { geographicUnit: { path: { contains: `/${def.geographicUnitId}/` } } } : {},
    ],
  };
  const rows = await tx.task.findMany({
    where,
    include: { owner: { select: { displayName: true } }, department: { select: { name: true } }, team: { select: { name: true } }, geographicUnit: { select: { officialName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: ds.maxRows + 1,
  });
  const now = Date.now();
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: campaignScopeLabel(scope, await scopeDescription(tx, scope.geo)),
    rows: rows.slice(0, ds.maxRows).map((t) => ({
      reference: t.reference,
      title: t.title,
      status: t.status,
      priority: t.priority,
      ownerName: t.owner.displayName,
      departmentName: t.department?.name ?? null,
      teamName: t.team?.name ?? null,
      geographyName: t.geographicUnit?.officialName ?? null,
      dueAt: t.dueAt?.toISOString() ?? null,
      isOverdue: !!t.dueAt && t.dueAt.getTime() < now && OPEN_TASK.has(t.status),
      completedAt: t.completedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
  };
};

const loadEvents: Loader = async (tx, auth, ds, def) => {
  const scope = await loadCampaignScope(tx, auth, ds.permission);
  const range = dateRange(def);
  const rows = await tx.campaignEvent.findMany({
    where: {
      AND: [
        eventScopeWhere(scope) ?? {},
        range ? { startsAt: range } : {},
        def.departmentId ? { departmentId: def.departmentId } : {},
        def.geographicUnitId ? { geographicUnit: { path: { contains: `/${def.geographicUnitId}/` } } } : {},
      ],
    },
    include: {
      organiser: { select: { displayName: true } },
      department: { select: { name: true } },
      geographicUnit: { select: { officialName: true } },
      afterActionReport: { select: { status: true, actualSpendMinor: true } },
      _count: { select: { attendances: true } },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: ds.maxRows + 1,
  });
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: campaignScopeLabel(scope, await scopeDescription(tx, scope.geo)),
    rows: rows.slice(0, ds.maxRows).map((e) => ({
      reference: e.reference,
      title: e.title,
      type: e.type,
      status: e.status,
      startsAt: e.startsAt.toISOString(),
      venueName: e.venueName,
      geographyName: e.geographicUnit?.officialName ?? null,
      departmentName: e.department?.name ?? null,
      organiserName: e.organiser.displayName,
      attendanceCount: e._count.attendances,
      afterActionStatus: e.afterActionReport?.status ?? null,
      budgetMinor: minorToNumber(e.budgetMinor),
      actualSpendMinor: minorToNumber(e.afterActionReport?.actualSpendMinor ?? null),
    })),
  };
};

const loadContent: Loader = async (tx, auth, ds, def) => {
  const scope = await loadCampaignScope(tx, auth, ds.permission);
  const range = dateRange(def);
  const rows = await tx.contentItem.findMany({
    where: { AND: [contentScopeWhere(scope) ?? {}, range ? { publishedAt: range } : {}, def.departmentId ? { departmentId: def.departmentId } : {}] },
    include: { author: { select: { displayName: true } }, approver: { select: { displayName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: ds.maxRows + 1,
  });
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: scope.allDepartments ? 'All departments' : `Content you worked on, plus your ${scope.departmentIds.length} department(s)`,
    rows: rows.slice(0, ds.maxRows).map((c) => ({
      reference: c.reference,
      type: c.type,
      title: c.title,
      status: c.status,
      audience: c.audience,
      authorName: c.author.displayName,
      approverName: c.approver?.displayName ?? null,
      publishedAt: c.publishedAt?.toISOString() ?? null,
      correctionCount: c.correctionCount,
    })),
  };
};

function dateOnlyRange(def: ReportDefinition): { gte?: Date; lte?: Date } | undefined {
  const r = dateRange(def);
  if (!r) return undefined;
  return { ...(r.gte ? { gte: new Date(`${r.gte.toISOString().slice(0, 10)}T00:00:00Z`) } : {}), ...(r.lte ? { lte: new Date(`${r.lte.toISOString().slice(0, 10)}T00:00:00Z`) } : {}) };
}

const TX_INCLUDE = {
  account: { select: { name: true } },
  counterAccount: { select: { name: true } },
  category: { select: { name: true } },
  payee: { select: { name: true } },
  contributionSource: { select: { displayName: true, kind: true, identifierMasked: true, declared: true } },
  department: { select: { name: true } },
  requestedBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
  paidBy: { select: { displayName: true } },
} satisfies Prisma.FinanceTransactionInclude;

const loadTransactions = (contributionsOnly: boolean): Loader => async (tx, _auth, ds, def) => {
  const range = dateOnlyRange(def);
  const rows = await tx.financeTransaction.findMany({
    where: {
      AND: [
        contributionsOnly ? { type: 'CONTRIBUTION' } : {},
        range ? { transactionDate: range } : {},
        def.departmentId ? { departmentId: def.departmentId } : {},
        def.electionCycleId ? { electionCycleId: def.electionCycleId } : {},
      ],
    },
    include: TX_INCLUDE,
    orderBy: [{ transactionDate: 'asc' }, { reference: 'asc' }],
    take: ds.maxRows + 1,
  });
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: 'Organisation-wide (finance)',
    rows: rows.slice(0, ds.maxRows).map((t): ReportRow =>
      contributionsOnly
        ? {
            reference: t.reference,
            transactionDate: isoDate(t.transactionDate),
            status: t.status,
            contributorName: t.contributionSource?.displayName ?? null,
            contributorKind: t.contributionSource?.kind ?? null,
            identifierMasked: t.contributionSource?.identifierMasked ?? null,
            declared: t.contributionSource?.declared ?? false,
            amountMinor: minorToNumber(t.amountMinor),
            complianceFlags: t.complianceFlags,
          }
        : {
            reference: t.reference,
            type: t.type,
            status: t.status,
            transactionDate: isoDate(t.transactionDate),
            amountMinor: minorToNumber(t.amountMinor),
            currency: t.currency,
            categoryName: t.category.name,
            accountName: t.account.name,
            counterpartyName: t.payee?.name ?? t.contributionSource?.displayName ?? t.counterAccount?.name ?? null,
            externalReference: t.externalReference,
            departmentName: t.department?.name ?? null,
            requestedByName: t.requestedBy.displayName,
            approvedByName: t.approvedBy?.displayName ?? null,
            paidByName: t.paidBy?.displayName ?? null,
            complianceFlags: t.complianceFlags,
          },
    ),
  };
};

/** Posted expenses (net of reversals) and requested commitments per budget line. */
export async function budgetActuals(tx: TenantTx, lineIds: string[]): Promise<Map<string, { actual: bigint; committed: bigint }>> {
  const out = new Map<string, { actual: bigint; committed: bigint }>();
  if (!lineIds.length) return out;
  const rows = await tx.financeTransaction.groupBy({
    by: ['budgetLineId', 'status'],
    where: { budgetLineId: { in: lineIds }, type: 'EXPENSE', status: { in: ['REQUESTED', 'APPROVED', 'PAID'] } },
    _sum: { amountMinor: true },
  });
  for (const r of rows) {
    if (!r.budgetLineId) continue;
    const cur = out.get(r.budgetLineId) ?? { actual: 0n, committed: 0n };
    const v = r._sum.amountMinor ?? 0n;
    if (r.status === 'REQUESTED') cur.committed += v;
    else cur.actual += v;
    out.set(r.budgetLineId, cur);
  }
  return out;
}

const loadBudget: Loader = async (tx, _auth, ds, def) => {
  const range = dateOnlyRange(def);
  const lines = await tx.financeBudgetLine.findMany({
    where: {
      AND: [
        range ? { periodStart: range } : {},
        def.departmentId ? { departmentId: def.departmentId } : {},
        def.electionCycleId ? { electionCycleId: def.electionCycleId } : {},
      ],
    },
    include: { department: { select: { name: true } }, event: { select: { reference: true } } },
    orderBy: [{ code: 'asc' }],
    take: ds.maxRows + 1,
  });
  const sums = await budgetActuals(tx, lines.map((l) => l.id));
  return {
    truncated: lines.length > ds.maxRows,
    appliedScope: 'Organisation-wide (finance)',
    rows: lines.slice(0, ds.maxRows).map((l) => {
      const s = sums.get(l.id) ?? { actual: 0n, committed: 0n };
      return {
        code: l.code,
        name: l.name,
        departmentName: l.department?.name ?? null,
        eventReference: l.event?.reference ?? null,
        periodStart: isoDate(l.periodStart),
        budgetMinor: minorToNumber(l.amountMinor),
        actualMinor: minorToNumber(s.actual),
        committedMinor: minorToNumber(s.committed),
        varianceMinor: minorToNumber(l.amountMinor - s.actual),
      };
    }),
  };
};

const loadIncidents: Loader = async (tx, auth, ds, def) => {
  const scope = scopeFromGrants(auth.grants, ds.permission);
  const range = dateRange(def);
  const cols = ['countyId', 'constituencyId', 'wardId', 'pollingCentreId', 'geographicUnitId'];
  const rows = await tx.incident.findMany({
    where: {
      AND: [
        unitColumnsWhere(scope, cols, 'electionCycleId') ?? {},
        range ? { reportedAt: range } : {},
        def.electionCycleId ? { electionCycleId: def.electionCycleId } : {},
        def.geographicUnitId ? { OR: cols.map((c) => ({ [c]: def.geographicUnitId })) } : {},
      ],
    },
    select: { reference: true, category: true, severity: true, status: true, reportedAt: true, constituencyId: true, wardId: true },
    orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
    take: ds.maxRows + 1,
  });
  const unitIds = [...new Set(rows.flatMap((r) => [r.constituencyId, r.wardId]).filter((v): v is string => !!v))];
  const names = new Map((await tx.geographicUnit.findMany({ where: { id: { in: unitIds } }, select: { id: true, officialName: true } })).map((u) => [u.id, u.officialName]));
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: await scopeDescription(tx, scope),
    rows: rows.slice(0, ds.maxRows).map((r) => ({
      reference: r.reference,
      category: r.category,
      severity: r.severity,
      status: r.status,
      reportedAt: r.reportedAt.toISOString(),
      constituencyName: r.constituencyId ? (names.get(r.constituencyId) ?? null) : null,
      wardName: r.wardId ? (names.get(r.wardId) ?? null) : null,
    })),
  };
};

/**
 * Form coverage per contest and ward (internal parallel tally, unofficial):
 * expected = stations of the approved registry inside the contest area and the
 * caller's scope for that cycle; verified = stations (by code) with a canonical
 * VERIFIED station-level form; pending = with a form in review; missing = the rest
 * (never counted as zero votes).
 */
const loadCoverage: Loader = async (tx, auth, ds, def) => {
  const cycle = def.electionCycleId
    ? await tx.electionCycle.findUnique({ where: { id: def.electionCycleId } })
    : ((await tx.electionCycle.findFirst({ where: { status: 'ACTIVE' }, orderBy: { electionDate: 'desc' } })) ??
      (await tx.electionCycle.findFirst({ where: { status: { not: 'ARCHIVED' } }, orderBy: { electionDate: 'desc' } })));
  const scope = scopeFromGrants(auth.grants, ds.permission, cycle?.id ?? null);
  if (!cycle) return { rows: [], truncated: false, appliedScope: 'No election cycle' };
  const registry = await tx.registryVersion.findFirst({ where: { electionCycleId: cycle.id, status: 'APPROVED' }, orderBy: { approvedAt: 'desc' } });
  if (!registry) return { rows: [], truncated: false, appliedScope: `${cycle.name}: no approved station registry` };
  const contests = await tx.contest.findMany({ where: { electionCycleId: cycle.id }, select: { id: true, name: true, officeType: true, geographicUnitId: true }, orderBy: { name: 'asc' } });
  const asOf = new Date().toISOString();
  const scopeWhere = unitColumnsWhere(scope, ['countyId', 'constituencyId', 'wardId', 'pollingCentreId'], null);
  const out: ReportRow[] = [];
  for (const c of contests) {
    const area: Prisma.PollingStationWhereInput = !c.geographicUnitId
      ? {}
      : c.officeType === 'NATIONAL_ASSEMBLY'
        ? { constituencyId: c.geographicUnitId }
        : c.officeType === 'COUNTY_ASSEMBLY'
          ? { wardId: c.geographicUnitId }
          : c.officeType === 'PRESIDENT'
            ? {}
            : { countyId: c.geographicUnitId };
    const stations = await tx.pollingStation.findMany({
      where: {
        AND: [
          { registryVersionId: registry.id, status: { not: 'INACTIVE' } },
          area,
          (scopeWhere ?? {}) as Prisma.PollingStationWhereInput,
          def.geographicUnitId ? { OR: [{ countyId: def.geographicUnitId }, { constituencyId: def.geographicUnitId }, { wardId: def.geographicUnitId }] } : {},
        ],
      },
      select: { code: true, constituencyId: true, wardId: true },
    });
    if (!stations.length) continue;
    const forms = await tx.resultSubmission.findMany({
      where: { electionCycleId: cycle.id, contestId: c.id, formTemplate: { formLevel: 'POLLING_STATION' }, pollingStationId: { not: null } },
      select: { status: true, isCanonical: true, pollingStation: { select: { code: true } } },
    });
    const verified = new Set<string>();
    const pending = new Set<string>();
    for (const f of forms) {
      const code = f.pollingStation?.code;
      if (!code) continue;
      if (VERIFIED_FORM_STATUSES.includes(f.status) && f.isCanonical) verified.add(code);
      else if (PENDING_FORM_STATUSES.includes(f.status)) pending.add(code);
    }
    const groups = new Map<string, { constituencyId: string; wardId: string; expected: number; verified: number; pending: number }>();
    for (const s of stations) {
      const k = `${s.constituencyId}:${s.wardId}`;
      const g = groups.get(k) ?? { constituencyId: s.constituencyId, wardId: s.wardId, expected: 0, verified: 0, pending: 0 };
      g.expected += 1;
      if (verified.has(s.code)) g.verified += 1;
      else if (pending.has(s.code)) g.pending += 1;
      groups.set(k, g);
    }
    const ids = [...new Set([...groups.values()].flatMap((g) => [g.constituencyId, g.wardId]))];
    const names = new Map((await tx.geographicUnit.findMany({ where: { id: { in: ids } }, select: { id: true, officialName: true } })).map((u) => [u.id, u.officialName]));
    for (const g of groups.values()) {
      out.push({
        contestName: c.name,
        constituencyName: names.get(g.constituencyId) ?? null,
        wardName: names.get(g.wardId) ?? null,
        expectedStations: g.expected,
        verifiedStations: g.verified,
        pendingStations: g.pending,
        missingStations: g.expected - g.verified - g.pending,
        asOf,
      });
    }
  }
  return { rows: out.slice(0, ds.maxRows), truncated: out.length > ds.maxRows, appliedScope: `${cycle.name}; ${await scopeDescription(tx, scope)}` };
};

const loadAudit: Loader = async (tx, _auth, ds, def) => {
  const range = dateRange(def);
  const rows = await tx.auditEvent.findMany({
    where: { AND: [{ OR: PRIVILEGED_ACTION_PATTERNS.map((p) => ({ action: { contains: p } })) }, range ? { occurredAt: range } : {}] },
    select: { occurredAt: true, action: true, entityType: true, entityId: true, actor: { select: { displayName: true } } },
    orderBy: [{ occurredAt: 'desc' }],
    take: ds.maxRows + 1,
  });
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: 'Organisation-wide (audit trail)',
    rows: rows.slice(0, ds.maxRows).map((r) => ({
      occurredAt: r.occurredAt.toISOString(),
      actorName: r.actor?.displayName ?? 'System',
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
    })),
  };
};

const loadBreaches: Loader = async (tx, _auth, ds, def) => {
  const range = dateRange(def);
  const rows = await tx.breachRecord.findMany({ where: range ? { detectedAt: range } : {}, orderBy: [{ detectedAt: 'asc' }], take: ds.maxRows + 1 });
  return {
    truncated: rows.length > ds.maxRows,
    appliedScope: 'Organisation-wide (breach register)',
    rows: rows.slice(0, ds.maxRows).map((r) => ({
      reference: r.reference,
      title: r.title,
      status: r.status,
      severity: r.severity,
      isDrill: r.isDrill,
      detectedAt: r.detectedAt.toISOString(),
      regulatorNotifiedAt: r.regulatorNotifiedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
    })),
  };
};

const LOADERS: Record<string, Loader> = {
  'campaign.tasks': loadTasks,
  'campaign.events': loadEvents,
  'campaign.content': loadContent,
  'finance.transactions': loadTransactions(false),
  'finance.contributions': loadTransactions(true),
  'finance.budget_vs_actual': loadBudget,
  'field.incidents': loadIncidents,
  'tally.form_coverage': loadCoverage,
  'audit.privileged_actions': loadAudit,
  'security.breaches': loadBreaches,
};

export async function loadDatasetRows(tx: TenantTx, auth: AuthContext, ds: DatasetDefinition, def: ReportDefinition): Promise<LoadedRows> {
  const loader = LOADERS[ds.key];
  if (!loader) throw AppException.validation('Unknown dataset', [{ path: ['datasetKey'], message: 'Unknown' }]);
  const loaded = await loader(tx, auth, ds, def);
  const narrowing: string[] = [];
  if (def.geographicUnitId) narrowing.push(`area ${await unitLabel(tx, def.geographicUnitId)}`);
  return { ...loaded, appliedScope: narrowing.length ? `${loaded.appliedScope}; narrowed to ${narrowing.join(', ')}` : loaded.appliedScope };
}
