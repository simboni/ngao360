'use client';

import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUSES, type AppointmentQuery, type AppointmentSummary } from '@ngao360/shared';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, List, Plus, RefreshCw, Users } from 'lucide-react';
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
import { dateInNairobi, describeOfficeError, FilterSelect, formatDate, ViewTabs } from '../correspondence/office-common';
import { AppointmentStatusBadge, MeetingStatusBadge } from './appointment-badges';
import { AppointmentDrawer, NewAppointmentDialog } from './appointment-dialogs';
import { appointmentStart, type DiaryEntry, followUpDue, groupByDay, nairobiTime, weekDays, weekStart, weekWindow } from './appointment-model';
import { appointmentsApi, meetingsApi } from './appointments-api';
import { MeetingsPanel } from './meetings-panel';

type Tab = 'requests' | 'week' | 'meetings';
type View = AppointmentQuery['view'];
const VIEWS: ReadonlyArray<{ key: View; label: string }> = [
  { key: 'pending', label: 'Requests to handle' },
  { key: 'all', label: 'All appointments' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'follow_up', label: 'Follow-up due' },
];

/** Office diary: appointment requests, a week view and meetings (blueprint 9.1, API §10). */
export function AppointmentsDiary() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '/office/appointments';
  const params = useSearchParams();
  const canAppointments = can('office.appointments.view');
  const canMeetings = can('office.meetings.view');
  const tabs = [
    ...(canAppointments
      ? [
          { key: 'requests' as Tab, label: 'Appointments' },
          { key: 'week' as Tab, label: 'Week' },
        ]
      : []),
    ...(canMeetings ? [{ key: 'meetings' as Tab, label: 'Meetings' }] : []),
  ];
  const tab = (tabs.find((t) => t.key === params?.get('tab'))?.key ?? tabs[0]?.key ?? 'requests') as Tab;
  const openAppointment = params?.get('appointment') ?? null;
  const openMeeting = params?.get('meeting') ?? null;
  const [creating, setCreating] = useState<{ start?: string } | null>(null);
  const [version, setVersion] = useState(0);

  const navigate = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title="Appointments and meetings"
        description="Appointment requests from walk-ins, calls and letters, the week's diary, and meetings with minutes, actions and decisions."
        breadcrumbs={[{ label: 'Office' }, { label: 'Appointments' }]}
        actions={
          <>
            <Button variant="secondary" onClick={() => setVersion((v) => v + 1)} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            {can('office.appointments.manage') && tab !== 'meetings' ? (
              <Button onClick={() => setCreating({})}>
                <Plus className="h-4 w-4" aria-hidden />
                Record request
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Diary sections">
        {tabs.map((t) => {
          const Icon = t.key === 'requests' ? List : t.key === 'week' ? CalendarDays : Users;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => navigate({ tab: t.key, view: null, page: null })}
              className={cn(
                'inline-flex h-10 items-center gap-2 rounded-lg px-4 text-body font-medium',
                tab === t.key ? 'bg-navy text-white' : 'border border-line bg-surface text-ink hover:bg-cloud',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'requests' ? <RequestsList key={version} onOpen={(id) => navigate({ appointment: id })} /> : null}
      {tab === 'week' ? (
        <WeekView key={version} showMeetings={canMeetings} onOpenAppointment={(id) => navigate({ appointment: id })} onOpenMeeting={(id) => navigate({ meeting: id, tab: 'meetings' })} />
      ) : null}
      {tab === 'meetings' ? <MeetingsPanel key={version} openId={openMeeting} onOpen={(id) => navigate({ meeting: id })} /> : null}

      {openAppointment && canAppointments ? (
        <AppointmentDrawer id={openAppointment} onClose={() => navigate({ appointment: null })} onChanged={() => setVersion((v) => v + 1)} />
      ) : null}
      {creating ? (
        <NewAppointmentDialog
          defaultStart={creating.start}
          onClose={() => setCreating(null)}
          onCreated={(a) => {
            setCreating(null);
            setVersion((v) => v + 1);
            navigate({ appointment: a.id });
          }}
        />
      ) : null}
    </>
  );
}

function RequestsList({ onOpen }: { onOpen: (id: string) => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/office/appointments';
  const params = useSearchParams();
  const view = (VIEWS.find((v) => v.key === params?.get('view'))?.key ?? 'pending') as View;
  const status = params?.get('status') ?? '';
  const page = Math.max(1, Number(params?.get('page') ?? 1) || 1);
  const today = dateInNairobi();
  const { data, error, loading } = useAsync(
    () => appointmentsApi.list({ view, page, pageSize: 25, status: (status || undefined) as AppointmentQuery['status'] }),
    [view, page, status],
  );
  const pending = useAsync(() => appointmentsApi.list({ view: 'pending', pageSize: 1 }).then((p) => p.total), []);
  const followUps = useAsync(() => appointmentsApi.list({ view: 'follow_up', pageSize: 1 }).then((p) => p.total), []);

  const set = (next: Record<string, string>) => {
    const sp = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if (!('page' in next)) sp.delete('page');
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  const columns = useMemo<Column<AppointmentSummary>[]>(
    () => [
      { key: 'reference', header: 'Reference', className: 'whitespace-nowrap', cell: (r) => <span className="font-medium text-deep-blue">{r.reference}</span> },
      {
        key: 'requester',
        header: 'Requester and purpose',
        cell: (r) => (
          <div className="min-w-[220px]">
            <div className="font-medium text-ink">
              {r.requesterName}
              {r.requesterOrganisation ? <span className="font-normal text-slate"> · {r.requesterOrganisation}</span> : null}
            </div>
            <div className="line-clamp-1 text-meta text-slate">{r.purpose}</div>
          </div>
        ),
      },
      {
        key: 'when',
        header: 'When',
        sortValue: (r) => appointmentStart(r) ?? '',
        className: 'whitespace-nowrap',
        cell: (r) =>
          r.confirmedStart ? (
            <span className="text-meta">{formatDateTime(r.confirmedStart)}</span>
          ) : r.preferredStart ? (
            <span className="text-meta">
              <span className="text-slate">Preferred </span>
              {formatDateTime(r.preferredStart)}
            </span>
          ) : (
            <span className="text-meta text-slate">Any time</span>
          ),
      },
      {
        key: 'office',
        header: 'Office / officer',
        cell: (r) => (
          <div className="text-meta">
            <div>{r.assignedOffice ?? '—'}</div>
            <div className="text-slate">{r.assignedTo?.displayName ?? 'No officer yet'}</div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (r) => (
          <div className="flex flex-col items-start gap-1">
            <AppointmentStatusBadge status={r.status} size="sm" />
            {followUpDue(r, today) ? (
              <span className="inline-flex items-center gap-1 text-meta text-[#7a5a17]">
                <Clock className="h-3 w-3" aria-hidden />
                Follow-up by {formatDate(r.followUpDate)}
              </span>
            ) : null}
          </div>
        ),
      },
    ],
    [today],
  );

  return (
    <>
      <ViewTabs
        label="Appointment views"
        value={view}
        onChange={(v) => set({ view: v === 'pending' ? '' : v })}
        tabs={VIEWS.map((v) => ({ ...v, count: v.key === 'pending' ? (pending.data ?? null) : v.key === 'follow_up' ? (followUps.data ?? null) : null }))}
      />
      <div className="mb-3 max-w-xs">
        <FilterSelect id="apt-status" label="Status" value={status} onChange={(v) => set({ status: v })} options={APPOINTMENT_STATUSES.map((s) => ({ value: s, label: APPOINTMENT_STATUS_LABELS[s] }))} />
      </div>
      {error ? <Notice tone="error" className="mb-3">{describeOfficeError(error)}</Notice> : null}
      <DataTable
        caption="Appointments"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        loading={loading && !data}
        onRowClick={(r) => onOpen(r.id)}
        emptyTitle={view === 'pending' ? 'No requests waiting' : 'No appointments match'}
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (p) => set({ page: String(p) }) } : undefined}
      />
    </>
  );
}

/** Declined, cancelled and did-not-attend appointments and cancelled meetings stay visible but dimmed. */
function isInactive(e: DiaryEntry): boolean {
  return e.kind === 'appointment' ? ['DECLINED', 'CANCELLED', 'NO_SHOW'].includes(e.item.status) : e.item.status === 'CANCELLED';
}

function WeekView({ showMeetings, onOpenAppointment, onOpenMeeting }: { showMeetings: boolean; onOpenAppointment: (id: string) => void; onOpenMeeting: (id: string) => void }) {
  const today = dateInNairobi();
  const [monday, setMonday] = useState(weekStart(today));
  const days = weekDays(monday);
  const win = weekWindow(monday);
  const appts = useAsync(() => appointmentsApi.list({ from: win.from, to: win.to, pageSize: 200 }), [monday]);
  const meetings = useAsync(() => meetingsApi.list({ from: win.from, to: win.to, pageSize: 200 }), [monday, showMeetings], showMeetings);
  const grouped = groupByDay(appts.data?.items ?? [], meetings.data?.items ?? [], days);
  const shift = (n: number) => {
    const d = new Date(`${monday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n * 7);
    setMonday(d.toISOString().slice(0, 10));
  };
  const dayLabel = (d: string) => new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

  return (
    <section aria-label="Week view">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => shift(-1)} aria-label="Previous week">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setMonday(weekStart(today))}>
          This week
        </Button>
        <Button variant="secondary" size="sm" onClick={() => shift(1)} aria-label="Next week">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <h2 className="ml-2 text-card font-semibold text-navy">
          Week of {formatDate(monday)} – {formatDate(days[6])}
        </h2>
        <span className="ml-auto text-meta text-slate">Times in Nairobi. Dashed entries are preferred times not yet confirmed.</span>
      </div>
      {appts.error ? <Notice tone="error" className="mb-3">{describeOfficeError(appts.error)}</Notice> : null}
      <div className="grid gap-2 md:grid-cols-7">
        {days.map((d) => {
          const entries = grouped[d] ?? [];
          return (
            <div key={d} className={cn('ngao-card flex min-h-[160px] flex-col p-2', d === today && 'ring-2 ring-deep-blue/40')}>
              <h3 className={cn('mb-2 text-meta font-semibold uppercase tracking-wide', d === today ? 'text-deep-blue' : 'text-slate')}>
                {dayLabel(d)}
                {d === today ? <span className="sr-only"> (today)</span> : null}
              </h3>
              {appts.loading && !appts.data ? <div className="h-3 w-2/3 animate-pulse rounded bg-cloud" /> : null}
              <ul className="flex flex-col gap-1.5">
                {entries.map((e) => (
                  <li key={`${e.kind}-${e.id}`}>
                    <button
                      type="button"
                      onClick={() => (e.kind === 'appointment' ? onOpenAppointment(e.id) : onOpenMeeting(e.id))}
                      className={cn(
                        'w-full rounded-lg border px-2 py-1.5 text-left hover:bg-cloud',
                        e.kind === 'meeting' ? 'border-teal/40 bg-teal/5' : e.tentative ? 'border-dashed border-gold/60' : 'border-deep-blue/30 bg-deep-blue/5',
                        isInactive(e) && 'opacity-60',
                      )}
                    >
                      <span className="block text-meta font-semibold tabular-nums text-ink">
                        {nairobiTime(e.start)} {e.kind === 'meeting' ? '· Meeting' : e.tentative ? '· Preferred' : ''}
                      </span>
                      <span className="line-clamp-2 block text-meta text-ink">{e.kind === 'appointment' ? e.item.requesterName : e.item.title}</span>
                      <span className="mt-1 block">
                        {e.kind === 'appointment' ? <AppointmentStatusBadge status={e.item.status} size="sm" /> : <MeetingStatusBadge status={e.item.status} size="sm" />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!entries.length && !(appts.loading && !appts.data) ? <p className="text-meta text-slate">Nothing scheduled</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
