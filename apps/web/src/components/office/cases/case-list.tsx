'use client';

import {
  CASE_CATEGORIES,
  CASE_CATEGORY_LABELS,
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_SOURCE_LABELS,
  CASE_SOURCES,
  CASE_STATUS_LABELS,
  CASE_STATUSES,
  type CaseQuery,
  type CaseSummary,
} from '@ngao360/shared';
import { Filter, Phone, Plus, RefreshCw, Search, UserX, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { CaseStatusBadge, PriorityBadge, SlaBadge } from './case-badges';
import { casesApi } from './case-api';
import { describeCaseError } from './case-form';
import { NewCaseDialog } from './new-case-dialog';
import { caseSla, dateInZone, SLA_WEIGHT } from './sla';
import { useCaseGeography } from './use-case-lookups';

type View = CaseQuery['view'];
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'all', label: 'All open and closed' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'triage', label: 'Needs triage' },
  { key: 'review_due', label: 'Review due' },
  { key: 'closed', label: 'Closed' },
];

const PAGE_SIZE = 25;
const FILTER_KEYS = ['q', 'status', 'category', 'priority', 'source', 'unit', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function locationLabel(c: Pick<CaseSummary, 'location'>): string {
  const l = c.location;
  const parts = [l.ward?.name, l.constituency?.name].filter(Boolean);
  return parts.length ? parts.join(', ') : (l.county?.name ?? 'No location');
}

/** Citizen case list (S25 entry point). API §11 `GET /office/cases`. */
export function CaseList() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/office/cases';
  const params = useSearchParams();
  const geo = useCaseGeography();
  const view = (VIEWS.find((v) => v.key === params?.get('view'))?.key ?? 'all') as View;
  const page = Math.max(1, Number(params?.get('page') ?? 1) || 1);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params?.get(k) ?? ''])) as Record<FilterKey, string>;
  const [draft, setDraft] = useState(filters);
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some((k) => k !== 'q' && filters[k]));
  const [creating, setCreating] = useState(false);
  const key = params?.toString() ?? '';

  const { data, error, loading, reload } = useAsync(
    () =>
      casesApi.list({
        view,
        page,
        pageSize: PAGE_SIZE,
        q: filters.q || undefined,
        status: (filters.status || undefined) as CaseQuery['status'],
        category: (filters.category || undefined) as CaseQuery['category'],
        priority: (filters.priority || undefined) as CaseQuery['priority'],
        source: (filters.source || undefined) as CaseQuery['source'],
        geographicUnitId: filters.unit || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      }),
    [key],
  );

  const navigate = (next: Partial<Record<FilterKey | 'view' | 'page', string>>) => {
    const sp = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if (!('page' in next)) sp.delete('page');
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const applyFilters = (e?: React.FormEvent) => {
    e?.preventDefault();
    navigate(draft);
  };

  const clearFilters = () => {
    const cleared = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Record<FilterKey, string>;
    setDraft(cleared);
    navigate(cleared);
  };

  const today = dateInZone(new Date());
  const columns = useMemo<Column<CaseSummary>[]>(
    () => [
      {
        key: 'reference',
        header: 'Reference',
        sortValue: (r) => r.reference,
        className: 'whitespace-nowrap',
        cell: (r) => (
          <div>
            <Link href={`/office/cases/${r.id}`} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.reference}
            </Link>
            <div className="font-mono text-meta text-slate">{r.publicReference}</div>
          </div>
        ),
      },
      {
        key: 'title',
        header: 'Request',
        sortValue: (r) => r.title.toLowerCase(),
        cell: (r) => (
          <div className="min-w-[240px]">
            <div className="line-clamp-2 font-medium text-ink" title={`${r.title} · updated ${formatDateTime(r.updatedAt)}`}>
              {r.title}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-meta text-slate">
              <span>{CASE_CATEGORY_LABELS[r.category]}</span>
              <span aria-hidden>·</span>
              <span>{CASE_SOURCE_LABELS[r.source]}</span>
              {r.hasContact ? (
                <span className="inline-flex items-center gap-0.5 whitespace-nowrap" title="The requester left contact details (open the case to view them; every view is audited)">
                  <Phone className="h-3 w-3" aria-hidden />
                  Contact on file
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      { key: 'location', header: 'Location', sortValue: (r) => locationLabel(r), cell: (r) => <span className="block min-w-[140px] max-w-[220px] text-meta">{locationLabel(r)}</span> },
      { key: 'status', header: 'Stage', sortValue: (r) => CASE_STATUSES.indexOf(r.status), cell: (r) => <CaseStatusBadge status={r.status} size="sm" /> },
      { key: 'priority', header: 'Priority', sortValue: (r) => -CASE_PRIORITIES.indexOf(r.priority), cell: (r) => <PriorityBadge priority={r.priority} size="sm" /> },
      {
        key: 'assignee',
        header: 'Assignee',
        sortValue: (r) => r.assignee?.displayName ?? '',
        cell: (r) =>
          r.assignee ? (
            <span className="text-meta">{r.assignee.displayName}</span>
          ) : (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-meta text-slate">
              <UserX className="h-3.5 w-3.5" aria-hidden />
              Unassigned
            </span>
          ),
      },
      {
        key: 'sla',
        header: 'Review',
        sortValue: (r) => SLA_WEIGHT[caseSla(r, today).kind],
        className: 'whitespace-nowrap',
        cell: (r) => <SlaBadge sla={caseSla(r, today)} size="sm" />,
      },
    ],
    [today],
  );

  const units = geo
    ? geo.constituencies.flatMap((c) => [
        { value: c.id, label: `${c.name} (constituency)` },
        ...geo.wards.filter((w) => w.constituencyId === c.id).map((w) => ({ value: w.id, label: `— ${w.name}` })),
      ])
    : [];

  return (
    <>
      <PageHeader
        title="Citizen cases"
        description="Service requests and issue reports from the public portal, walk-ins, calls and letters. Requester contact details are never shown in this list."
        breadcrumbs={[{ label: 'Office' }, { label: 'Citizen cases' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => void reload()} aria-label="Refresh list">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {can('office.cases.create') ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Record a case
              </Button>
            ) : null}
          </>
        }
      />

      <nav aria-label="Case views" className="mb-4 -mx-1 overflow-x-auto">
        <ul className="flex min-w-max gap-1 px-1">
          {VIEWS.map((v) => (
            <li key={v.key}>
              <button
                type="button"
                onClick={() => navigate({ view: v.key === 'all' ? '' : v.key })}
                aria-current={view === v.key ? 'page' : undefined}
                className={cn(
                  'h-9 rounded-lg px-3 text-body font-medium',
                  view === v.key ? 'bg-deep-blue text-white' : 'border border-line bg-surface text-ink hover:bg-cloud',
                )}
              >
                {v.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <form onSubmit={applyFilters} className="ngao-card mb-4 p-3" role="search" aria-label="Filter cases">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor="case-q" className="sr-only">
              Search by reference, public reference or title
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input
              id="case-q"
              type="search"
              className="ngao-input pl-9"
              placeholder="Search reference, public reference or title"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} aria-controls="case-filters">
              <Filter className="h-4 w-4" aria-hidden />
              Filters
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </div>
        {showFilters ? (
          <div id="case-filters" className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect id="f-status" label="Stage" value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} options={CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_LABELS[s] }))} />
            <FilterSelect id="f-category" label="Category" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} options={CASE_CATEGORIES.map((s) => ({ value: s, label: CASE_CATEGORY_LABELS[s] }))} />
            <FilterSelect id="f-priority" label="Priority" value={draft.priority} onChange={(v) => setDraft({ ...draft, priority: v })} options={CASE_PRIORITIES.map((s) => ({ value: s, label: CASE_PRIORITY_LABELS[s] }))} />
            <FilterSelect id="f-source" label="Source" value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })} options={CASE_SOURCES.map((s) => ({ value: s, label: CASE_SOURCE_LABELS[s] }))} />
            {units.length ? <FilterSelect id="f-unit" label="Constituency or ward" value={draft.unit} onChange={(v) => setDraft({ ...draft, unit: v })} options={units} /> : null}
            <div>
              <label htmlFor="f-from" className="ngao-label">
                Submitted from
              </label>
              <input id="f-from" type="date" className="ngao-input" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </div>
            <div>
              <label htmlFor="f-to" className="ngao-label">
                Submitted to
              </label>
              <input id="f-to" type="date" className="ngao-input" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </div>
            <div className="flex items-end">
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <X className="h-4 w-4" aria-hidden />
                Clear filters
              </Button>
            </div>
          </div>
        ) : null}
      </form>

      {error ? (
        <Notice tone="error" className="mb-4" title="Cases could not be loaded">
          {describeCaseError(error)}
        </Notice>
      ) : null}

      <DataTable
        caption="Citizen cases"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        loading={loading && !data}
        onRowClick={(r) => router.push(`/office/cases/${r.id}`)}
        emptyTitle={view === 'mine' ? 'No cases are assigned to you' : 'No cases match'}
        emptyDescription="Change the view or clear the filters."
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (p) => navigate({ page: String(p) }) } : undefined}
      />

      <p className="mt-3 text-meta text-slate">
        Review badges: overdue and late triage first. Cases waiting more than 2 days for triage, or past their next review date, are flagged.
      </p>

      {creating ? <NewCaseDialog open onClose={() => setCreating(false)} onCreated={(c) => router.push(`/office/cases/${c.id}?new=1`)} /> : null}
    </>
  );
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div>
      <label htmlFor={id} className="ngao-label">
        {label}
      </label>
      <select id={id} className="ngao-input pr-8" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
