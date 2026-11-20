'use client';

import type { CreateRegistryVersion, Paginated, PollingStation, PollingStationStatus, RegistryVersion } from '@ngao360/shared';
import type { RegistryImportOutcome } from '@ngao360/shared/dist/reference';
import { Archive, CheckCircle2, CircleDashed, Clock, FileText, MapPin, Plus, Upload } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { type Column, DataTable, type SortState } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog, Field, Notice, SelectInput, TextInput } from '@/components/admin/primitives';
import { ReasonDialog, useHighRisk } from '@/components/admin/reauth';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import { EMPTY_GEO, type GeoSelection, GeographyFilter } from './geography-filter';
import { ImportReportView } from './import-report';
import { RegistryImportDialog } from './registry-import-dialog';
import { defaultCycle, useElectionCycles } from './reference-api';

const PAGE_SIZE = 50;

const VERSION_BADGE = {
  DRAFT: { label: 'Draft', tone: 'muted', icon: CircleDashed },
  APPROVED: { label: 'Approved', tone: 'success', icon: CheckCircle2 },
  SUPERSEDED: { label: 'Superseded', tone: 'muted', icon: Archive },
} as const;

const STATION_STATUS = {
  ACTIVE: { label: 'Active', tone: 'success', icon: CheckCircle2 },
  INACTIVE: { label: 'Inactive', tone: 'muted', icon: Archive },
  PENDING_VERIFICATION: { label: 'Pending verification', tone: 'pending', icon: Clock },
} as const;

