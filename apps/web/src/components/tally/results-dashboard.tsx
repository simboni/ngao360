'use client';

import {
  type Contest,
  type CandidateTotal,
  type Coverage,
  type ElectionCycle,
  EXPORT_FORMATS,
  type ExportFormat,
  type GeographyBreakdownRow,
  PARALLEL_TALLY_BANNER,
  PARALLEL_TALLY_DISCLAIMER,
  type ScopeType,
  type TallySnapshot,
} from '@ngao360/shared';
import {
  AlertTriangle,
  Ban,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  Download,
  FileInput,
  Flag,
  Home,
  Info,
  MapPin,
  RefreshCw,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiCard } from '@/components/ui/kpi-card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useTallyActions } from './action-provider';
import { ballotOrder, denominatorLabel, shareOfVerified } from './aggregate-math';
import { COVERAGE_LABELS, CoverageBadge } from './badges';
import { CandidateBarChart, CompletenessChart, CoverageBar, CoverageLegend } from './charts';
import { CycleContestSelect, useCycleContest } from './context-select';
import { describeError } from './errors';
import { SelectField } from './fields';
import { shortHash } from './file-hash';
import { Notice } from './notice';
import { tallyApi } from './tally-api';
import type { StationCoverageRow, StationCoverageStatus } from './types';
import { useAsync } from './use-async';

interface DrillLevel {
  id: string;
  name: string;
  type: ScopeType;
}

interface View {
  source: 'live' | 'snapshot';
  computedAt: string;
  calculationVersion: string;
  coverage: Coverage;
  totalVerifiedValidVotes: number;
  rejectedBallots: number;
  candidates: CandidateTotal[];
  includedStationCount: number;
  snapshot: TallySnapshot | null;
}

/** S21 Parallel tally dashboard (blueprint 8.6, 8.7, 11.2). */
export function ResultsDashboard() {
  const ctx = useCycleContest();
  return (
    <>
      <PageHeader
        title="Parallel tally"
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Parallel tally' }]}
        description="Internal aggregate of verified result forms only. Every figure shows the stations it includes against the approved registry; missing stations are never counted as zero."
      />
      <Card className="mb-4 p-4">
        <CycleContestSelect value={ctx} />
      </Card>
      {ctx.error ? <Notice tone="error">{describeError(ctx.error)}</Notice> : null}
      {ctx.cycle && ctx.contest ? (
        <ContestDashboard key={`${ctx.cycle.id}|${ctx.contest.id}`} cycle={ctx.cycle} contest={ctx.contest} />
      ) : !ctx.loading ? (
        <Card>
          <EmptyState title="Choose an election cycle and contest" description="No contest is configured for this cycle yet." />
        </Card>
      ) : null}
    </>
  );
}

