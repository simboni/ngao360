'use client';

import {
  ATTENDANCE_ROLE_LABELS,
  type AttendanceRole,
  CAMPAIGN_EVENT_TYPE_LABELS,
  CAMPAIGN_EVENT_VISIBILITY_LABELS,
  type CampaignEventDetail,
  type CampaignEventStatus,
  CHECK_IN_METHOD_LABELS,
  type EventAfterActionReport,
  type EventAgendaItem,
  type EventAttendance,
  type EventLogisticsItem,
  formatMoney,
  LOGISTICS_ITEM_TYPE_LABELS,
  type LogisticsStatus,
  type MoneyMinor,
} from '@ngao360/shared';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  Eye,
  FileText,
  MapPin,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldOff,
  Trash2,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Facts, formatBytes, isoToLocalInput, ViewTabs } from '@/components/office/correspondence/office-common';
import {
  AfterActionBadge,
  describeCampaignError,
  EventStatusBadge,
  geoLabel,
  LogisticsStatusBadge,
  openSignedFile,
  PersonChip,
  TaskPriorityBadge,
  TaskStatusBadge,
  useAssignableUsers,
} from '@/components/org/campaign-common';
import { CreateTaskDialog } from '@/components/tasks/task-dialogs';
import { dueInfo } from '@/components/tasks/task-model';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  AddDocumentDialog,
  AfterActionDialog,
  AfterActionReviewDialog,
  CheckInDialog,
  DOC_KIND_LABELS,
  EventFormDialog,
  EventStatusDialog,
  ExportAttendanceDialog,
  LogisticsDialog,
  LogisticsStatusDialog,
  RevealContactDialog,
} from './event-dialogs';
import { type AgendaRow, agendaEnd, agendaPayload, attendanceOpen, compareBudget, EVENT_MOVE_LABELS, eventStatusOptions, formatCoordinates, LOGISTICS_MOVE_LABELS, logisticsOptions, venueCoordinates } from './event-model';
import { eventsApi } from './events-api';

type Tab = 'overview' | 'agenda' | 'tasks' | 'people' | 'logistics' | 'budget' | 'attendance' | 'documents' | 'report';

/** S09 Event detail (API §25). */
export function EventDetail({ id }: { id: string }) {
  const { data: ev, error, loading, reload, setData } = useAsync(() => eventsApi.get(id), [id]);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [move, setMove] = useState<CampaignEventStatus | null>(null);

  if (loading && !ev) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" aria-live="polite" />;
  if (error && !ev) {
    return (
      <>
        <PageHeader title="Event" breadcrumbs={[{ label: 'Campaign' }, { label: 'Events', href: '/events' }, { label: 'Event' }]} />
        <Card>
          <EmptyState icon={ShieldOff} title="This event could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </Card>
      </>
    );
  }
  if (!ev) return null;

  const allowed = (a: CampaignEventDetail['allowedActions'][number]) => ev.allowedActions.includes(a);
  const moves = eventStatusOptions(ev);
  const refresh = () => void reload();
  const tabs: ReadonlyArray<{ key: Tab; label: string; count?: number | null }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'agenda', label: 'Agenda', count: ev.agenda.length },
    { key: 'tasks', label: 'Tasks', count: ev.tasks.length },
    { key: 'people', label: 'People' },
    { key: 'logistics', label: 'Logistics', count: ev.logistics.length },
    { key: 'budget', label: 'Budget' },
    { key: 'attendance', label: 'Attendance', count: ev.attendanceCount },
    { key: 'documents', label: 'Documents', count: ev.documents.length },
    { key: 'report', label: 'After-action report' },
  ];

  return (
    <>
      <PageHeader
        title={ev.title}
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Events', href: '/events' }, { label: ev.reference }]}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <EventStatusBadge status={ev.status} />
            {ev.afterActionStatus ? <AfterActionBadge status={ev.afterActionStatus} /> : null}
          </span>
        }
        description={
          <span>
            {CAMPAIGN_EVENT_TYPE_LABELS[ev.type]} · {formatDateTime(ev.startsAt)} – {formatDateTime(ev.endsAt)}
            {ev.venueName ? ` · ${ev.venueName}` : ''}
          </span>
        }
        actions={
          <>
            {moves.map((to) => (
              <Button key={to} size="sm" variant={to === 'CANCELLED' || to === 'POSTPONED' || to === 'DRAFT' ? 'ghost' : 'secondary'} onClick={() => setMove(to)}>
                {EVENT_MOVE_LABELS[to]}
              </Button>
            ))}
            {allowed('EDIT') ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            ) : null}
          </>
        }
      />
      {ev.cancellationReason && (ev.status === 'CANCELLED' || ev.status === 'POSTPONED') ? (
        <Notice tone="warning" className="mb-4" title={ev.status === 'CANCELLED' ? 'Cancelled' : 'Postponed'}>
          {ev.cancellationReason}
        </Notice>
      ) : null}
      <ViewTabs label="Event sections" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'overview' ? <Overview ev={ev} /> : null}
      {tab === 'agenda' ? <AgendaPanel ev={ev} onSaved={setData} /> : null}
      {tab === 'tasks' ? <TasksPanel ev={ev} onChanged={refresh} /> : null}
      {tab === 'people' ? <PeoplePanel ev={ev} /> : null}
      {tab === 'logistics' ? <LogisticsPanel ev={ev} onChanged={refresh} /> : null}
      {tab === 'budget' ? <BudgetPanel ev={ev} /> : null}
      {tab === 'attendance' ? <AttendancePanel ev={ev} onChanged={refresh} /> : null}
      {tab === 'documents' ? <DocumentsPanel ev={ev} onChanged={refresh} /> : null}
      {tab === 'report' ? <ReportPanel ev={ev} onChanged={refresh} /> : null}

      <EventFormDialog open={editing} onClose={() => setEditing(false)} event={ev} onSaved={setData} />
      <EventStatusDialog to={move} onClose={() => setMove(null)} event={ev} onSaved={setData} />
    </>
  );
}

