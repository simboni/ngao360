'use client';

import {
  type CreateMeeting,
  CreateMeetingSchema,
  type MeetingActionItem,
  type MeetingDetail,
  type MeetingSummary,
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '@ngao360/shared';
import { CheckCircle2, ListChecks, Plus, Scale, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import {
  describeOfficeError,
  Facts,
  FormField,
  formatDate,
  localInputToIso,
  SensitivityBadge,
  SENSITIVITY_LEVEL_LABELS,
  textareaClass,
} from '../correspondence/office-common';
import { MeetingStatusBadge } from './appointment-badges';
import { meetingsApi } from './appointments-api';

/** Lines of "Name — role" → participants (non-user participants; attendance INVITED). */
export function parseParticipants(text: string): CreateMeeting['participants'] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((l) => {
      const [name, ...rest] = l.split(/\s+[—–-]\s+/);
      const role = rest.join(' - ').trim();
      return { name: (name ?? l).trim().slice(0, 200), ...(role ? { role: role.slice(0, 120) } : {}), attendance: 'INVITED' as const };
    });
}

/** Meetings tab of the Office diary (blueprint 9.1, API §10.2). */
export function MeetingsPanel({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useAsync(() => meetingsApi.list({ page, pageSize: 25 }), [page]);

  const columns = useMemo<Column<MeetingSummary>[]>(
    () => [
      {
        key: 'title',
        header: 'Meeting',
        cell: (r) => (
          <div className="min-w-[220px]">
            <div className="font-medium text-ink">{r.title}</div>
            <div className="text-meta text-slate">{r.venue ?? 'No venue set'}</div>
          </div>
        ),
      },
      { key: 'when', header: 'When', sortValue: (r) => r.scheduledStart, className: 'whitespace-nowrap', cell: (r) => <span className="text-meta">{formatDateTime(r.scheduledStart)}</span> },
      { key: 'owner', header: 'Owner', cell: (r) => <span className="text-meta">{r.owner.displayName}</span> },
      {
        key: 'actions',
        header: 'Open actions',
        align: 'right',
        sortValue: (r) => r.openActionCount,
        cell: (r) => <span className="tabular-nums">{r.openActionCount}</span>,
      },
      { key: 'sensitivity', header: 'Sensitivity', cell: (r) => <SensitivityBadge level={r.sensitivity} size="sm" /> },
      { key: 'status', header: 'Status', cell: (r) => <MeetingStatusBadge status={r.status} size="sm" /> },
    ],
    [],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-body text-slate">Agenda, minutes, action items and an append-only decision log. Confidential meetings are visible only to their owner and listed participants.</p>
        {can('office.meetings.manage') ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Schedule meeting
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="error" className="mb-3">{describeOfficeError(error)}</Notice> : null}
      <DataTable
        caption="Meetings"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        loading={loading && !data}
        onRowClick={(r) => onOpen(r.id)}
        emptyTitle="No meetings recorded"
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
      />
      {creating ? (
        <NewMeetingDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            void reload();
            onOpen(m.id);
          }}
        />
      ) : null}
      {openId ? <MeetingDrawer id={openId} onClose={() => onOpen(null)} onChanged={() => void reload()} /> : null}
    </>
  );
}

function NewMeetingDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (m: MeetingDetail) => void }) {
  const { can } = useAuth();
  const [f, setF] = useState({ title: '', start: '', end: '', venue: '', onlineLink: '', sensitivity: 'INTERNAL' as SensitivityLevel, agenda: '', participants: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const levels = SENSITIVITY_LEVELS.filter((l) => l !== 'HIGHLY_RESTRICTED' || can('office.correspondence.confidential'));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      title: f.title.trim(),
      scheduledStart: localInputToIso(f.start),
      scheduledEnd: localInputToIso(f.end),
      venue: f.venue.trim() || undefined,
      onlineLink: f.onlineLink.trim() || undefined,
      sensitivity: f.sensitivity,
      agenda: f.agenda
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 50)
        .map((title) => ({ title: title.slice(0, 300) })),
      participants: parseParticipants(f.participants),
    };
    const res = CreateMeetingSchema.safeParse(body);
    if (!res.success) {
      setError(res.error.issues[0]?.message ?? 'Check the form.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await meetingsApi.create(res.data));
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Schedule a meeting"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="mt-new" loading={busy} disabled={f.title.trim().length < 3 || !f.start}>
            Schedule
          </Button>
        </>
      }
    >
      <form id="mt-new" onSubmit={submit}>
        <FormField id="mt-title" label="Title" required>
          <input id="mt-title" className="ngao-input" value={f.title} maxLength={300} onChange={(e) => set('title', e.target.value)} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="mt-start" label="Start" required hint="Nairobi time.">
            <input id="mt-start" type="datetime-local" className="ngao-input" value={f.start} onChange={(e) => set('start', e.target.value)} />
          </FormField>
          <FormField id="mt-end" label="End">
            <input id="mt-end" type="datetime-local" className="ngao-input" value={f.end} min={f.start || undefined} onChange={(e) => set('end', e.target.value)} />
          </FormField>
          <FormField id="mt-venue" label="Venue">
            <input id="mt-venue" className="ngao-input" value={f.venue} maxLength={200} onChange={(e) => set('venue', e.target.value)} />
          </FormField>
          <FormField id="mt-link" label="Online link">
            <input id="mt-link" type="url" className="ngao-input" value={f.onlineLink} maxLength={500} onChange={(e) => set('onlineLink', e.target.value)} />
          </FormField>
          <FormField id="mt-sens" label="Sensitivity" required>
            <select id="mt-sens" className="ngao-input pr-8" value={f.sensitivity} onChange={(e) => set('sensitivity', e.target.value as SensitivityLevel)}>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {SENSITIVITY_LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="mt-agenda" label="Agenda" hint="One item per line.">
          <textarea id="mt-agenda" className={textareaClass} value={f.agenda} onChange={(e) => set('agenda', e.target.value)} />
        </FormField>
        <FormField id="mt-parts" label="Participants" hint='One per line, e.g. "County Secretary — chair".'>
          <textarea id="mt-parts" className={textareaClass} value={f.participants} onChange={(e) => set('participants', e.target.value)} />
        </FormField>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function MeetingDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const manage = can('office.meetings.manage');
  const { data: m, error, loading, reload, setData } = useAsync(() => meetingsApi.get(id), [id]);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [minutesReason, setMinutesReason] = useState('');
  const [newAction, setNewAction] = useState({ description: '', ownerName: '', dueDate: '' });
  const [decision, setDecision] = useState({ decision: '', rationale: '', supersedesId: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await reload();
      onChanged();
      return true;
    } catch (e) {
      setErr(describeOfficeError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (status: 'HELD' | 'CANCELLED') => m && run(status, async () => setData(await meetingsApi.update(m.id, { status, expectedVersion: m.version })));
  const saveMinutes = () =>
    m &&
    minutes !== null &&
    run('minutes', async () => {
      setData(await meetingsApi.update(m.id, { minutes, expectedVersion: m.version, reason: minutesReason.trim() || undefined }));
      setMinutes(null);
      setMinutesReason('');
    });
  const saveActionStatus = (item: MeetingActionItem, status: 'DONE' | 'CANCELLED') =>
    m &&
    run(`ai-${item.id}`, () =>
      meetingsApi.updateActionItem(m.id, item.id, {
        description: item.description,
        ownerId: item.owner?.id,
        ownerName: item.ownerName ?? undefined,
        dueDate: item.dueDate ?? undefined,
        status,
      }),
    );

  return (
    <Dialog open onClose={onClose} variant="drawer" title={m?.title ?? 'Meeting'} description={m ? <MeetingStatusBadge status={m.status} /> : undefined}>
      {loading && !m ? <p className="text-slate">Loading…</p> : null}
      {error ? <Notice tone="error">{describeOfficeError(error)}</Notice> : null}
      {m ? (
        <div className="space-y-5">
          {err ? <Notice tone="error">{err}</Notice> : null}
          {manage && m.status === 'SCHEDULED' ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void setStatus('HELD')} loading={busy === 'HELD'}>
                Mark held
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void setStatus('CANCELLED')} loading={busy === 'CANCELLED'}>
                Cancel meeting
              </Button>
            </div>
          ) : null}
          <Facts
            items={[
              { label: 'When', value: `${formatDateTime(m.scheduledStart)}${m.scheduledEnd ? ` – ${formatDateTime(m.scheduledEnd)}` : ''}` },
              { label: 'Venue', value: m.venue ?? (m.onlineLink ? 'Online' : '—') },
              { label: 'Owner', value: m.owner.displayName },
              { label: 'Sensitivity', value: <SensitivityBadge level={m.sensitivity} size="sm" /> },
            ]}
          />
          <section>
            <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Agenda</h3>
            {m.agenda.length ? (
              <ol className="list-decimal space-y-0.5 pl-5 text-body">
                {m.agenda.map((a, i) => (
                  <li key={`${a.title}-${i}`}>
                    {a.title}
                    {a.presenter ? <span className="text-slate"> — {a.presenter}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-body text-slate">No agenda recorded.</p>
            )}
          </section>
          <section>
            <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Participants</h3>
            {m.participants.length ? (
              <ul className="space-y-0.5 text-body">
                {m.participants.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    {p.name}
                    {p.role ? <span className="text-slate"> — {p.role}</span> : null} <span className="text-meta text-slate">({p.attendance.toLowerCase()})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-slate">No participants listed.</p>
            )}
          </section>
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">Minutes</h3>
              {manage && minutes === null ? (
                <Button size="sm" variant="ghost" onClick={() => setMinutes(m.minutes ?? '')}>
                  {m.minutes ? 'Edit minutes' : 'Record minutes'}
                </Button>
              ) : null}
            </div>
            {minutes !== null ? (
              <div>
                <label htmlFor="mt-minutes" className="sr-only">
                  Minutes
                </label>
                <textarea id="mt-minutes" className={`${textareaClass} min-h-[160px]`} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                {m.minutesRecordedAt ? (
                  <FormField id="mt-min-reason" label="Reason for editing recorded minutes" required className="mt-2">
                    <input id="mt-min-reason" className="ngao-input" value={minutesReason} onChange={(e) => setMinutesReason(e.target.value)} />
                  </FormField>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void saveMinutes()} loading={busy === 'minutes'} disabled={!!m.minutesRecordedAt && minutesReason.trim().length < 3}>
                    Save minutes
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setMinutes(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : m.minutes ? (
              <>
                <p className="whitespace-pre-wrap text-body">{m.minutes}</p>
                <p className="mt-1 text-meta text-slate">
                  Recorded by {m.minutesRecordedBy?.displayName ?? '—'}, {formatDateTime(m.minutesRecordedAt)}
                </p>
              </>
            ) : (
              <p className="text-body text-slate">No minutes yet.</p>
            )}
          </section>
          <section>
            <h3 className="mb-1 flex items-center gap-1 text-meta font-semibold uppercase tracking-wide text-slate">
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              Action items
            </h3>
            {m.actionItems.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {m.actionItems.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className={a.status === 'OPEN' ? 'text-body' : 'text-body text-slate line-through'}>{a.description}</p>
                      <p className="text-meta text-slate">
                        {a.owner?.displayName ?? a.ownerName ?? 'No owner'} · due {formatDate(a.dueDate)} · {a.status === 'OPEN' ? 'Open' : a.status === 'DONE' ? `Done ${formatDateTime(a.completedAt)}` : 'Cancelled'}
                      </p>
                    </div>
                    {manage && a.status === 'OPEN' ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="secondary" onClick={() => void saveActionStatus(a, 'DONE')} loading={busy === `ai-${a.id}`} aria-label={`Mark "${a.description}" done`}>
                          <CheckCircle2 className="h-4 w-4" aria-hidden />
                          Done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void saveActionStatus(a, 'CANCELLED')} aria-label={`Cancel "${a.description}"`}>
                          <XCircle className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-slate">No action items.</p>
            )}
            {manage ? (
              <form
                className="mt-2 grid gap-2 sm:grid-cols-[1fr_160px_150px_auto]"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run('ai-new', () =>
                    meetingsApi.addActionItem(m.id, {
                      description: newAction.description.trim(),
                      ownerName: newAction.ownerName.trim() || undefined,
                      dueDate: newAction.dueDate || undefined,
                      status: 'OPEN',
                    }),
                  );
                  if (ok) setNewAction({ description: '', ownerName: '', dueDate: '' });
                }}
              >
                <input aria-label="New action item" className="ngao-input" placeholder="New action item" value={newAction.description} onChange={(e) => setNewAction({ ...newAction, description: e.target.value })} />
                <input aria-label="Owner" className="ngao-input" placeholder="Owner" value={newAction.ownerName} onChange={(e) => setNewAction({ ...newAction, ownerName: e.target.value })} />
                <input aria-label="Due date" type="date" className="ngao-input" value={newAction.dueDate} onChange={(e) => setNewAction({ ...newAction, dueDate: e.target.value })} />
                <Button type="submit" size="sm" className="h-10" loading={busy === 'ai-new'} disabled={newAction.description.trim().length < 3}>
                  Add
                </Button>
              </form>
            ) : null}
          </section>
          <section>
            <h3 className="mb-1 flex items-center gap-1 text-meta font-semibold uppercase tracking-wide text-slate">
              <Scale className="h-3.5 w-3.5" aria-hidden />
              Decision log
            </h3>
            <p className="mb-2 text-meta text-slate">Decisions are never edited. To change one, record a new decision that supersedes it.</p>
            {m.decisions.length ? (
              <ol className="space-y-2">
                {m.decisions.map((d) => {
                  const superseded = m.decisions.some((x) => x.supersedesId === d.id);
                  return (
                    <li key={d.id} className="rounded-lg border border-line px-3 py-2">
                      <p className={superseded ? 'text-body text-slate line-through' : 'text-body font-medium'}>{d.decision}</p>
                      {d.rationale ? <p className="text-meta text-slate">Rationale: {d.rationale}</p> : null}
                      <p className="text-meta text-slate">
                        {d.recordedBy.displayName}, {formatDateTime(d.recordedAt)}
                        {superseded ? ' · superseded' : ''}
                        {d.supersedesId ? ' · supersedes an earlier decision' : ''}
                      </p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-body text-slate">No decisions recorded.</p>
            )}
            {manage ? (
              <form
                className="mt-2 space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run('dec', () =>
                    meetingsApi.recordDecision(m.id, {
                      decision: decision.decision.trim(),
                      rationale: decision.rationale.trim() || undefined,
                      supersedesId: decision.supersedesId || undefined,
                    }),
                  );
                  if (ok) setDecision({ decision: '', rationale: '', supersedesId: '' });
                }}
              >
                <textarea aria-label="Decision" className={textareaClass} placeholder="Decision" value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })} />
                <input aria-label="Rationale" className="ngao-input" placeholder="Rationale (optional)" value={decision.rationale} onChange={(e) => setDecision({ ...decision, rationale: e.target.value })} />
                {m.decisions.length ? (
                  <select aria-label="Supersedes" className="ngao-input pr-8" value={decision.supersedesId} onChange={(e) => setDecision({ ...decision, supersedesId: e.target.value })}>
                    <option value="">Does not replace an earlier decision</option>
                    {m.decisions.map((d) => (
                      <option key={d.id} value={d.id}>
                        Supersedes: {d.decision.slice(0, 80)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button type="submit" size="sm" loading={busy === 'dec'} disabled={decision.decision.trim().length < 3}>
                  Record decision
                </Button>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}
