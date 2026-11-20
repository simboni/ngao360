'use client';

import {
  CAMPAIGN_EVENT_STATUS_LABELS,
  CAMPAIGN_EVENT_STATUSES,
  CAMPAIGN_EVENT_TYPE_LABELS,
  CAMPAIGN_EVENT_TYPES,
  type CampaignEventStatus,
  type CampaignEventSummary,
  type CampaignEventType,
  formatMoney,
} from '@ngao360/shared';
import { Plus, Search, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FilterSelect } from '@/components/office/correspondence/office-common';
import { AfterActionBadge, departmentOptionLabel, describeCampaignError, EventStatusBadge, geoLabel, PersonChip, useDepartmentOptions } from '@/components/org/campaign-common';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime, formatNumber } from '@/lib/format';
import { EventFormDialog } from './event-dialogs';
import { EMPTY_EVENT_FILTERS, type EventFilters, eventFiltersToQuery, type EventWhen } from './event-model';
import { eventsApi } from './events-api';

const WHEN_OPTIONS: ReadonlyArray<{ value: EventWhen; label: string }> = [
  { value: 'upcoming', label: 'Upcoming and ongoing' },
  { value: 'past', label: 'Past' },
];

/** S09 Events schedule (API §25). */
export function EventsList() {
  const { can } = useAuth();
  const router = useRouter();
  const departments = useDepartmentOptions();
  const [filters, setFilters] = useState<EventFilters>(EMPTY_EVENT_FILTERS);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = useMemo(() => eventFiltersToQuery(filters), [filters]);
  const key = JSON.stringify(query);
  const list = useAsync(() => eventsApi.list({ ...query, page, pageSize: 25 }), [key, page]);
  const set = <K extends keyof EventFilters>(k: K, v: EventFilters[K]) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const columns: Column<CampaignEventSummary>[] = [
    {
      key: 'title',
      header: 'Event',
      sortValue: (e) => e.title.toLowerCase(),
      cell: (e) => (
        <div className="min-w-[220px]">
          <p className="text-meta text-slate">
            {e.reference} · {CAMPAIGN_EVENT_TYPE_LABELS[e.type]}
          </p>
          <p className="font-medium text-ink">{e.title}</p>
        </div>
      ),
    },
    { key: 'when', header: 'When', sortValue: (e) => e.startsAt, cell: (e) => formatDateTime(e.startsAt) },
    {
      key: 'status',
      header: 'Status',
      sortValue: (e) => CAMPAIGN_EVENT_STATUSES.indexOf(e.status),
      cell: (e) => (
        <div className="flex flex-col items-start gap-1">
          <EventStatusBadge status={e.status} size="sm" />
          {e.afterActionStatus ? <AfterActionBadge status={e.afterActionStatus} size="sm" /> : null}
        </div>
      ),
    },
    {
      key: 'venue',
      header: 'Venue and area',
      cell: (e) => (
        <div>
          <p>{e.venueName ?? '—'}</p>
          <p className="text-meta text-slate">{geoLabel(e.geography)}</p>
        </div>
      ),
    },
    { key: 'organiser', header: 'Organiser', cell: (e) => <PersonChip user={e.organiser} /> },
    { key: 'attendance', header: 'Attendance', align: 'right', sortValue: (e) => e.attendanceCount, cell: (e) => formatNumber(e.attendanceCount) },
    { key: 'budget', header: 'Budget', align: 'right', cell: (e) => (e.budget ? formatMoney(e.budget.amountMinor, e.budget.currency) : '—') },
  ];

  return (
    <>
      <PageHeader
        title="Events"
        description="Meetings, town halls, trainings and other events with their agenda, logistics, attendance and after-action report."
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Events' }]}
        actions={
          can('events.create') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New event
            </Button>
          ) : null
        }
      />
      <section aria-label="Filters" className="ngao-card mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="sm:col-span-2">
          <label htmlFor="ef-q" className="ngao-label">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input id="ef-q" className="ngao-input pl-9" placeholder="Reference, title or venue" value={filters.q} onChange={(e) => set('q', e.target.value)} />
          </div>
        </div>
        <FilterSelect id="ef-when" label="When" value={filters.when} onChange={(v) => set('when', v as EventWhen)} options={WHEN_OPTIONS} anyLabel="Any time" />
        <FilterSelect
          id="ef-status"
          label="Status"
          value={filters.status}
          onChange={(v) => set('status', v as CampaignEventStatus | '')}
          options={CAMPAIGN_EVENT_STATUSES.map((s) => ({ value: s, label: CAMPAIGN_EVENT_STATUS_LABELS[s] }))}
        />
        <FilterSelect id="ef-type" label="Type" value={filters.type} onChange={(v) => set('type', v as CampaignEventType | '')} options={CAMPAIGN_EVENT_TYPES.map((t) => ({ value: t, label: CAMPAIGN_EVENT_TYPE_LABELS[t] }))} />
        <FilterSelect id="ef-dept" label="Department" value={filters.departmentId} onChange={(v) => set('departmentId', v)} options={departments.map((d) => ({ value: d.id, label: departmentOptionLabel(d) }))} />
        <label className="flex items-center gap-2 text-body text-ink sm:col-span-2 lg:col-span-6">
          <input type="checkbox" checked={filters.mine} onChange={(e) => set('mine', e.target.checked)} />
          Only events I organise or my teams are invited to
        </label>
      </section>
      {list.error && !list.data ? (
        <Card>
          <EmptyState icon={ShieldOff} title="Events could not be loaded" description={describeCampaignError(list.error)} action={<Button variant="secondary" onClick={() => void list.reload()}>Try again</Button>} />
        </Card>
      ) : (
        <DataTable
          caption="Events"
          columns={columns}
          rows={list.data?.items ?? []}
          rowKey={(e) => e.id}
          loading={list.loading && !list.data}
          onRowClick={(e) => router.push(`/events/${e.id}`)}
          emptyTitle="No events match these filters"
          pagination={list.data ? { page, pageSize: 25, total: list.data.total, onPageChange: setPage } : undefined}
        />
      )}
      <EventFormDialog open={creating} onClose={() => setCreating(false)} event={null} onSaved={(e) => router.push(`/events/${e.id}`)} />
    </>
  );
}