/* --------------------------------- Overview -------------------------------- */

function VenueMap({ ev }: { ev: CampaignEventDetail }) {
  const c = venueCoordinates(ev);
  return (
    <figure className="overflow-hidden rounded-lg border border-line">
      <div className="relative flex h-48 items-center justify-center bg-cloud" role="img" aria-label={c ? `Venue at ${formatCoordinates(c.lat, c.lng)}` : 'No venue coordinates recorded'}>
        <svg className="absolute inset-0 h-full w-full text-line" aria-hidden>
          <defs>
            <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
        <div className="relative flex flex-col items-center gap-1 text-center">
          <MapPin className={cn('h-8 w-8', c ? 'text-teal' : 'text-slate')} aria-hidden />
          <span className="text-body font-medium text-ink">{c ? formatCoordinates(c.lat, c.lng) : 'No coordinates'}</span>
          <span className="text-meta text-slate">Map preview is not configured; coordinates shown.</span>
        </div>
      </div>
      <figcaption className="px-3 py-2 text-meta text-slate">
        {ev.venueName ?? 'Venue not set'}
        {ev.venueAddress ? ` · ${ev.venueAddress}` : ''}
      </figcaption>
    </figure>
  );
}

function Overview({ ev }: { ev: CampaignEventDetail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="Details" />
        <CardBody className="space-y-4">
          {ev.purpose ? <p className="whitespace-pre-wrap text-body text-ink">{ev.purpose}</p> : null}
          <Facts
            items={[
              { label: 'Reference', value: ev.reference },
              { label: 'Type', value: CAMPAIGN_EVENT_TYPE_LABELS[ev.type] },
              { label: 'Starts', value: formatDateTime(ev.startsAt) },
              { label: 'Ends', value: formatDateTime(ev.endsAt) },
              { label: 'Organiser', value: <PersonChip user={ev.organiser} /> },
              { label: 'Department', value: ev.department ? `${ev.department.name} (${ev.department.code})` : 'Organisation-level' },
              { label: 'Area', value: geoLabel(ev.geography) },
              { label: 'Visibility', value: CAMPAIGN_EVENT_VISIBILITY_LABELS[ev.visibility] },
              { label: 'Planned budget', value: ev.budget ? formatMoney(ev.budget.amountMinor, ev.budget.currency) : 'Not shown or not set' },
              { label: 'Attendance', value: formatNumber(ev.attendanceCount) },
              { label: 'Created', value: `${ev.createdBy.displayName}, ${formatDateTime(ev.createdAt)}` },
              { label: 'Updated', value: formatDateTime(ev.updatedAt) },
            ]}
          />
        </CardBody>
      </Card>
      <Card className="self-start">
        <CardHeader title="Venue" />
        <CardBody>
          <VenueMap ev={ev} />
        </CardBody>
      </Card>
    </div>
  );
}

