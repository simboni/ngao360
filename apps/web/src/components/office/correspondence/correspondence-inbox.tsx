'use client';

import {
  CORRESPONDENCE_CATEGORIES,
  CORRESPONDENCE_CATEGORY_LABELS,
  CORRESPONDENCE_CHANNEL_LABELS,
  CORRESPONDENCE_STATUS_LABELS,
  CORRESPONDENCE_STATUSES,
  type CorrespondenceQuery,
  type CorrespondenceSummary,
  SENSITIVITY_LEVELS,
} from '@ngao360/shared';
import { Filter, Paperclip, Plus, RefreshCw, Search, UserX, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { correspondenceApi } from './correspondence-api';
import { CorrespondenceStatusBadge, DeadlineBadge, DirectionBadge } from './correspondence-badges';
import { correspondenceDeadline, counterpartLabel, DEADLINE_WEIGHT } from './correspondence-model';
import { dateInNairobi, describeOfficeError, FilterSelect, formatDate, SensitivityBadge, SENSITIVITY_LEVEL_LABELS, ViewTabs } from './office-common';
import { RegisterCorrespondenceDialog } from './register-correspondence-dialog';

type View = CorrespondenceQuery['view'];
const VIEWS: ReadonlyArray<{ key: View; label: string }> = [
  { key: 'all', label: 'All items' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'unassigned', label: 'Unassigned' },
];
const PAGE_SIZE = 25;
const FILTER_KEYS = ['q', 'direction', 'status', 'category', 'sensitivity', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** The date that matters for an item: received (incoming), sent (outgoing), else the document date. */
export function correspondenceDate(r: Pick<CorrespondenceSummary, 'direction' | 'receivedAt' | 'sentAt' | 'documentDate' | 'createdAt'>): { label: string; iso: string | null; isDate: boolean } {
  if (r.direction === 'INCOMING' && r.receivedAt) return { label: 'Received', iso: r.receivedAt, isDate: false };
  if (r.direction === 'OUTGOING' && r.sentAt) return { label: 'Sent', iso: r.sentAt, isDate: false };
  if (r.documentDate) return { label: 'Dated', iso: r.documentDate, isDate: true };
  return { label: 'Registered', iso: r.createdAt, isDate: false };
}

/** S23 Correspondence inbox. API §9 `GET /office/correspondence`. */
export function CorrespondenceInbox() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/office/correspondence';
  const params = useSearchParams();
  const view = (VIEWS.find((v) => v.key === params?.get('view'))?.key ?? 'all') as View;
  const page = Math.max(1, Number(params?.get('page') ?? 1) || 1);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params?.get(k) ?? ''])) as Record<FilterKey, string>;
  const [draft, setDraft] = useState(filters);
  const [showFilters, setShowFilters] = useState(FILTER_KEYS.some((k) => k !== 'q' && filters[k]));
  const [creating, setCreating] = useState(false);
  const key = params?.toString() ?? '';
  const canConfidential = can('office.correspondence.confidential');

  const { data, error, loading, reload } = useAsync(
    () =>
      correspondenceApi.list({
        view,
        page,
        pageSize: PAGE_SIZE,
        q: filters.q || undefined,
        direction: (filters.direction || undefined) as CorrespondenceQuery['direction'],
        status: (filters.status || undefined) as CorrespondenceQuery['status'],
        category: (filters.category || undefined) as CorrespondenceQuery['category'],
        sensitivity: (filters.sensitivity || undefined) as CorrespondenceQuery['sensitivity'],
        from: filters.from || undefined,
        to: filters.to || undefined,
      }),
    [key],
  );
  // Badge counts for the views that need attention (one small request each).
  const counts = useAsync(
    async () => {
      const [overdue, unassigned, mine] = await Promise.all(
        (['overdue', 'unassigned', 'mine'] as const).map((v) => correspondenceApi.list({ view: v, pageSize: 1 }).then((p) => p.total).catch(() => null)),
      );
      return { overdue, unassigned, mine };
    },
    [data],
    !!data,
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

  const clearFilters = () => {
    const cleared = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Record<FilterKey, string>;
    setDraft(cleared);
    navigate(cleared);
  };

  const today = dateInNairobi();
  const columns = useMemo<Column<CorrespondenceSummary>[]>(
    () => [
      {
        key: 'reference',
        header: 'Reference',
        sortValue: (r) => r.reference,
        className: 'whitespace-nowrap',
        cell: (r) => (
          <div className="flex flex-col items-start gap-1">
            <Link href={`/office/correspondence/${r.id}`} className="font-medium text-deep-blue hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.reference}
            </Link>
            <DirectionBadge direction={r.direction} size="sm" />
          </div>
        ),
      },
      { key: 'status', header: 'Status', sortValue: (r) => CORRESPONDENCE_STATUSES.indexOf(r.status), cell: (r) => <CorrespondenceStatusBadge status={r.status} size="sm" /> },
      {
        key: 'subject',
        header: 'Subject',
        sortValue: (r) => r.subject.toLowerCase(),
        cell: (r) => (
          <div className="min-w-[220px]">
            <div className="line-clamp-2 font-medium text-ink">{r.subject}</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-slate">
              <span>{CORRESPONDENCE_CATEGORY_LABELS[r.category]}</span>
              <span aria-hidden>·</span>
              <span>{CORRESPONDENCE_CHANNEL_LABELS[r.channel]}</span>
              {r.sensitivity !== 'INTERNAL' ? <SensitivityBadge level={r.sensitivity} size="sm" /> : null}
              {r.attachmentCount > 0 ? (
                <span className="inline-flex items-center gap-0.5" title={`${r.attachmentCount} attachment(s)`}>
                  <Paperclip className="h-3 w-3" aria-hidden />
                  {r.attachmentCount}
                  <span className="sr-only"> attachments</span>
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: 'counterpart',
        header: 'Sender / recipient',
        sortValue: (r) => r.counterpartName.toLowerCase(),
        cell: (r) => (
          <div className="min-w-[140px] max-w-[220px]">
            <div className="text-body">
              <span className="text-meta text-slate">{counterpartLabel(r.direction)} </span>
              {r.counterpartName}
            </div>
            {r.counterpartOrganisation && r.counterpartOrganisation !== r.counterpartName ? <div className="truncate text-meta text-slate">{r.counterpartOrganisation}</div> : null}
          </div>
        ),
      },
      {
        key: 'date',
        header: 'Date',
        sortValue: (r) => correspondenceDate(r).iso ?? '',
        className: 'whitespace-nowrap',
        cell: (r) => {
          const d = correspondenceDate(r);
          return (
            <div className="text-meta">
              <div className="text-slate">{d.label}</div>
              <div className="text-ink">{d.isDate ? formatDate(d.iso) : formatDateTime(d.iso)}</div>
            </div>
          );
        },
      },
      {
        key: 'assignee',
        header: 'Assigned officer',
        sortValue: (r) => r.assignedTo?.displayName ?? '',
        cell: (r) =>
          r.assignedTo ? (
            <span className="text-meta">{r.assignedTo.displayName}</span>
          ) : (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-meta text-slate">
              <UserX className="h-3.5 w-3.5" aria-hidden />
              Unassigned
            </span>
          ),
      },
      {
        key: 'due',
        header: 'Response due',
        sortValue: (r) => `${DEADLINE_WEIGHT[correspondenceDeadline(r, today).kind]}${r.responseDueDate ?? '9999'}`,
        className: 'whitespace-nowrap',
        cell: (r) => {
          const dl = correspondenceDeadline(r, today);
          return (
            <div className="flex flex-col items-start gap-1 text-meta">
              <span>{formatDate(r.responseDueDate)}</span>
              <DeadlineBadge deadline={dl} size="sm" />
            </div>
          );
        },
      },
    ],
    [today],
  );

  return (
    <>
      <PageHeader
        title="Correspondence"
        description="Incoming and outgoing letters and memos with their office reference, assigned officer and response deadline."
        breadcrumbs={[{ label: 'Office' }, { label: 'Correspondence' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => void reload()} aria-label="Refresh list">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {can('office.correspondence.create') ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Register item
              </Button>
            ) : null}
          </>
        }
      />

      <ViewTabs
        label="Correspondence views"
        value={view}
        onChange={(v) => navigate({ view: v === 'all' ? '' : v })}
        tabs={VIEWS.map((v) => ({ ...v, count: v.key === 'all' ? null : (counts.data?.[v.key as 'overdue' | 'unassigned' | 'mine'] ?? null) }))}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(draft);
        }}
        className="ngao-card mb-4 p-3"
        role="search"
        aria-label="Filter correspondence"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <label htmlFor="cor-q" className="sr-only">
              Search by reference, subject, sender, recipient or their reference
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input
              id="cor-q"
              type="search"
              className="ngao-input pl-9"
              placeholder="Search reference, subject, sender or recipient"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} aria-controls="cor-filters">
              <Filter className="h-4 w-4" aria-hidden />
              Filters
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </div>
        {showFilters ? (
          <div id="cor-filters" className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect
              id="f-direction"
              label="Direction"
              value={draft.direction}
              onChange={(v) => setDraft({ ...draft, direction: v })}
              options={[
                { value: 'INCOMING', label: 'Incoming' },
                { value: 'OUTGOING', label: 'Outgoing' },
              ]}
            />
            <FilterSelect id="f-status" label="Status" value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} options={CORRESPONDENCE_STATUSES.map((s) => ({ value: s, label: CORRESPONDENCE_STATUS_LABELS[s] }))} />
            <FilterSelect id="f-category" label="Category" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} options={CORRESPONDENCE_CATEGORIES.map((s) => ({ value: s, label: CORRESPONDENCE_CATEGORY_LABELS[s] }))} />
            <FilterSelect
              id="f-sensitivity"
              label="Sensitivity"
              value={draft.sensitivity}
              onChange={(v) => setDraft({ ...draft, sensitivity: v })}
              options={SENSITIVITY_LEVELS.filter((s) => canConfidential || s === 'PUBLIC' || s === 'INTERNAL').map((s) => ({ value: s, label: SENSITIVITY_LEVEL_LABELS[s] }))}
            />
            <div>
              <label htmlFor="f-from" className="ngao-label">
                Dated from
              </label>
              <input id="f-from" type="date" className="ngao-input" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </div>
            <div>
              <label htmlFor="f-to" className="ngao-label">
                Dated to
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
        <Notice tone="error" className="mb-4" title="Correspondence could not be loaded">
          {describeOfficeError(error)}
        </Notice>
      ) : null}

      <DataTable
        caption="Correspondence register"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        loading={loading && !data}
        onRowClick={(r) => router.push(`/office/correspondence/${r.id}`)}
        emptyTitle={view === 'mine' ? 'Nothing is assigned to you' : view === 'overdue' ? 'Nothing is overdue' : 'No correspondence matches'}
        emptyDescription="Change the view or clear the filters."
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (p) => navigate({ page: String(p) }) } : undefined}
      />

      <p className="mt-3 text-meta text-slate">
        {canConfidential
          ? 'You can see confidential and highly restricted items.'
          : 'Confidential and highly restricted items are not listed for your role.'}{' '}
        Overdue means the response date has passed and the item is not yet responded to, sent, filed or archived.
      </p>

      {creating ? (
        <RegisterCorrespondenceDialog open onClose={() => setCreating(false)} onCreated={(c) => router.push(`/office/correspondence/${c.id}?new=1`)} />
      ) : null}
    </>
  );
}
