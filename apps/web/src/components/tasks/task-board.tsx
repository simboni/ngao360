'use client';

import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  type TaskBoard as TaskBoardData,
  type TaskDetail,
  type TaskSummary,
  type TaskWorkload,
} from '@ngao360/shared';
import { CalendarDays, ChevronLeft, ChevronRight, Link2, ListChecks, Plus, Search, ShieldOff, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FilterSelect, ViewTabs } from '@/components/office/correspondence/office-common';
import {
  departmentOptionLabel,
  describeCampaignError,
  geoLabel,
  geoOptionsFrom,
  PersonChip,
  TASK_STATUS_SPEC,
  TaskPriorityBadge,
  TaskStatusBadge,
  useAssignableUsers,
  useDepartmentOptions,
} from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import { CreateTaskDialog } from './task-dialogs';
import { TaskDetailPanel } from './task-detail';
import {
  activeFilterCount,
  calendarGrid,
  type DueFilter,
  dueInfo,
  EMPTY_TASK_FILTERS,
  filtersToQuery,
  nairobiDate,
  shiftMonth,
  type TaskFilters,
  type TaskScope,
  tasksByDay,
} from './task-model';
import { tasksApi } from './tasks-api';

type View = 'board' | 'list' | 'calendar' | 'workload';

const VIEW_TABS: ReadonlyArray<{ key: View; label: string }> = [
  { key: 'board', label: 'Board' },
  { key: 'list', label: 'List' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'workload', label: 'Workload' },
];

const SCOPE_OPTIONS: ReadonlyArray<{ value: TaskScope; label: string }> = [
  { value: 'mine', label: 'My tasks' },
  { value: 'review', label: 'Awaiting my review' },
  { value: 'overdue', label: 'Overdue' },
];
const DUE_OPTIONS: ReadonlyArray<{ value: DueFilter; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in the next 7 days' },
  { value: 'month', label: 'Due in the next 30 days' },
];

/** S08 Task board: board, list, calendar and workload views (API §24). */
export function TaskBoardScreen() {
  const { can } = useAuth();
  const [view, setView] = useState<View>('board');
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_TASK_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const [geoSeen, setGeoSeen] = useState<TaskSummary[]>([]);

  const set = <K extends keyof TaskFilters>(k: K, v: TaskFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const queryKey = JSON.stringify(query);
  const bump = () => setVersion((v) => v + 1);
  const remember = (items: TaskSummary[]) => setGeoSeen((s) => (items.length ? [...s, ...items].slice(-500) : s));

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work in your departments and area, with one accountable owner per task. Reviews are done by someone other than the owner."
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Tasks' }]}
        actions={
          can('tasks.create') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New task
            </Button>
          ) : null
        }
      />
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <ViewTabs label="Task views" value={view} onChange={setView} tabs={VIEW_TABS} />
      </div>
      <FilterBar filters={filters} set={set} reset={() => setFilters(EMPTY_TASK_FILTERS)} geoSource={geoSeen} />

      {view === 'board' ? <BoardView queryKey={queryKey} query={query} version={version} onOpen={setOpenId} onLoaded={remember} /> : null}
      {view === 'list' ? <ListView queryKey={queryKey} query={query} version={version} onOpen={setOpenId} onLoaded={remember} /> : null}
      {view === 'calendar' ? <CalendarView filters={filters} version={version} onOpen={setOpenId} onLoaded={remember} /> : null}
      {view === 'workload' ? (
        <WorkloadView
          queryKey={queryKey}
          query={query}
          version={version}
          onPick={(ownerId) => {
            set('ownerId', ownerId);
            setView('list');
          }}
        />
      ) : null}

      <Dialog open={!!openId} onClose={() => setOpenId(null)} variant="drawer" title="Task">
        {openId ? <TaskDetailPanel id={openId} layout="drawer" onChanged={bump} /> : null}
      </Dialog>
      <CreateTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t: TaskDetail) => {
          bump();
          setOpenId(t.id);
        }}
      />
    </>
  );
}