/* ---------------------------------- Agenda --------------------------------- */

function toRows(items: EventAgendaItem[]): AgendaRow[] {
  return items.map((i) => ({
    key: i.id,
    id: i.id,
    startsAt: isoToLocalInput(i.startsAt),
    durationMinutes: i.durationMinutes?.toString() ?? '',
    title: i.title,
    notes: i.notes ?? '',
    ownerId: i.owner?.id ?? '',
  }));
}

function AgendaPanel({ ev, onSaved }: { ev: CampaignEventDetail; onSaved: (e: CampaignEventDetail) => void }) {
  const canEdit = ev.allowedActions.includes('MANAGE_AGENDA');
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<AgendaRow[]>(() => toRows(ev.agenda));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useAssignableUsers({}, ev.agenda.map((a) => a.owner));
  useEffect(() => setRows(toRows(ev.agenda)), [ev.agenda]);
  const setRow = (i: number, patch: Partial<AgendaRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveRow = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs];
      const j = i + d;
      if (j < 0 || j >= next.length) return rs;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await eventsApi.saveAgenda(ev.id, { items: agendaPayload(rows), expectedVersion: ev.version }));
      setEditing(false);
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Agenda"
        actions={
          canEdit && !editing ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit agenda
            </Button>
          ) : null
        }
      />
      <CardBody>
        {!editing ? (
          ev.agenda.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No agenda yet" />
          ) : (
            <ol className="space-y-3">
              {ev.agenda.map((a) => {
                const end = agendaEnd(a);
                return (
                  <li key={a.id} className="flex gap-4 border-b border-line pb-3 last:border-0">
                    <div className="w-36 shrink-0 text-meta text-slate">
                      {a.startsAt ? formatDateTime(a.startsAt) : `Item ${a.position + 1}`}
                      {end ? <span className="block">until {new Date(end).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })}</span> : null}
                      {a.durationMinutes ? <span className="block">{a.durationMinutes} min</span> : null}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{a.title}</p>
                      {a.notes ? <p className="whitespace-pre-wrap text-body text-slate">{a.notes}</p> : null}
                      {a.owner ? <p className="mt-1 text-meta text-slate">Lead: {a.owner.displayName}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )
        ) : (
          <div className="space-y-3">
            {rows.map((r, i) => (
              <fieldset key={r.key} className="rounded-lg border border-line p-3">
                <legend className="px-1 text-meta font-semibold text-slate">Item {i + 1}</legend>
                <div className="grid gap-2 md:grid-cols-[1fr_180px_110px]">
                  <label className="text-meta text-slate">
                    Title
                    <input className="ngao-input mt-1" value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} maxLength={200} />
                  </label>
                  <label className="text-meta text-slate">
                    Starts
                    <input type="datetime-local" className="ngao-input mt-1" value={r.startsAt} onChange={(e) => setRow(i, { startsAt: e.target.value })} />
                  </label>
                  <label className="text-meta text-slate">
                    Minutes
                    <input type="number" min={1} max={1440} className="ngao-input mt-1" value={r.durationMinutes} onChange={(e) => setRow(i, { durationMinutes: e.target.value })} />
                  </label>
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-[1fr_220px]">
                  <label className="text-meta text-slate">
                    Notes
                    <input className="ngao-input mt-1" value={r.notes} onChange={(e) => setRow(i, { notes: e.target.value })} maxLength={2000} />
                  </label>
                  <label className="text-meta text-slate">
                    Lead
                    <select className="ngao-input mt-1" value={r.ownerId} onChange={(e) => setRow(i, { ownerId: e.target.value })}>
                      <option value="">No lead</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-2 flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => moveRow(i, -1)} disabled={i === 0} aria-label={`Move item ${i + 1} up`}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => moveRow(i, 1)} disabled={i === rows.length - 1} aria-label={`Move item ${i + 1} down`}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                    Remove
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, { key: `new-${Date.now()}`, startsAt: '', durationMinutes: '', title: '', notes: '', ownerId: '' }])}>
              <Plus className="h-4 w-4" aria-hidden />
              Add item
            </Button>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setRows(toRows(ev.agenda));
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button loading={busy} onClick={() => void save()}>
                <Save className="h-4 w-4" aria-hidden />
                Save agenda
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------- Tasks ---------------------------------- */

function TasksPanel({ ev, onChanged }: { ev: CampaignEventDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Tasks for this event"
        description="Tasks created from this event that you can see."
        actions={
          can('tasks.create') ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New task
            </Button>
          ) : null
        }
      />
      <CardBody>
        {ev.tasks.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No tasks yet" />
        ) : (
          <ul className="divide-y divide-line">
            {ev.tasks.map((t) => {
              const due = dueInfo(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/tasks/${t.id}`} className="min-w-0 hover:underline">
                    <span className="block text-meta text-slate">{t.reference}</span>
                    <span className="block font-medium text-ink">{t.title}</span>
                  </Link>
                  <span className="flex flex-wrap items-center gap-2 text-meta text-slate">
                    <TaskStatusBadge status={t.status} size="sm" />
                    <TaskPriorityBadge priority={t.priority} size="sm" />
                    <span>{t.owner.displayName}</span>
                    {due ? <span className={due.tone === 'danger' ? 'text-error' : ''}>{due.text}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <CreateTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={onChanged}
        source={{ type: 'EVENT', id: ev.id, label: ev.reference }}
        defaults={{ departmentId: ev.department?.id ?? null }}
      />
    </Card>
  );
}

/* ---------------------------------- People --------------------------------- */

function PeoplePanel({ ev }: { ev: CampaignEventDetail }) {
  const agendaLeads = new Map(ev.agenda.filter((a) => a.owner).map((a) => [a.owner!.id, a.owner!]));
  const custodians = new Map(ev.logistics.filter((l) => l.custodian).map((l) => [l.custodian!.id, l.custodian!]));
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader title="Organisers and leads" />
        <CardBody className="space-y-3">
          <PersonChip user={ev.organiser} suffix="Organiser" />
          {[...agendaLeads.values()].map((u) => (
            <div key={u.id}>
              <PersonChip user={u} suffix="Agenda lead" />
            </div>
          ))}
          {[...custodians.values()].map((u) => (
            <div key={u.id}>
              <PersonChip user={u} suffix="Logistics custodian" />
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={`Invited teams (${ev.invitedTeams.length})`} description="Team coordinators are notified in the app about changes." />
        <CardBody>
          {ev.invitedTeams.length === 0 ? (
            <p className="text-body text-slate">No teams invited.</p>
          ) : (
            <ul className="space-y-1">
              {ev.invitedTeams.map((t) => (
                <li key={t.id} className="text-body text-ink">
                  {t.name}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* --------------------------------- Logistics -------------------------------- */

function LogisticsPanel({ ev, onChanged }: { ev: CampaignEventDetail; onChanged: () => void }) {
  const can = ev.allowedActions.includes('MANAGE_LOGISTICS');
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ item: EventLogisticsItem; to: LogisticsStatus } | null>(null);
  return (
    <Card>
      <CardHeader
        title="Logistics and custody"
        actions={
          can ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add item
            </Button>
          ) : null
        }
      />
      <CardBody>
        {ev.logistics.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No logistics items" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-body">
              <caption className="sr-only">Logistics items</caption>
              <thead>
                <tr className="border-b border-line text-left text-meta uppercase text-slate">
                  <th scope="col" className="py-2 pr-3">Item</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Custodian</th>
                  <th scope="col" className="py-2 pr-3">Collection / return</th>
                  <th scope="col" className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ev.logistics.map((l) => (
                  <tr key={l.id} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3">
                      <p className="font-medium text-ink">
                        {l.quantity > 1 ? `${l.quantity} × ` : ''}
                        {l.description}
                      </p>
                      <p className="text-meta text-slate">
                        {LOGISTICS_ITEM_TYPE_LABELS[l.itemType]}
                        {l.assetReference ? ` · ${l.assetReference}` : ''}
                        {l.supplierName ? ` · ${l.supplierName}` : ''}
                      </p>
                      {l.damageNotes ? <p className="mt-1 text-meta text-error">{l.damageNotes}</p> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <LogisticsStatusBadge status={l.status} size="sm" />
                    </td>
                    <td className="py-2 pr-3">
                      <PersonChip user={l.custodian} />
                    </td>
                    <td className="py-2 pr-3 text-meta text-slate">
                      <p>Collect: {formatDateTime(l.collectionAt)}</p>
                      <p>Return due: {formatDateTime(l.returnDueAt)}</p>
                      {l.returnedAt ? <p>Returned: {formatDateTime(l.returnedAt)}</p> : null}
                    </td>
                    <td className="py-2">
                      {can ? (
                        <div className="flex flex-wrap gap-1">
                          {logisticsOptions(l.status).map((to) => (
                            <Button key={to} size="sm" variant={to === 'DAMAGED' || to === 'LOST' || to === 'CANCELLED' ? 'ghost' : 'secondary'} onClick={() => setMoving({ item: l, to })}>
                              {LOGISTICS_MOVE_LABELS[to]}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
      <LogisticsDialog open={adding} onClose={() => setAdding(false)} event={ev} onSaved={onChanged} />
      <LogisticsStatusDialog item={moving?.item ?? null} to={moving?.to ?? null} onClose={() => setMoving(null)} event={ev} onSaved={onChanged} />
    </Card>
  );
}

/* ---------------------------------- Budget --------------------------------- */

function money(m: MoneyMinor | null | undefined): string {
  return m ? formatMoney(m.amountMinor, m.currency) : '—';
}

function BudgetPanel({ ev }: { ev: CampaignEventDetail }) {
  const { can } = useAuth();
  const canFinance = can('finance.view');
  const lines = useAsync(() => eventsApi.budgetLines(ev.id), [ev.id], canFinance);
  const reported = ev.afterAction?.actualSpend ?? null;
  const cmp = compareBudget(ev.budget, reported);
  const ledgerActual = useMemo(() => {
    const ls = lines.data ?? [];
    if (!ls.length || !ev.budget) return null;
    const same = ls.filter((l) => l.actual.currency === ev.budget!.currency);
    return { amountMinor: same.reduce((n, l) => n + l.actual.amountMinor, 0), currency: ev.budget.currency };
  }, [lines.data, ev.budget]);
  const ledgerCmp = compareBudget(ev.budget, ledgerActual);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Budget vs actual" description="Amounts are stored as whole cents; nothing is rounded or converted between currencies." />
        <CardBody className="space-y-4">
          {!ev.budget ? (
            <Notice tone="info">No planned budget is set, or you do not have access to event budgets.</Notice>
          ) : (
            <>
              <BudgetBar label="Reported in the after-action report" cmp={cmp} />
              {canFinance ? <BudgetBar label="Posted in the finance ledger" cmp={ledgerCmp} /> : null}
            </>
          )}
        </CardBody>
      </Card>
      {canFinance ? (
        <Card>
          <CardHeader title="Finance budget lines" description="Read from the finance ledger (finance permission)." />
          <CardBody>
            {lines.error ? <Notice tone="error">{describeCampaignError(lines.error)}</Notice> : null}
            {lines.loading && !lines.data ? <div className="h-16 animate-pulse rounded bg-cloud" /> : null}
            {lines.data && lines.data.length === 0 ? <p className="text-body text-slate">No budget lines for this event.</p> : null}
            {lines.data?.length ? (
              <table className="w-full text-body">
                <caption className="sr-only">Budget lines</caption>
                <thead>
                  <tr className="border-b border-line text-left text-meta uppercase text-slate">
                    <th scope="col" className="py-2">Line</th>
                    <th scope="col" className="py-2 text-right">Budget</th>
                    <th scope="col" className="py-2 text-right">Committed</th>
                    <th scope="col" className="py-2 text-right">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.data.map((l) => (
                    <tr key={l.id} className="border-b border-line last:border-0">
                      <td className="py-2">
                        {l.name} <span className="text-meta text-slate">{l.code}</span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(l.amount)}</td>
                      <td className="py-2 text-right tabular-nums">{money(l.committed)}</td>
                      <td className="py-2 text-right tabular-nums">{money(l.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function BudgetBar({ label, cmp }: { label: string; cmp: ReturnType<typeof compareBudget> }) {
  const pct = Math.min(100, cmp.usedPercent ?? 0);
  const word =
    cmp.state === 'over'
      ? `Over budget by ${formatMoney(cmp.varianceMinor!, cmp.planned!.currency)}`
      : cmp.state === 'under'
        ? `Under budget by ${formatMoney(-cmp.varianceMinor!, cmp.planned!.currency)}`
        : cmp.state === 'on'
          ? 'Exactly on budget'
          : 'No actual figure yet';
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-body font-medium text-ink">{label}</p>
        <p className="text-meta text-slate">
          {money(cmp.actual)} of {money(cmp.planned)}
          {cmp.usedPercent !== null ? ` (${cmp.usedPercent}%)` : ''}
        </p>
      </div>
      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-cloud" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={word}>
        <div className={cn('h-full', cmp.state === 'over' ? 'bg-error' : 'bg-teal')} style={{ width: `${pct}%` }} />
      </div>
      <p className={cn('mt-1 text-meta', cmp.state === 'over' ? 'font-semibold text-error' : 'text-slate')}>{word}</p>
    </div>
  );
}

/* -------------------------------- Attendance -------------------------------- */

function AttendancePanel({ ev, onChanged }: { ev: CampaignEventDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const canView = can('events.attendance');
  const [page, setPage] = useState(1);
  const att = useAsync(() => eventsApi.attendance(ev.id, page), [ev.id, page], canView);
  const [checkIn, setCheckIn] = useState(false);
  const [reveal, setReveal] = useState<EventAttendance | null>(null);
  const [exporting, setExporting] = useState(false);
  const canRecord = ev.allowedActions.includes('RECORD_ATTENDANCE') && attendanceOpen(ev);
  const canContact = ev.allowedActions.includes('VIEW_ATTENDANCE_CONTACT');
  const canExport = can('events.attendance') && can('reports.export');
  if (!canView) {
    return (
      <Card>
        <EmptyState icon={ShieldOff} title="Attendance is restricted" description={`${formatNumber(ev.attendanceCount)} people checked in. Ask for attendance access to see names.`} />
      </Card>
    );
  }
  const summary = att.data?.summary;
  const pageCount = att.data ? Math.max(1, Math.ceil(att.data.total / att.data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader
        title="Attendance"
        description="Names, roles and check-in times. Contact details are kept separately, only with consent, and every reveal is audited."
        actions={
          <>
            {canExport ? (
              <Button size="sm" variant="secondary" onClick={() => setExporting(true)}>
                <Download className="h-4 w-4" aria-hidden />
                Export
              </Button>
            ) : null}
            {canRecord ? (
              <Button size="sm" onClick={() => setCheckIn(true)}>
                <UserCheck className="h-4 w-4" aria-hidden />
                Check in
              </Button>
            ) : null}
          </>
        }
      />
      <CardBody className="space-y-4">
        {summary ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-cloud px-3 py-2">
              <dt className="text-meta text-slate">Checked in</dt>
              <dd className="text-section font-semibold tabular-nums text-navy">{formatNumber(summary.total)}</dd>
            </div>
            <div className="rounded-lg bg-cloud px-3 py-2">
              <dt className="text-meta text-slate">With consented contact</dt>
              <dd className="text-section font-semibold tabular-nums text-navy">{formatNumber(summary.withContact)}</dd>
            </div>
            <div className="col-span-2 rounded-lg bg-cloud px-3 py-2">
              <dt className="text-meta text-slate">By role</dt>
              <dd className="text-body text-ink">
                {Object.entries(summary.byRole)
                  .map(([r, n]) => `${ATTENDANCE_ROLE_LABELS[r as AttendanceRole] ?? r}: ${n}`)
                  .join(' · ') || '—'}
              </dd>
            </div>
          </dl>
        ) : null}
        {att.error ? <Notice tone="error">{describeCampaignError(att.error)}</Notice> : null}
        {!attendanceOpen(ev) && ev.allowedActions.includes('RECORD_ATTENDANCE') ? (
          <p className="text-meta text-slate">Check-in is open while the event is planned, confirmed or in progress, and on the day it completes.</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-body">
            <caption className="sr-only">Attendees</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta uppercase text-slate">
                <th scope="col" className="py-2 pr-3">Name</th>
                <th scope="col" className="py-2 pr-3">Role</th>
                <th scope="col" className="py-2 pr-3">Method</th>
                <th scope="col" className="py-2 pr-3">Checked in</th>
                <th scope="col" className="py-2">Contact</th>
              </tr>
            </thead>
            <tbody>
              {att.loading && !att.data ? (
                <tr>
                  <td colSpan={5} className="py-4">
                    <div className="h-6 animate-pulse rounded bg-cloud" />
                  </td>
                </tr>
              ) : (att.data?.items ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate">
                    No one has checked in yet.
                  </td>
                </tr>
              ) : (
                att.data!.items.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">
                      <p className="font-medium text-ink">{a.participantName}</p>
                      {a.team ? <p className="text-meta text-slate">{a.team.name}</p> : null}
                    </td>
                    <td className="py-2 pr-3">{ATTENDANCE_ROLE_LABELS[a.role]}</td>
                    <td className="py-2 pr-3">{CHECK_IN_METHOD_LABELS[a.checkInMethod]}</td>
                    <td className="py-2 pr-3">{formatDateTime(a.checkedInAt)}</td>
                    <td className="py-2">
                      {a.hasContact ? (
                        canContact ? (
                          <Button size="sm" variant="ghost" onClick={() => setReveal(a)} aria-label={`Show contact details for ${a.participantName}`}>
                            <Eye className="h-4 w-4" aria-hidden />
                            Show (audited)
                          </Button>
                        ) : (
                          <span className="text-meta text-slate">Consented, restricted</span>
                        )
                      ) : (
                        <span className="text-meta text-slate">None</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {att.data && att.data.total > att.data.pageSize ? (
          <div className="flex items-center justify-between text-meta text-slate">
            <span>
              Page {page} of {pageCount}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        ) : null}
      </CardBody>
      <CheckInDialog
        open={checkIn}
        onClose={() => setCheckIn(false)}
        event={ev}
        onSaved={() => {
          void att.reload();
          onChanged();
        }}
      />
      <RevealContactDialog row={reveal} onClose={() => setReveal(null)} event={ev} />
      <ExportAttendanceDialog open={exporting} onClose={() => setExporting(false)} event={ev} />
    </Card>
  );
}

/* --------------------------------- Documents -------------------------------- */

function DocumentsPanel({ ev, onChanged }: { ev: CampaignEventDetail; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAdd = ev.allowedActions.includes('ADD_DOCUMENT');
  return (
    <Card>
      <CardHeader
        title="Documents"
        actions={
          canAdd ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add document
            </Button>
          ) : null
        }
      />
      <CardBody>
        {error ? <Notice tone="error" className="mb-2">{error}</Notice> : null}
        {ev.documents.length === 0 ? (
          <EmptyState icon={FileText} title="No documents" />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {ev.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-body text-ink">{d.file.originalFilename}</p>
                  <p className="text-meta text-slate">
                    {DOC_KIND_LABELS[d.kind]} · {formatBytes(d.file.sizeBytes)} · {d.addedBy.displayName} · {formatDateTime(d.createdAt)}
                    {d.note ? ` · ${d.note}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openSignedFile(`/events/${ev.id}/documents/${d.id}/url`).catch((err) => setError(describeCampaignError(err)))}>
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <AddDocumentDialog open={adding} onClose={() => setAdding(false)} event={ev} onSaved={onChanged} />
    </Card>
  );
}

/* ------------------------------- After-action ------------------------------- */

function ReportPanel({ ev, onChanged }: { ev: CampaignEventDetail; onChanged: () => void }) {
  const { me } = useAuth();
  const [writing, setWriting] = useState(false);
  const [review, setReview] = useState<'APPROVE' | 'RETURN' | null>(null);
  const r: EventAfterActionReport | null = ev.afterAction;
  const canWrite = ev.allowedActions.includes('WRITE_AFTER_ACTION') && ev.status === 'COMPLETED' && (!r || r.status === 'DRAFT' || r.status === 'RETURNED');
  const canApprove = ev.allowedActions.includes('APPROVE_AFTER_ACTION') && r?.status === 'SUBMITTED';
  const isAuthor = !!r && r.author.id === me?.user.id;
  return (
    <Card>
      <CardHeader
        title="After-action report"
        description="What happened, attendance, spend, issues and lessons. Approved reports are locked."
        actions={
          <>
            {canApprove && !isAuthor ? (
              <>
                <Button size="sm" onClick={() => setReview('APPROVE')}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setReview('RETURN')}>
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  Return
                </Button>
              </>
            ) : null}
            {canWrite ? (
              <Button size="sm" onClick={() => setWriting(true)}>
                {r ? <Pencil className="h-4 w-4" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                {r ? 'Edit report' : 'Write report'}
              </Button>
            ) : null}
          </>
        }
      />
      <CardBody className="space-y-4">
        {!r ? (
          <EmptyState
            icon={ClipboardList}
            title="No after-action report yet"
            description={ev.status === 'COMPLETED' ? 'The organiser writes the report once the event is completed.' : 'A report can be written once the event is completed.'}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <AfterActionBadge status={r.status} />
              {r.status === 'APPROVED' && r.reviewer ? (
                <span className="text-meta text-slate">
                  Approved by {r.reviewer.displayName}, {formatDateTime(r.reviewedAt)}
                </span>
              ) : null}
            </div>
            {canApprove && isAuthor ? (
              <Notice tone="sod" title="Separation of duties">
                You wrote this report, so another authorised person must approve it.
              </Notice>
            ) : null}
            {r.status === 'RETURNED' && r.reviewNote ? (
              <Notice tone="warning" title={`Returned by ${r.reviewer?.displayName ?? 'the reviewer'}`}>
                {r.reviewNote}
              </Notice>
            ) : null}
            <div>
              <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">What occurred</h3>
              <p className="whitespace-pre-wrap text-body text-ink">{r.whatOccurred}</p>
            </div>
            <Facts
              items={[
                { label: 'Author', value: r.author.displayName },
                { label: 'Total attendance', value: formatNumber(r.attendanceTotal) },
                {
                  label: 'By role',
                  value:
                    Object.entries(r.attendanceBreakdown)
                      .map(([k, n]) => `${ATTENDANCE_ROLE_LABELS[k as AttendanceRole] ?? k}: ${n}`)
                      .join(' · ') || '—',
                },
                { label: 'Actual spend (reported)', value: money(r.actualSpend) },
              ]}
            />
            {r.issues ? (
              <div>
                <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">Issues</h3>
                <p className="whitespace-pre-wrap text-body text-ink">{r.issues}</p>
              </div>
            ) : null}
            {r.lessons ? (
              <div>
                <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">Lessons</h3>
                <p className="whitespace-pre-wrap text-body text-ink">{r.lessons}</p>
              </div>
            ) : null}
            {r.evidence.length ? (
              <div>
                <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Evidence</h3>
                <ul className="space-y-1">
                  {r.evidence.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="inline-flex items-center gap-1 text-body text-deep-blue underline" onClick={() => void openSignedFile(`/events/${ev.id}/documents/${d.id}/url`)}>
                        <FileText className="h-4 w-4" aria-hidden />
                        {d.file.originalFilename}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
      <AfterActionDialog
        open={writing}
        onClose={() => setWriting(false)}
        event={ev}
        report={r}
        defaultTotal={ev.attendanceCount}
        onSaved={() => onChanged()}
      />
      {r ? <AfterActionReviewDialog decision={review} onClose={() => setReview(null)} event={ev} report={r} onSaved={() => onChanged()} /> : null}
    </Card>
  );
}
