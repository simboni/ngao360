'use client';

import {
  INCIDENT_CATEGORIES,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUSES,
  type IncidentQuery,
  type IncidentSeverity,
  type IncidentSummary,
} from '@ngao360/shared';
import { CloudOff, Lock, Paperclip, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { formatDateTime } from '@/lib/format';
import { IncidentStatusBadge, SeverityBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { formatAge, stationLabel } from '../common/field-model';
import { FilterChip, ProvenanceTag } from '../common/field-ui';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue } from '../common/geo-filter';
import { useFieldCycle } from '../common/use-field-cycle';
import { useInterval } from '../common/use-interval';

type View = NonNullable<IncidentQuery['view']> | 'all';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'assigned_to_me', label: 'Assigned to me' },
  { key: 'mine', label: 'Reported by me' },
  { key: 'all', label: 'All, including closed' },
];
const PAGE_SIZE = 25;
const AUTO_REFRESH_MS = 60_000;

/**
 * Incident desk queue (API §20 `GET /field/incidents`): highest severity
 * first, then oldest. Lists show the neutral factual preview only; restricted
 * subject records never appear here.
 */
export function IncidentList() {
  const router = useRouter();
  const field = useFieldCycle();
  const [view, setView] = useState<View>('open');
  const [severities, setSeverities] = useState<IncidentSeverity[]>([]);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [station, setStation] = useState('');
  const [geo, setGeo] = useState<GeoFilterValue>(EMPTY_GEO_FILTER);
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);

  const query: Partial<IncidentQuery> = {
    view: view === 'all' ? undefined : view,
    severity: severities.length ? severities : undefined,
    status: (status || undefined) as IncidentQuery['status'],
    category: (category || undefined) as IncidentQuery['category'],
    pollingStationCode: station.trim() || undefined,
    constituencyId: geo.constituencyId || undefined,
    wardId: geo.wardId || undefined,
    electionCycleId: field.cycleId ?? undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useAsync(() => fieldApi.incidents(query), [JSON.stringify(query), tick]);

  // The desk queue refreshes itself every minute while the page is open.
  useInterval(() => setTick((t) => t + 1), AUTO_REFRESH_MS);

  const reset = () => setPage(1);
  const toggleSeverity = (s: IncidentSeverity) => {
    setSeverities((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
    reset();
  };

  const columns: Column<IncidentSummary>[] = [
    {
      key: 'ref',
      header: 'Incident',
      cell: (i) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{i.reference}</p>
          <p className="text-meta text-slate">{formatDateTime(i.reportedAt)}</p>
        </div>
      ),
    },
    { key: 'severity', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} size="sm" /> },
    {
      key: 'category',
      header: 'Category',
      cell: (i) => (
        <div className="max-w-[240px]">
          <p className="text-ink">{INCIDENT_CATEGORY_LABELS[i.category]}</p>
          {i.reportedCategory !== i.category ? <p className="text-meta text-slate">Reported as {INCIDENT_CATEGORY_LABELS[i.reportedCategory]}</p> : null}
        </div>
      ),
    },
    {
      key: 'what',
      header: 'What was observed',
      cell: (i) => <p className="line-clamp-2 max-w-[320px] text-meta text-ink">{i.descriptionPreview}</p>,
    },
    { key: 'where', header: 'Station or area', cell: (i) => <span className="text-meta">{stationLabel(i.location)}</span> },
    { key: 'status', header: 'Status', cell: (i) => <IncidentStatusBadge status={i.status} size="sm" /> },
    { key: 'assignee', header: 'Assigned to', cell: (i) => i.assignee?.displayName ?? <span className="text-[#7a5a17]">Unassigned</span> },
    { key: 'age', header: 'Age', align: 'right', cell: (i) => (i.status === 'CLOSED' ? '—' : formatAge(i.ageMinutes)) },
    {
      key: 'flags',
      header: 'Flags',
      cell: (i) => (
        <span className="flex flex-wrap items-center gap-2 text-meta text-slate">
          {i.evidenceCount ? (
            <span className="inline-flex items-center gap-0.5" title="Evidence files">
              <Paperclip className="h-3.5 w-3.5" aria-hidden /> {i.evidenceCount}
            </span>
          ) : null}
          {i.evidenceHold ? (
            <span className="inline-flex items-center gap-0.5 text-ink">
              <Lock className="h-3.5 w-3.5" aria-hidden /> Hold
            </span>
          ) : null}
          {i.submittedOffline ? (
            <span className="inline-flex items-center gap-0.5" title="Sent from the offline queue">
              <CloudOff className="h-3.5 w-3.5" aria-hidden /> Offline
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Incidents"
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Incidents' }]}
        description="Factual records of what was observed. The original report never changes; triage, corrections, referrals and closure are added as events."
        status={<ProvenanceTag provenance={field.cycle?.dataProvenance} />}
        actions={
          <Button variant="secondary" onClick={() => void list.reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        }
      />

      <nav aria-label="Incident views" className="mb-3 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <FilterChip
            key={v.key}
            active={view === v.key}
            onClick={() => {
              setView(v.key);
              reset();
            }}
          >
            {v.label}
          </FilterChip>
        ))}
      </nav>

      <section aria-label="Filters" className="ngao-card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-meta font-medium text-slate">Severity:</span>
          {INCIDENT_SEVERITIES.slice()
            .reverse()
            .map((s) => (
              <button key={s} type="button" aria-pressed={severities.includes(s)} onClick={() => toggleSeverity(s)} className={severities.includes(s) ? 'rounded-full ring-2 ring-deep-blue ring-offset-1' : 'rounded-full opacity-80 hover:opacity-100'}>
                <SeverityBadge severity={s} />
              </button>
            ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SelectField label="Status" value={status} placeholder="Any status" onChange={(e) => { setStatus(e.target.value); reset(); }} options={INCIDENT_STATUSES.map((s) => ({ value: s, label: INCIDENT_STATUS_LABELS[s] }))} />
          <SelectField label="Category" value={category} placeholder="Any category" onChange={(e) => { setCategory(e.target.value); reset(); }} options={INCIDENT_CATEGORIES.map((c) => ({ value: c, label: INCIDENT_CATEGORY_LABELS[c] }))} />
          <div>
            <label htmlFor="incident-station" className="ngao-label">
              Station code
            </label>
            <input id="incident-station" className="ngao-input" value={station} onChange={(e) => { setStation(e.target.value); reset(); }} placeholder="e.g. 039" />
          </div>
          <GeoFilter electionCycleId={field.cycleId} value={geo} onChange={(v) => { setGeo(v); reset(); }} />
        </div>
      </section>

      {list.error ? (
        <Notice tone="error" className="mb-4" title="Could not load incidents">
          {describeFieldError(list.error)}
        </Notice>
      ) : null}

      <DataTable
        caption="Incident queue"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(i) => i.id}
        loading={list.loading && !list.data}
        onRowClick={(i) => router.push(`/field/incidents/${i.id}`)}
        emptyTitle="No incidents in this view"
        emptyDescription="Incidents outside your geography and election cycle are not listed."
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />
      <p className="mt-2 text-meta text-slate">Refreshes every minute. Ordered by severity, then by how long the incident has waited.</p>
    </div>
  );
}