function FilterBar({
  filters,
  set,
  reset,
  geoSource,
}: {
  filters: TaskFilters;
  set: <K extends keyof TaskFilters>(k: K, v: TaskFilters[K]) => void;
  reset: () => void;
  geoSource: TaskSummary[];
}) {
  const departments = useDepartmentOptions();
  const people = useAssignableUsers();
  const geo = useMemo(() => geoOptionsFrom(geoSource), [geoSource]);
  const count = activeFilterCount(filters);
  return (
    <section aria-label="Filters" className="ngao-card mb-4 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <div className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
          <label htmlFor="tf-q" className="ngao-label">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
            <input id="tf-q" className="ngao-input pl-9" placeholder="Reference or title" value={filters.q} onChange={(e) => set('q', e.target.value)} />
          </div>
        </div>
        <FilterSelect id="tf-scope" label="Show" value={filters.scope === 'all' ? '' : filters.scope} onChange={(v) => set('scope', (v || 'all') as TaskScope)} options={SCOPE_OPTIONS} anyLabel="All tasks I can see" />
        <FilterSelect id="tf-owner" label="Assignee" value={filters.ownerId} onChange={(v) => set('ownerId', v)} options={people.map((u) => ({ value: u.id, label: u.displayName }))} anyLabel="Anyone" />
        <FilterSelect
          id="tf-priority"
          label="Priority"
          value={filters.priority}
          onChange={(v) => set('priority', v as TaskFilters['priority'])}
          options={TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABELS[p] }))}
        />
        <FilterSelect id="tf-dept" label="Department" value={filters.departmentId} onChange={(v) => set('departmentId', v)} options={departments.map((d) => ({ value: d.id, label: departmentOptionLabel(d) }))} />
        <FilterSelect id="tf-geo" label="Area" value={filters.geographicUnitId} onChange={(v) => set('geographicUnitId', v)} options={geo} anyLabel="Any area" />
        <FilterSelect id="tf-due" label="Due" value={filters.due} onChange={(v) => set('due', v as DueFilter)} options={DUE_OPTIONS} anyLabel="Any time" />
      </div>
      {count ? (
        <div className="mt-2 flex items-center gap-2 text-meta text-slate">
          <span>
            {count} {count === 1 ? 'filter' : 'filters'} applied
          </span>
          <button type="button" className="inline-flex items-center gap-1 text-deep-blue underline" onClick={reset}>
            <X className="h-3 w-3" aria-hidden />
            Clear filters
          </button>
        </div>
      ) : null}
    </section>
  );
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <Card>
      <EmptyState icon={ShieldOff} title="Tasks could not be loaded" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={retry}>Try again</Button>} />
    </Card>
  );
}

/* ---------------------------------- Board ---------------------------------- */