function CreateVersionDialog({ open, onClose, electionCycleId, onCreated }: { open: boolean; onClose: () => void; electionCycleId: string; onCreated: (v: RegistryVersion) => void }) {
  const [version, setVersion] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setVersion('');
      setSource('');
      setNotes('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: CreateRegistryVersion = { electionCycleId, version, source, ...(notes ? { notes } : {}) };
      onCreated(await api.post<RegistryVersion>('/reference/registry-versions', body));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="New registry version" description="Create a draft version, then import the station list into it.">
      <form onSubmit={submit}>
        <Field label="Version label" htmlFor="rv-version" hint="For example 2027-r2" required>
          <TextInput id="rv-version" value={version} onChange={(e) => setVersion(e.target.value)} required maxLength={64} />
        </Field>
        <Field label="Source" htmlFor="rv-source" hint="Publisher and document, e.g. IEBC gazetted list of polling stations" required>
          <TextInput id="rv-source" value={source} onChange={(e) => setSource(e.target.value)} required maxLength={500} />
        </Field>
        <Field label="Notes" htmlFor="rv-notes">
          <TextInput id="rv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!version || !source}>
            Create draft
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportStatusDialog({ version, onClose }: { version: RegistryVersion | null; onClose: () => void }) {
  const status = useApiQuery<RegistryImportOutcome>(version ? `import-status:${version.id}` : null, (signal) => api.get<RegistryImportOutcome>(`/reference/registry-versions/${version!.id}/import-status`, { signal }));
  return (
    <Dialog open={version !== null} onClose={onClose} size="lg" title={`Import report · version ${version?.version ?? ''}`}>
      {status.error ? <Notice tone="info">{describeError(status.error)}</Notice> : null}
      {status.data ? (
        <>
          <p className="mb-3 text-body text-slate">
            Status: <strong className="text-ink">{status.data.status.toLowerCase()}</strong> · {formatNumber(status.data.stationsCreated)} stations, {formatNumber(status.data.unitsCreated)} units created
            {status.data.report.sourceMetadata.sourceFileSha256 ? (
              <>
                {' '}
                · file SHA-256 <span className="break-all font-mono text-[11px]">{status.data.report.sourceMetadata.sourceFileSha256}</span>
              </>
            ) : null}
          </p>
          <ImportReportView report={status.data.report} />
        </>
      ) : status.loading ? (
        <div className="h-40 animate-pulse rounded-card bg-cloud" />
      ) : null}
    </Dialog>
  );
}

/** S12 Station registry: versions and import history, hierarchical filter, CSV import with validation preview, approval. */
export function StationRegistry() {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const router = useRouter();
  const params = useSearchParams();
  const cycles = useElectionCycles();
  const [cycleId, setCycleId] = useState(params.get('electionCycleId') ?? '');
  const [versionId, setVersionId] = useState(params.get('registryVersionId') ?? '');
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState<PollingStationStatus | ''>('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<RegistryVersion | null>(null);
  const [reportFor, setReportFor] = useState<RegistryVersion | null>(null);
  const [approving, setApproving] = useState<RegistryVersion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!cycleId && cycles.data) setCycleId(defaultCycle(cycles.data)?.id ?? '');
  }, [cycles.data, cycleId]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [debouncedQ, status, geo, versionId, cycleId]);

  const cycle = cycles.data?.find((c) => c.id === cycleId) ?? null;
  const versions = useApiQuery<Paginated<RegistryVersion>>(cycleId ? `versions:${cycleId}` : null, (signal) =>
    api.get<Paginated<RegistryVersion>>('/reference/registry-versions', { query: { electionCycleId: cycleId, pageSize: 100 }, signal }),
  );
  const versionList = versions.data?.items ?? [];
  const approved = versionList.find((v) => v.status === 'APPROVED') ?? null;
  const activeVersion = versionList.find((v) => v.id === versionId) ?? approved ?? versionList[0] ?? null;

  const stationKey = cycleId && activeVersion ? `stations:${cycleId}:${activeVersion.id}:${JSON.stringify(geo)}:${debouncedQ}:${status}:${page}:${sort?.key}:${sort?.order}` : null;
  const stations = useApiQuery<Paginated<PollingStation>>(stationKey, (signal) =>
    api.get<Paginated<PollingStation>>('/reference/polling-stations', {
      query: {
        electionCycleId: cycleId,
        registryVersionId: activeVersion!.id,
        countyId: geo.countyId ?? undefined,
        constituencyId: geo.constituencyId ?? undefined,
        wardId: geo.wardId ?? undefined,
        pollingCentreId: geo.pollingCentreId ?? undefined,
        q: debouncedQ || undefined,
        status: status || undefined,
        page,
        pageSize: PAGE_SIZE,
        sort: sort?.key,
        order: sort?.order ?? 'asc',
      },
      signal,
    }),
  );

  const selectVersion = (id: string) => {
    setVersionId(id);
    const next = new URLSearchParams(params.toString());
    next.set('registryVersionId', id);
    if (cycleId) next.set('electionCycleId', cycleId);
    router.replace(`/reference/stations?${next}`, { scroll: false });
  };

  const columns: Column<PollingStation>[] = [
    { key: 'code', header: 'Code', sortValue: (s) => s.code, cell: (s) => <span className="font-mono text-meta">{s.code}</span>, width: '140px' },
    {
      key: 'name',
      header: 'Station',
      sortValue: (s) => s.name,
      cell: (s) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {s.name}
            {s.streamNumber ? <span className="text-slate"> · stream {s.streamNumber}</span> : null}
          </p>
          {s.pollingCentreName ? <p className="text-meta text-slate">{s.pollingCentreName}</p> : null}
        </div>
      ),
    },
    {
      key: 'parents',
      header: 'County › Constituency › Ward',
      cell: (s) => <span className="text-meta text-slate">{[s.countyName, s.constituencyName, s.wardName].filter(Boolean).join(' › ')}</span>,
    },
    { key: 'registeredVoters', header: 'Registered voters', align: 'right', sortValue: (s) => s.registeredVoters, cell: (s) => (s.registeredVoters === null ? <span className="text-slate">Not published</span> : formatNumber(s.registeredVoters)) },
    {
      key: 'status',
      header: 'Status',
      sortValue: (s) => s.status,
      cell: (s) => {
        const spec = STATION_STATUS[s.status];
        return <StatusBadge kind="custom" status={s.status} label={spec.label} tone={spec.tone} icon={spec.icon} size="sm" />;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Station registry"
        description="Election geography from county to polling station. The approved version is the denominator for coverage and tally progress."
        breadcrumbs={[{ label: 'Reference data' }, { label: 'Station registry' }]}
        status={cycle ? <StatusBadge kind="provenance" status={cycle.dataProvenance} /> : null}
        actions={
          <>
            {(cycles.data?.length ?? 0) > 1 ? (
              <label className="flex items-center gap-2 text-meta text-slate">
                <span>Election cycle</span>
                <SelectInput className="h-9 w-56" value={cycleId} onChange={(e) => { setCycleId(e.target.value); setVersionId(''); setGeo(EMPTY_GEO); }}>
                  {(cycles.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectInput>
              </label>
            ) : null}
            {can('reference.import') && cycleId ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden /> New version
              </Button>
            ) : null}
          </>
        }
      />
      {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
      {cycles.error ? <Notice tone="danger" className="mb-4">{describeError(cycles.error)}</Notice> : null}
      {cycles.data && cycles.data.length === 0 ? (
        <Card>
          <EmptyState icon={MapPin} title="No election cycle yet" description="Create an election cycle before importing a station registry." />
        </Card>
      ) : null}

      {cycleId ? (
        <Card className="mb-4">
          <CardHeader title="Registry versions and import history" description="Each import creates a versioned, immutable record with its source file hash and validation report." />
          {versions.error ? <Notice tone="danger" className="m-4">{describeError(versions.error)}</Notice> : null}
          {versionList.length === 0 && !versions.loading ? (
            <EmptyState icon={FileText} title="No registry versions" description={can('reference.import') ? 'Create a draft version and import the station list from a CSV file.' : 'An importer has not loaded a registry for this cycle yet.'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <caption className="sr-only">Registry versions</caption>
                <thead className="bg-cloud text-left text-meta uppercase tracking-wide text-slate">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">Version</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Source</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-2 text-right font-semibold">Stations</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Imported</th>
                    <th scope="col" className="px-4 py-2 font-semibold">Approved</th>
                    <th scope="col" className="px-4 py-2 font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versionList.map((v) => {
                    const spec = VERSION_BADGE[v.status];
                    const isActive = activeVersion?.id === v.id;
                    return (
                      <tr key={v.id} className={cn('h-row border-t border-line', isActive && 'bg-teal/5')}>
                        <td className="px-4">
                          <button type="button" className="font-medium text-teal hover:underline" onClick={() => selectVersion(v.id)} aria-pressed={isActive}>
                            {v.version}
                          </button>
                        </td>
                        <td className="max-w-[280px] truncate px-4 text-slate" title={v.source}>
                          {v.source}
                        </td>
                        <td className="px-4">
                          <StatusBadge kind="custom" status={v.status} label={spec.label} tone={spec.tone} icon={spec.icon} size="sm" />
                        </td>
                        <td className="px-4 text-right tabular-nums">{formatNumber(v.stationCount)}</td>
                        <td className="whitespace-nowrap px-4 text-meta text-slate">{formatDateTime(v.importedAt)}</td>
                        <td className="whitespace-nowrap px-4 text-meta text-slate">{formatDateTime(v.approvedAt)}</td>
                        <td className="whitespace-nowrap px-4 text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setReportFor(v)}>
                              Report
                            </Button>
                            {v.status === 'DRAFT' && v.stationCount === 0 && can('reference.import') ? (
                              <Button size="sm" variant="secondary" onClick={() => setImporting(v)}>
                                <Upload className="h-4 w-4" aria-hidden /> Import CSV
                              </Button>
                            ) : null}
                            {v.status === 'DRAFT' && v.stationCount > 0 && can('reference.approve') ? (
                              <Button size="sm" onClick={() => setApproving(v)}>
                                Approve
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {cycleId && activeVersion ? (
        <>
          <div className="ngao-card mb-4 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-card font-semibold text-ink">
                Stations in version {activeVersion.version}
                {activeVersion.status !== 'APPROVED' ? <span className="ml-2 text-meta font-normal text-[#7a5a17]">(not the approved registry)</span> : null}
              </h2>
              {geo.countyId || q || status ? (
                <Button size="sm" variant="ghost" onClick={() => { setGeo(EMPTY_GEO); setQ(''); setStatus(''); }}>
                  Clear filters
                </Button>
              ) : null}
            </div>
            <GeographyFilter electionCycleId={cycleId} value={geo} onChange={setGeo} idPrefix="reg-geo" />
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_220px]">
              <div>
                <label className="ngao-label" htmlFor="st-q">
                  Search
                </label>
                <TextInput id="st-q" type="search" placeholder="Station code or name" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div>
                <label className="ngao-label" htmlFor="st-status">
                  Status
                </label>
                <SelectInput id="st-status" value={status} onChange={(e) => setStatus(e.target.value as PollingStationStatus | '')}>
                  <option value="">All statuses</option>
                  {Object.entries(STATION_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </SelectInput>
              </div>
            </div>
          </div>
          {stations.error ? <Notice tone="danger" className="mb-4">{describeError(stations.error)}</Notice> : null}
          <DataTable
            caption="Polling stations"
            columns={columns}
            rows={stations.data?.items ?? []}
            rowKey={(s) => s.id}
            loading={stations.loading && !stations.data}
            sort={sort}
            onSortChange={setSort}
            emptyTitle="No stations match"
            emptyDescription={activeVersion.stationCount === 0 ? 'This version has no stations yet. Import a CSV file.' : 'Change the geography, search or status filter.'}
            pagination={stations.data ? { page, pageSize: PAGE_SIZE, total: stations.data.total, onPageChange: setPage } : undefined}
          />
        </>
      ) : null}

      <CreateVersionDialog
        open={creating}
        onClose={() => setCreating(false)}
        electionCycleId={cycleId}
        onCreated={(v) => {
          void versions.reload();
          selectVersion(v.id);
          setImporting(v);
        }}
      />
      {importing ? (
        <RegistryImportDialog
          version={importing}
          open
          onClose={() => setImporting(null)}
          onImported={() => {
            void versions.reload();
            void stations.reload();
          }}
        />
      ) : null}
      <ImportStatusDialog version={reportFor} onClose={() => setReportFor(null)} />
      {approving ? (
        <ReasonDialog
          open
          onClose={() => setApproving(null)}
          title={`Approve registry version ${approving.version}?`}
          description={`${formatNumber(approving.stationCount)} stations become the denominator for coverage and tally progress.${approved ? ` Version ${approved.version} will be marked superseded.` : ''} Approved versions cannot be edited.`}
          confirmLabel="Approve version"
          onConfirm={async (reason) => {
            await highRisk(() => api.post<RegistryVersion>(`/reference/registry-versions/${approving.id}/approve`, { reason }));
            setNotice(`Version ${approving.version} is now the approved registry.`);
            await versions.reload();
            selectVersion(approving.id);
          }}
        />
      ) : null}
    </>
  );
}