function ContestDashboard({ cycle, contest }: { cycle: ElectionCycle; contest: Contest }) {
  const router = useRouter();
  const { can } = useAuth();
  const { run, askReason } = useTallyActions();
  const [drill, setDrill] = useState<DrillLevel[]>([]);
  const [snapshotId, setSnapshotId] = useState<string>('live');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = drill[drill.length - 1] ?? null;

  const baseQuery = {
    electionCycleId: cycle.id,
    contestId: contest.id,
    geographyScopeType: current?.type ?? ('ORGANISATION' as ScopeType),
    ...(current ? { geographicUnitId: current.id } : {}),
  };
  const queryKey = `${current?.id ?? 'root'}`;

  const live = useAsync(() => tallyApi.live(baseQuery), [queryKey]);
  const breakdown = useAsync(() => tallyApi.breakdown({ ...baseQuery, ...(current ? { parentUnitId: current.id } : {}) }), [queryKey]);
  const snapshots = useAsync(() => tallyApi.snapshots(cycle.id, contest.id), [cycle.id, contest.id]);
  const snapshotList = useMemo(
    () => (snapshots.data?.items ?? []).filter((s) => (s.geographicUnitId ?? null) === (current?.id ?? null)),
    [snapshots.data, current],
  );
  const selectedSnapshot = snapshotList.find((s) => s.id === snapshotId) ?? null;
  const latestSnapshot = snapshotList[0] ?? null;

  useEffect(() => {
    if (snapshotId !== 'live' && !snapshotList.some((s) => s.id === snapshotId)) setSnapshotId('live');
  }, [snapshotList, snapshotId]);

  const view: View | null = selectedSnapshot
    ? {
        source: 'snapshot',
        computedAt: selectedSnapshot.createdAt,
        calculationVersion: selectedSnapshot.calculationVersion,
        coverage: selectedSnapshot.coverage,
        totalVerifiedValidVotes: selectedSnapshot.totals.totalVerifiedValidVotes,
        rejectedBallots: selectedSnapshot.totals.rejectedBallots,
        candidates: selectedSnapshot.totals.candidates,
        includedStationCount: selectedSnapshot.includedSubmissionIds.length,
        snapshot: selectedSnapshot,
      }
    : live.data
      ? { source: 'live', ...live.data, snapshot: null }
      : null;

  const drillInto = async (row: GeographyBreakdownRow) => {
    if (!row.geographicUnitId) return;
    let type: ScopeType = 'ORGANISATION';
    try {
      type = (await tallyApi.geographicUnit(row.geographicUnitId)).type;
    } catch {
      // Type is informational; the unit id is what scopes the aggregate.
    }
    setDrill((d) => [...d, { id: row.geographicUnitId!, name: row.name, type }]);
    setSnapshotId('live');
  };

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const createSnapshot = () =>
    act('snapshot', async () => {
      const s = await run(() => tallyApi.createSnapshot({ ...baseQuery }));
      await snapshots.reload();
      setSnapshotId(s.id);
      setMessage(`Snapshot ${s.reference} created. It is immutable; new verified forms create a new snapshot.`);
    });

  const release = (s: TallySnapshot) =>
    act('release', async () => {
      const reason = await askReason({
        title: `Release snapshot ${s.reference} internally`,
        description: 'Makes this snapshot visible to authorised viewers in your organisation. This is not a public or official declaration.',
        confirmLabel: 'Release internally',
      });
      if (!reason) return;
      await run(() => tallyApi.releaseSnapshot(s.id, reason));
      await snapshots.reload();
      setMessage(`Snapshot ${s.reference} released to authorised internal viewers.`);
    });

  const exportSnapshot = (s: TallySnapshot, format: ExportFormat) =>
    act(`export-${format}`, async () => {
      const exp = await run(() => tallyApi.createExport({ snapshotId: s.id, format, includeStationRows: true }));
      const url = await run(() => tallyApi.exportDownloadUrl(exp.id));
      setMessage(`Export ready (${format}, SHA-256 ${shortHash(exp.sha256)}). It carries the disclaimer, snapshot reference, methodology and audit manifest.`);
      window.location.assign(url.url);
    });

  const exportTarget = selectedSnapshot ?? latestSnapshot;
  const openCases = live.data?.openDiscrepancyCount ?? 0;
  const loadError = live.error ?? breakdown.error;

  return (
    <div className="space-y-4">
      {/* Header: cycle, contest, status and snapshot identity */}
      <Card>
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="text-meta uppercase tracking-wide text-slate">{cycle.name}</p>
            <h2 className="text-section font-semibold text-navy">
              {contest.name} <span className="text-body font-normal text-slate">· Form {contest.formSeries} series</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="provenance" status={cycle.dataProvenance} />
              <StatusBadge kind="custom" status="parallel" label={PARALLEL_TALLY_BANNER} tone="pending" icon={Info} />
            </div>
            {view ? (
              <p className="text-meta text-slate">
                {view.source === 'snapshot' && view.snapshot ? (
                  <>
                    Snapshot <strong className="text-ink">{view.snapshot.reference}</strong> (ID <span className="font-mono">{view.snapshot.id}</span>) taken{' '}
                    {formatDateTime(view.snapshot.createdAt)} by {view.snapshot.createdBy.displayName} · content hash{' '}
                    <span className="font-mono" title={view.snapshot.contentHash}>
                      {shortHash(view.snapshot.contentHash, 16)}
                    </span>{' '}
                    · {view.snapshot.releasedAt ? `released internally ${formatDateTime(view.snapshot.releasedAt)}` : 'not released'}
                  </>
                ) : (
                  <>
                    Live view computed {formatDateTime(view.computedAt)} · not persisted
                    {latestSnapshot ? ` · latest snapshot ${latestSnapshot.reference} (${formatDateTime(latestSnapshot.createdAt)})` : ' · no snapshot yet'}
                  </>
                )}{' '}
                · calculation {view.calculationVersion}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label="View"
              className="w-72"
              value={snapshotId}
              onChange={(e) => setSnapshotId(e.target.value)}
              options={[
                { value: 'live', label: 'Live verified aggregate' },
                ...snapshotList.map((s) => ({ value: s.id, label: `${s.reference} · ${formatDateTime(s.createdAt)}${s.releasedAt ? ' · released' : ''}` })),
              ]}
            />
            <Button
              variant="secondary"
              onClick={() => {
                void live.reload();
                void breakdown.reload();
                void snapshots.reload();
              }}
              aria-label="Refresh"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
            {can('tally.snapshot.create') ? (
              <Button variant="secondary" onClick={() => void createSnapshot()} loading={busy === 'snapshot'}>
                <Camera className="h-4 w-4" aria-hidden /> Take snapshot
              </Button>
            ) : null}
            {can('tally.release') && selectedSnapshot && !selectedSnapshot.releasedAt ? (
              <Button variant="secondary" onClick={() => void release(selectedSnapshot)} loading={busy === 'release'}>
                <Send className="h-4 w-4" aria-hidden /> Release internally
              </Button>
            ) : null}
          </div>
        </CardBody>
        {can('tally.export') ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <span className="text-meta text-slate">
              {exportTarget ? `Export snapshot ${exportTarget.reference}:` : 'Take a snapshot to export. Exports are generated from immutable snapshots only.'}
            </span>
            {exportTarget
              ? EXPORT_FORMATS.map((f) => (
                  <Button key={f} size="sm" variant="secondary" onClick={() => void exportSnapshot(exportTarget, f)} loading={busy === `export-${f}`}>
                    <Download className="h-4 w-4" aria-hidden /> {f}
                  </Button>
                ))
              : null}
          </div>
        ) : null}
      </Card>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {loadError ? <Notice tone="error">{describeError(loadError)}</Notice> : null}

      {openCases > 0 ? (
        <Notice
          tone="warning"
          title={`${openCases} unresolved discrepancy case${openCases === 1 ? '' : 's'}`}
          action={
            <Link href={`/tally/discrepancies?cycle=${cycle.id}&contest=${contest.id}`} className="text-body font-medium text-deep-blue hover:underline">
              Review cases
            </Link>
          }
        >
          Records held in open cases are not in the verified totals until resolved.
        </Notice>
      ) : null}

      {/* Geography breadcrumb */}
      <nav aria-label="Geography drill-down" className="flex flex-wrap items-center gap-1 text-body">
        <button type="button" onClick={() => setDrill([])} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-cloud', !current && 'font-semibold text-navy')} aria-current={!current ? 'page' : undefined}>
          <Home className="h-4 w-4" aria-hidden /> Contest area
        </button>
        {drill.map((d, i) => (
          <span key={d.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-4 w-4 text-slate" aria-hidden />
            <button
              type="button"
              onClick={() => setDrill((s) => s.slice(0, i + 1))}
              className={cn('rounded px-1.5 py-0.5 hover:bg-cloud', i === drill.length - 1 && 'font-semibold text-navy')}
              aria-current={i === drill.length - 1 ? 'page' : undefined}
            >
              {d.name}
            </button>
          </span>
        ))}
      </nav>

      {view ? <CoverageStrip coverage={view.coverage} asOf={view.computedAt} /> : <p className="text-slate">Loading aggregate…</p>}

      {view ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <CandidateTotals view={view} />
          <Card>
            <CardHeader title="Completeness" description={current ? `Units within ${current.name}` : 'Units within the contest area'} />
            <CardBody>
              {breakdown.data && breakdown.data.rows.length > 0 ? (
                <CompletenessChart
                  rows={breakdown.data.rows.map((r) => ({ key: r.geographicUnitId ?? r.pollingStationId ?? r.code, name: `${r.code} ${r.name}`, coverage: r.coverage }))}
                />
              ) : (
                <p className="text-meta text-slate">{breakdown.loading ? 'Loading…' : 'No units at this level.'}</p>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      <BreakdownTable
        rows={breakdown.data?.rows ?? []}
        candidates={ballotOrder(live.data?.candidates ?? [])}
        loading={breakdown.loading && !breakdown.data}
        onDrill={(r) => void drillInto(r)}
        onStation={(r) => {
          if (r.pollingStationId) document.getElementById('station-table')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />

      <StationTable
        electionCycleId={cycle.id}
        contestId={contest.id}
        unit={current}
        candidates={ballotOrder(live.data?.candidates ?? [])}
        onOpen={(id) => router.push(`/tally/verify/${id}`)}
      />

      <p className="rounded-card border border-line bg-surface p-4 text-meta text-slate">{PARALLEL_TALLY_DISCLAIMER}</p>
    </div>
  );
}

function CoverageStrip({ coverage, asOf }: { coverage: Coverage; asOf: string }) {
  const of = `of ${formatNumber(coverage.expectedStations)} expected`;
  return (
    <section aria-label="Coverage" className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <KpiCard label="Expected stations" value={coverage.expectedStations} sublabel="Approved registry" icon={MapPin} asOf={asOf} />
        <KpiCard label="Received" value={coverage.received} sublabel={of} icon={FileInput} />
        <KpiCard label="Verified" value={coverage.verified} sublabel={`${coverage.verifiedPercent.toFixed(1)}% ${of}`} icon={CheckCircle2} />
        <KpiCard label="Pending review" value={coverage.awaitingReview} sublabel={of} icon={Clock} />
        <KpiCard label="Flagged" value={coverage.flagged} sublabel={of} icon={Flag} />
        <KpiCard label="Excluded" value={coverage.excluded} sublabel={of} icon={Ban} />
        <KpiCard label="Missing" value={coverage.missing} sublabel="No form yet — not zero votes" icon={CircleDashed} />
      </div>
      <CoverageBar coverage={coverage} label="Overall coverage" />
      <CoverageLegend />
    </section>
  );
}

function CandidateTotals({ view }: { view: View }) {
  const ordered = ballotOrder(view.candidates);
  return (
    <Card>
      <CardHeader
        title="Candidate totals (verified only)"
        description={
          <>
            <strong className="text-ink">{PARALLEL_TALLY_BANNER}.</strong> Included: {denominatorLabel(view.includedStationCount, view.coverage.expectedStations)}.
          </>
        }
      />
      <CardBody className="space-y-4">
        {view.includedStationCount === 0 ? (
          <EmptyState icon={AlertTriangle} title="No verified forms yet" description="Totals appear once forms pass independent second review. Missing stations are not shown as zero votes." />
        ) : (
          <CandidateBarChart candidates={ordered} totalVerifiedValid={view.totalVerifiedValidVotes} />
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">Verified votes by candidate</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta uppercase tracking-wide text-slate">
                <th scope="col" className="py-2 pr-2">
                  Ballot
                </th>
                <th scope="col" className="py-2 pr-2">
                  Candidate (as published)
                </th>
                <th scope="col" className="py-2 pr-2 text-right">
                  Verified votes
                </th>
                <th scope="col" className="py-2 text-right">
                  Share of verified valid votes
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((c) => {
                const share = shareOfVerified(c, view.totalVerifiedValidVotes);
                return (
                  <tr key={c.candidateReferenceId} className="border-b border-line">
                    <td className="py-2 pr-2 tabular-nums text-slate">{c.ballotOrder}</td>
                    <td className="py-2 pr-2">
                      {c.candidateNameAsPublished}
                      {c.partyLabel ? <span className="block text-meta text-slate">{c.partyLabel}</span> : null}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{view.includedStationCount ? formatNumber(c.verifiedVotes) : '—'}</td>
                    <td className="py-2 text-right tabular-nums">{share !== null ? `${share.toFixed(2)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="py-2 pr-2 text-left text-meta font-semibold text-slate">
                  Total verified valid votes
                </th>
                <td className="py-2 pr-2 text-right font-semibold tabular-nums">{view.includedStationCount ? formatNumber(view.totalVerifiedValidVotes) : '—'}</td>
                <td />
              </tr>
              <tr>
                <th scope="row" colSpan={2} className="py-1 pr-2 text-left text-meta font-semibold text-slate">
                  Rejected ballots (verified forms)
                </th>
                <td className="py-1 pr-2 text-right tabular-nums">{view.includedStationCount ? formatNumber(view.rejectedBallots) : '—'}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="text-meta text-slate">
          Included stations: {denominatorLabel(view.includedStationCount, view.coverage.expectedStations)}. Received, flagged, excluded and missing records are reported separately above and are not in these totals.
        </p>
      </CardBody>
    </Card>
  );
}

function BreakdownTable({
  rows,
  candidates,
  loading,
  onDrill,
  onStation,
}: {
  rows: GeographyBreakdownRow[];
  candidates: CandidateTotal[];
  loading: boolean;
  onDrill: (r: GeographyBreakdownRow) => void;
  onStation: (r: GeographyBreakdownRow) => void;
}) {
  const columns: Column<GeographyBreakdownRow>[] = [
    {
      key: 'name',
      header: 'Area / station',
      sortValue: (r) => r.name,
      cell: (r) =>
        r.geographicUnitId ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-left font-medium text-deep-blue hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onDrill(r);
            }}
          >
            {r.code} {r.name} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : (
          <span>
            <MapPin className="mr-1 inline h-3.5 w-3.5 text-slate" aria-hidden />
            {r.code} {r.name}
          </span>
        ),
    },
    {
      key: 'included',
      header: 'Included / expected',
      align: 'right',
      sortValue: (r) => r.coverage.verified,
      cell: (r) => `${formatNumber(r.coverage.verified)} / ${formatNumber(r.coverage.expectedStations)}`,
    },
    { key: 'missing', header: 'Missing', align: 'right', sortValue: (r) => r.coverage.missing, cell: (r) => formatNumber(r.coverage.missing) },
    { key: 'flagged', header: 'Flagged', align: 'right', sortValue: (r) => r.coverage.flagged, cell: (r) => formatNumber(r.coverage.flagged) },
    ...candidates.map<Column<GeographyBreakdownRow>>((c) => ({
      key: `cand-${c.candidateReferenceId}`,
      header: c.candidateNameAsPublished,
      align: 'right',
      cell: (r) => {
        const v = r.candidates.find((x) => x.candidateReferenceId === c.candidateReferenceId);
        return v ? formatNumber(v.verifiedVotes) : <span className="text-slate" title="No verified form">—</span>;
      },
    })),
  ];
  return (
    <section aria-labelledby="breakdown-title">
      <h2 id="breakdown-title" className="mb-2 text-section font-semibold text-navy">
        Geography drill-down
      </h2>
      <DataTable
        caption="Verified figures by area. A dash means no verified form, not zero votes."
        columns={columns}
        rows={rows}
        rowKey={(r) => r.geographicUnitId ?? r.pollingStationId ?? r.code}
        loading={loading}
        emptyTitle="No areas at this level"
        onRowClick={(r) => (r.geographicUnitId ? onDrill(r) : onStation(r))}
      />
      <p className="mt-1 text-meta text-slate">A dash (—) means no verified form for that area: it is not zero votes.</p>
    </section>
  );
}

const COVERAGE_FILTERS: StationCoverageStatus[] = ['MISSING', 'RECEIVED', 'VERIFIED', 'FLAGGED', 'EXCLUDED'];

function StationTable({
  electionCycleId,
  contestId,
  unit,
  candidates,
  onOpen,
}: {
  electionCycleId: string;
  contestId: string;
  unit: DrillLevel | null;
  candidates: CandidateTotal[];
  onOpen: (submissionId: string) => void;
}) {
  const [status, setStatus] = useState<StationCoverageStatus | ''>('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const searchId = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [status, debounced, unit?.id]);

  const list = useAsync(
    () =>
      tallyApi.stations({
        electionCycleId,
        contestId,
        geographyScopeType: unit?.type ?? 'ORGANISATION',
        ...(unit ? { geographicUnitId: unit.id } : {}),
        ...(status ? { status } : {}),
        ...(debounced ? { q: debounced } : {}),
        page,
        pageSize: 25,
      }),
    [electionCycleId, contestId, unit?.id, status, debounced, page],
  );

  const columns: Column<StationCoverageRow>[] = [
    {
      key: 'station',
      header: 'Polling station',
      cell: (r) => (
        <div>
          <div className="font-medium">
            {r.pollingStationCode} {r.pollingStationName}
          </div>
          <div className="text-meta text-slate">{[r.wardName, r.constituencyName].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    { key: 'coverage', header: 'Coverage', cell: (r) => <CoverageBadge status={r.coverageStatus} /> },
    {
      key: 'record',
      header: 'Source record',
      cell: (r) =>
        r.id ? (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-deep-blue">{r.reference}</span>
            {r.status ? <StatusBadge kind="submission" status={r.status} size="sm" /> : null}
          </div>
        ) : (
          <span className="text-meta text-slate">No form received</span>
        ),
    },
    ...candidates.map<Column<StationCoverageRow>>((c) => ({
      key: `c-${c.candidateReferenceId}`,
      header: c.candidateNameAsPublished,
      align: 'right',
      cell: (r) => {
        const v = r.candidateVotes?.[c.candidateReferenceId];
        return v === undefined || v === null ? <span className="text-slate">—</span> : formatNumber(v);
      },
    })),
  ];

  return (
    <section id="station-table" aria-labelledby="stations-title" className="scroll-mt-24">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stations-title" className="text-section font-semibold text-navy">
            Stations{unit ? ` in ${unit.name}` : ''}
          </h2>
          <p className="text-meta text-slate">Select a station with a form to inspect its source image, reviewer state and audit history.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Coverage"
            className="w-56"
            value={status}
            onChange={(e) => setStatus(e.target.value as StationCoverageStatus | '')}
            placeholder="All stations"
            options={COVERAGE_FILTERS.map((s) => ({ value: s, label: COVERAGE_LABELS[s] }))}
          />
          <div className="w-56">
            <label htmlFor={searchId} className="ngao-label">
              Search station
            </label>
            <input id={searchId} type="search" className="ngao-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" />
          </div>
        </div>
      </div>
      {list.error ? <Notice tone="error" className="mb-2">{describeError(list.error)}</Notice> : null}
      <DataTable
        caption="Stations with coverage status and verified figures"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => r.pollingStationId}
        loading={list.loading && !list.data}
        emptyTitle="No stations match"
        onRowClick={(r) => (r.id ? onOpen(r.id) : undefined)}
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />
    </section>
  );
}
