'use client';

import {
  ACCREDITATION_STATUS_LABELS,
  ACCREDITATION_STATUSES,
  AGENT_AVAILABILITIES,
  AGENT_AVAILABILITY_LABELS,
  AGENT_STATUS_LABELS,
  AGENT_STATUSES,
  type AgentQuery,
  type AgentSummary,
} from '@ngao360/shared';
import { Lock, RefreshCw, Search, Smartphone, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { AccreditationBadge, AgentStatusBadge, AvailabilityBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { FilterChip, ProvenanceTag } from '../common/field-ui';
import { EMPTY_GEO_FILTER, GeoFilter, type GeoFilterValue } from '../common/geo-filter';
import { useFieldCycle } from '../common/use-field-cycle';
import { RegisterAgentDialog } from './register-agent-dialog';

const PAGE_SIZE = 25;

interface Filters {
  q: string;
  status: string;
  availability: string;
  accreditationStatus: string;
  language: string;
  undeployedOnly: boolean;
  geo: GeoFilterValue;
}
const EMPTY: Filters = { q: '', status: '', availability: '', accreditationStatus: '', language: '', undeployedOnly: false, geo: EMPTY_GEO_FILTER };

/**
 * S13 agent registry (API §16 `GET /field/agents`). Contact values are shown
 * masked only; search matches reference and names, never phone or ID numbers.
 */
export function AgentList() {
  const { can } = useAuth();
  const router = useRouter();
  const field = useFieldCycle();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [registering, setRegistering] = useState(false);

  const query: Partial<AgentQuery> = {
    page,
    pageSize: PAGE_SIZE,
    q: filters.q || undefined,
    status: (filters.status || undefined) as AgentQuery['status'],
    availability: (filters.availability || undefined) as AgentQuery['availability'],
    accreditationStatus: (filters.accreditationStatus || undefined) as AgentQuery['accreditationStatus'],
    language: filters.language || undefined,
    undeployedOnly: filters.undeployedOnly || undefined,
    constituencyId: filters.geo.constituencyId || undefined,
    wardId: filters.geo.wardId || undefined,
    electionCycleId: field.cycleId ?? undefined,
  };
  const list = useAsync(() => fieldApi.agents(query), [JSON.stringify(query)]);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const columns: Column<AgentSummary>[] = [
    {
      key: 'name',
      header: 'Agent',
      cell: (a) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{a.displayName}</p>
          <p className="text-meta text-slate">{a.reference}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (a) => <AgentStatusBadge status={a.status} size="sm" /> },
    { key: 'availability', header: 'Availability', cell: (a) => <AvailabilityBadge status={a.availability} size="sm" /> },
    {
      key: 'home',
      header: 'Home ward',
      cell: (a) => (
        <span>
          {a.homeWard?.name ?? '—'}
          {a.homeConstituency ? <span className="block text-meta text-slate">{a.homeConstituency.name}</span> : null}
        </span>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      cell: (a) => (
        <span className="inline-flex items-center gap-1 font-mono text-meta text-slate" title="Masked. Revealing contact details is done on the profile, with a reason, and is audited.">
          <Lock className="h-3 w-3" aria-hidden />
          {a.phoneMasked ?? 'None recorded'}
        </span>
      ),
    },
    { key: 'accreditation', header: 'Accreditation', cell: (a) => <AccreditationBadge status={a.accreditationStatus} size="sm" /> },
    {
      key: 'training',
      header: 'Training',
      align: 'right',
      cell: (a) => (a.trainingTotal === 0 ? <span className="text-slate">None recorded</span> : `${a.trainingCompleted} of ${a.trainingTotal} completed`),
    },
    {
      key: 'deployments',
      header: 'Active deployments',
      align: 'right',
      cell: (a) => (a.activeDeployments === 0 ? <span className="text-[#7a5a17]">Not deployed</span> : a.activeDeployments),
    },
    {
      key: 'account',
      header: 'Mobile sign-in',
      cell: (a) =>
        a.hasUserAccount ? (
          <span className="inline-flex items-center gap-1 text-meta text-ink">
            <Smartphone className="h-3.5 w-3.5" aria-hidden /> Linked
          </span>
        ) : (
          <span className="text-meta text-slate">No account</span>
        ),
    },
    { key: 'updated', header: 'Updated', cell: (a) => <span className="text-meta text-slate">{formatDateTime(a.updatedAt)}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="Agents"
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Agents' }]}
        description="Agent profiles with status, availability, training and accreditation for the field election cycle. Phone and ID numbers are masked; revealing them needs a separate permission, a reason and is audited."
        status={<ProvenanceTag provenance={field.cycle?.dataProvenance} />}
        actions={
          <>
            <Button variant="secondary" onClick={() => void list.reload()} aria-label="Refresh list">
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {can('field.agents.create') ? (
              <Button onClick={() => setRegistering(true)}>
                <UserPlus className="h-4 w-4" aria-hidden /> Register agent
              </Button>
            ) : null}
          </>
        }
      />

      <section aria-label="Filters" className="ngao-card mb-4 space-y-3 p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: search.trim() });
          }}
        >
          <div className="min-w-[220px] flex-1">
            <label htmlFor="agent-search" className="ngao-label">
              Search by name or reference
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
              <input id="agent-search" className="ngao-input pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. AGT-2027-000041 or Wanjala" />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <SelectField
            label="Status"
            value={filters.status}
            onChange={(e) => set({ status: e.target.value })}
            placeholder="Any status"
            options={AGENT_STATUSES.map((s) => ({ value: s, label: AGENT_STATUS_LABELS[s] }))}
          />
          <SelectField
            label="Availability"
            value={filters.availability}
            onChange={(e) => set({ availability: e.target.value })}
            placeholder="Any"
            options={AGENT_AVAILABILITIES.map((s) => ({ value: s, label: AGENT_AVAILABILITY_LABELS[s] }))}
          />
          <SelectField
            label="Accreditation"
            value={filters.accreditationStatus}
            onChange={(e) => set({ accreditationStatus: e.target.value })}
            placeholder="Any"
            options={ACCREDITATION_STATUSES.map((s) => ({ value: s, label: ACCREDITATION_STATUS_LABELS[s] }))}
          />
          <div>
            <label htmlFor="agent-language" className="ngao-label">
              Language
            </label>
            <input
              id="agent-language"
              className="ngao-input"
              value={filters.language}
              onChange={(e) => set({ language: e.target.value })}
              placeholder="e.g. sw, Lubukusu"
            />
          </div>
          <GeoFilter electionCycleId={field.cycleId} value={filters.geo} onChange={(geo) => set({ geo })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={filters.undeployedOnly} onClick={() => set({ undeployedOnly: !filters.undeployedOnly })}>
            Not deployed in this cycle
          </FilterChip>
          {JSON.stringify(filters) !== JSON.stringify(EMPTY) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                set(EMPTY);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </section>

      {list.error ? (
        <Notice tone="error" className="mb-4" title="Could not load agents">
          {describeFieldError(list.error)}
        </Notice>
      ) : null}

      <DataTable
        caption="Agents"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(a) => a.id}
        loading={list.loading && !list.data}
        onRowClick={(a) => router.push(`/field/agents/${a.id}`)}
        emptyTitle="No agents match these filters"
        emptyDescription="Agents outside your assigned geography are not listed."
        pagination={list.data ? { page: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onPageChange: setPage } : undefined}
      />

      {registering ? (
        <RegisterAgentDialog
          electionCycleId={field.cycleId}
          onClose={() => setRegistering(false)}
          onCreated={(a) => router.push(`/field/agents/${a.id}`)}
        />
      ) : null}
    </div>
  );
}