function BoardView({
  query,
  queryKey,
  version,
  onOpen,
  onLoaded,
}: {
  query: ReturnType<typeof filtersToQuery>;
  queryKey: string;
  version: number;
  onOpen: (id: string) => void;
  onLoaded: (items: TaskSummary[]) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const board = useAsync<TaskBoardData>(async () => {
    const b = await tasksApi.board(query);
    onLoaded(b.columns.flatMap((c) => c.items));
    return b;
  }, [queryKey, version]);
  if (board.error && !board.data) return <LoadError error={board.error} retry={() => void board.reload()} />;
  const columns = TASK_STATUSES.filter((s) => showClosed || s !== 'CANCELLED');
  const byStatus = new Map((board.data?.columns ?? []).map((c) => [c.status, c]));
  return (
    <>
      <label className="mb-2 flex items-center gap-2 text-body text-ink">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
        Show cancelled tasks
      </label>
      <div className="-mx-4 overflow-x-auto px-4 pb-2" aria-busy={board.loading}>
        <div className="flex min-w-max gap-3">
          {columns.map((status) => {
            const col = byStatus.get(status);
            const Icon = TASK_STATUS_SPEC[status].icon;
            return (
              <section key={status} aria-labelledby={`col-${status}`} className="flex w-72 shrink-0 flex-col rounded-card bg-cloud">
                <h2 id={`col-${status}`} className="flex items-center justify-between gap-2 px-3 py-2 text-body font-semibold text-ink">
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-slate" aria-hidden />
                    <TaskStatusBadge status={status} size="sm" />
                  </span>
                  <span className="rounded-full bg-surface px-2 text-meta tabular-nums text-slate" aria-label={`${col?.total ?? 0} tasks`}>
                    {col?.total ?? (board.loading ? '…' : 0)}
                  </span>
                </h2>
                <ul className="flex max-h-[65vh] flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {board.loading && !board.data
                    ? [0, 1].map((i) => <li key={i} className="h-24 animate-pulse rounded-lg bg-surface" />)
                    : (col?.items ?? []).map((t) => (
                        <li key={t.id}>
                          <TaskCard task={t} onOpen={onOpen} />
                        </li>
                      ))}
                  {col && col.total > col.items.length ? <li className="px-1 text-meta text-slate">+{col.total - col.items.length} more: use the list view to see them all.</li> : null}
                  {col && col.total === 0 ? <li className="px-1 py-3 text-center text-meta text-slate">No tasks</li> : null}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen: (id: string) => void }) {
  const due = dueInfo(task);
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className="block w-full rounded-lg border border-line bg-surface p-3 text-left shadow-card hover:border-deep-blue/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal"
    >
      <span className="block text-meta text-slate">{task.reference}</span>
      <span className="mt-0.5 block text-body font-medium text-ink">{task.title}</span>
      <span className="mt-2 flex flex-wrap items-center gap-1">
        <TaskPriorityBadge priority={task.priority} size="sm" />
        {due ? <StatusBadge kind="custom" status="due" label={due.text} tone={due.tone} icon={CalendarDays} size="sm" /> : null}
      </span>
      <span className="mt-2 flex items-center justify-between gap-2 text-meta text-slate">
        <PersonChip user={task.owner} />
        <span className="flex shrink-0 items-center gap-2">
          {task.checklist.total ? (
            <span className="inline-flex items-center gap-0.5" title="Checklist">
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Checklist</span>
              {task.checklist.done}/{task.checklist.total}
            </span>
          ) : null}
          {task.openDependencyCount ? (
            <span className="inline-flex items-center gap-0.5 text-[#7a5a17]" title="Open dependencies">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Open dependencies</span>
              {task.openDependencyCount}
            </span>
          ) : null}
        </span>
      </span>
      {task.department || task.geography ? (
        <span className="mt-1 block truncate text-meta text-slate">
          {[task.department?.code, task.geography ? geoLabel(task.geography) : null].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </button>
  );
}

/* ----------------------------------- List ---------------------------------- */

function ListView({
  query,
  queryKey,
  version,
  onOpen,
  onLoaded,
}: {
  query: ReturnType<typeof filtersToQuery>;
  queryKey: string;
  version: number;
  onOpen: (id: string) => void;
  onLoaded: (items: TaskSummary[]) => void;
}) {
  const [page, setPage] = useState(1);
  const list = useAsync(async () => {
    const p = await tasksApi.list({ ...query, page, pageSize: 50 });
    onLoaded(p.items);
    return p;
  }, [queryKey, version, page]);
  if (list.error && !list.data) return <LoadError error={list.error} retry={() => void list.reload()} />;
  const columns: Column<TaskSummary>[] = [
    {
      key: 'title',
      header: 'Task',
      sortValue: (t) => t.title.toLowerCase(),
      cell: (t) => (
        <div className="min-w-[220px]">
          <p className="text-meta text-slate">{t.reference}</p>
          <p className="font-medium text-ink">{t.title}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (t) => TASK_STATUSES.indexOf(t.status), cell: (t) => <TaskStatusBadge status={t.status} size="sm" /> },
    { key: 'priority', header: 'Priority', sortValue: (t) => TASK_PRIORITIES.indexOf(t.priority), cell: (t) => <TaskPriorityBadge priority={t.priority} size="sm" /> },
    { key: 'owner', header: 'Owner', cell: (t) => <PersonChip user={t.owner} /> },
    {
      key: 'dueAt',
      header: 'Due',
      sortValue: (t) => t.dueAt,
      cell: (t) => {
        const d = dueInfo(t);
        return (
          <div>
            <p>{formatDateTime(t.dueAt)}</p>
            {d && d.tone !== 'neutral' && d.tone !== 'muted' ? <p className={cn('text-meta', d.tone === 'danger' ? 'text-error' : 'text-[#7a5a17]')}>{d.text}</p> : null}
          </div>
        );
      },
    },
    { key: 'department', header: 'Department', cell: (t) => t.department?.name ?? 'Organisation-level' },
    { key: 'geo', header: 'Area', cell: (t) => geoLabel(t.geography) },
    {
      key: 'progress',
      header: 'Checklist',
      align: 'right',
      cell: (t) => (t.checklist.total ? `${t.checklist.done}/${t.checklist.total}` : '—'),
    },
  ];
  return (
    <DataTable
      caption="Tasks"
      columns={columns}
      rows={list.data?.items ?? []}
      rowKey={(t) => t.id}
      loading={list.loading && !list.data}
      onRowClick={(t) => onOpen(t.id)}
      emptyTitle="No tasks match these filters"
      pagination={list.data ? { page, pageSize: 50, total: list.data.total, onPageChange: setPage } : undefined}
    />
  );
}

/* --------------------------------- Calendar -------------------------------- */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function CalendarView({ filters, version, onOpen, onLoaded }: { filters: TaskFilters; version: number; onOpen: (id: string) => void; onLoaded: (items: TaskSummary[]) => void }) {
  const [month, setMonth] = useState(() => nairobiDate(new Date()).slice(0, 7));
  const grid = useMemo(() => calendarGrid(month), [month]);
  const cal = useAsync(async () => {
    const items = await tasksApi.calendar({
      from: grid.from,
      to: grid.to,
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    });
    onLoaded(items);
    return items;
  }, [grid.from, grid.to, filters.departmentId, filters.ownerId, version]);
  if (cal.error && !cal.data) return <LoadError error={cal.error} retry={() => void cal.reload()} />;
  // Priority and area filters are applied here (the calendar endpoint filters by department and owner).
  const visible = (cal.data ?? []).filter(
    (t) => (!filters.priority || t.priority === filters.priority) && (!filters.geographicUnitId || t.geography?.id === filters.geographicUnitId),
  );
  const byDay = tasksByDay(visible);
  const today = nairobiDate(new Date());
  const title = new Intl.DateTimeFormat('en-KE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <Card className="p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Button size="sm" variant="secondary" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <h2 className="text-section font-semibold text-navy" aria-live="polite">
          {title}
        </h2>
        <Button size="sm" variant="secondary" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <p className="mb-2 text-meta text-slate">Tasks appear on their due date (or start date when no due date is set). Times are Africa/Nairobi.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed border-collapse" aria-busy={cal.loading}>
          <caption className="sr-only">Tasks in {title}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col" className="border-b border-line py-1 text-meta font-semibold uppercase text-slate">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, w) => (
              <tr key={w}>
                {grid.days.slice(w * 7, w * 7 + 7).map((day) => {
                  const items = byDay.get(day) ?? [];
                  const inMonth = day.startsWith(month);
                  return (
                    <td key={day} className={cn('h-28 border border-line p-1 align-top', !inMonth && 'bg-cloud/60')}>
                      <div className={cn('mb-1 text-meta', day === today ? 'font-bold text-teal' : inMonth ? 'text-ink' : 'text-slate')}>
                        {Number(day.slice(8))}
                        {day === today ? <span className="sr-only"> (today)</span> : null}
                      </div>
                      <ul className="space-y-0.5">
                        {items.slice(0, 3).map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => onOpen(t.id)}
                              className={cn(
                                'block w-full truncate rounded px-1 text-left text-[11px] leading-5 hover:underline',
                                t.isOverdue ? 'bg-error/10 text-error' : t.status === 'COMPLETED' ? 'bg-success/10 text-success' : 'bg-deep-blue/10 text-deep-blue',
                              )}
                              title={`${t.reference} ${t.title}`}
                            >
                              {t.isOverdue ? 'Overdue: ' : t.status === 'COMPLETED' ? 'Done: ' : ''}
                              {t.title}
                            </button>
                          </li>
                        ))}
                        {items.length > 3 ? <li className="px-1 text-[11px] text-slate">+{items.length - 3} more</li> : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* --------------------------------- Workload -------------------------------- */

function WorkloadView({ query, queryKey, version, onPick }: { query: ReturnType<typeof filtersToQuery>; queryKey: string; version: number; onPick: (ownerId: string) => void }) {
  const wl = useAsync<TaskWorkload>(() => tasksApi.workload(query), [queryKey, version]);
  if (wl.error && !wl.data) return <LoadError error={wl.error} retry={() => void wl.reload()} />;
  const rows = wl.data?.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => r.open));
  const columns: Column<TaskWorkload['rows'][number]>[] = [
    { key: 'owner', header: 'Owner', sortValue: (r) => r.owner.displayName, cell: (r) => <PersonChip user={r.owner} /> },
    {
      key: 'open',
      header: 'Open tasks',
      sortValue: (r) => r.open,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span className="w-8 text-right tabular-nums">{formatNumber(r.open)}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-cloud" aria-hidden>
            <span className="block h-full bg-deep-blue" style={{ width: `${(r.open / max) * 100}%` }} />
          </span>
        </div>
      ),
    },
    { key: 'overdue', header: 'Overdue', align: 'right', sortValue: (r) => r.overdue, cell: (r) => <span className={r.overdue ? 'font-semibold text-error' : ''}>{formatNumber(r.overdue)}</span> },
    { key: 'blocked', header: 'Blocked', align: 'right', sortValue: (r) => r.blocked, cell: (r) => formatNumber(r.blocked) },
    { key: 'review', header: 'Awaiting review', align: 'right', sortValue: (r) => r.awaitingReview, cell: (r) => formatNumber(r.awaitingReview) },
    { key: 'week', header: 'Due this week', align: 'right', sortValue: (r) => r.dueThisWeek, cell: (r) => formatNumber(r.dueThisWeek) },
  ];
  return (
    <>
      <p className="mb-2 text-meta text-slate">
        Counts of tasks in your scope only{wl.data ? `, as of ${formatDateTime(wl.data.asOf)}` : ''}. Select a person to see their tasks.
      </p>
      <DataTable caption="Workload per owner" columns={columns} rows={rows} rowKey={(r) => r.owner.id} loading={wl.loading && !wl.data} onRowClick={(r) => onPick(r.owner.id)} emptyTitle="No open tasks in your scope" />
    </>
  );
}

