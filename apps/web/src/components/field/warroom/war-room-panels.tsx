'use client';

import {
  type Completeness,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUS_LABELS,
  type IncidentSummary,
  type OperationalStatus,
  PARALLEL_TALLY_DISCLAIMER,
  WAR_ROOM_LABEL,
  type WarRoomOverview,
} from '@ngao360/shared';
import { Activity, CheckCircle2, ClipboardList, FileStack, HeartPulse, type LucideIcon, Radio, Scale, Siren, Users, XCircle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { SeverityBadge } from '../common/field-badges';
import { formatAge, share, stationLabel, type TimelineEntry } from '../common/field-model';
import { CompletenessMeter } from '../common/field-ui';
import { statusCounts } from './warroom-model';

type PanelEnvelope = { label: string; asOf: string; completeness: Completeness; available: boolean };

/** Panel frame: title, the unofficial/internal label, freshness and completeness on every panel. */
export function Panel({
  id,
  title,
  icon: Icon,
  envelope,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  envelope: PanelEnvelope;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('ngao-card flex flex-col', className)}>
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={id} className="inline-flex items-center gap-2 text-card font-semibold text-ink">
            <Icon className="h-4 w-4 text-deep-blue" aria-hidden />
            {title}
          </h2>
          <p className="text-[11px] uppercase tracking-wide text-slate">Unofficial · internal · as of {formatDateTime(envelope.asOf)}</p>
        </div>
        {action}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        {envelope.available ? (
          <>
            {children}
            <CompletenessMeter value={envelope.completeness} compact />
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-body text-slate">
            Not available: the source module is off or your role cannot see it. No figures are shown rather than zeros.
          </p>
        )}
      </div>
      <p className="sr-only">{envelope.label}</p>
    </section>
  );
}

function Figure({ label, value, of, tone }: { label: string; value: number; of?: number; tone?: 'attention' | 'danger' }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-meta text-slate">{label}</dt>
      <dd className={cn('text-[24px] font-semibold leading-8 tabular-nums', tone === 'danger' ? 'text-error' : tone === 'attention' ? 'text-[#7a5a17]' : 'text-navy')}>
        {value.toLocaleString('en-KE')}
        {of !== undefined ? <span className="ml-1 text-body font-normal text-slate">of {of.toLocaleString('en-KE')}</span> : null}
      </dd>
    </div>
  );
}

export function StationStatusPanel({ o, active, onPick }: { o: WarRoomOverview; active: OperationalStatus | null; onPick: (s: OperationalStatus | null) => void }) {
  const counts = statusCounts(o.stationStatus.data);
  const expected = o.stationStatus.completeness.expected;
  return (
    <Panel id="wr-p-stations" title="Station status" icon={Radio} envelope={o.stationStatus}>
      <ul className="space-y-1">
        {counts.map(({ status, count }) => (
          <li key={status}>
            <button
              type="button"
              aria-pressed={active === status}
              onClick={() => onPick(active === status ? null : status)}
              className={cn('flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-cloud', active === status && 'bg-cloud ring-1 ring-deep-blue')}
            >
              <StatusBadge kind="operational" status={status} size="sm" />
              <span className="text-body tabular-nums text-ink">
                {count.toLocaleString('en-KE')} <span className="text-meta text-slate">({share(count, expected)})</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function AgentPanel({ o }: { o: WarRoomOverview }) {
  const a = o.agentOperations.data;
  const expected = o.agentOperations.completeness.expected;
  return (
    <Panel
      id="wr-p-agents"
      title="Agent check-in"
      icon={Users}
      envelope={o.agentOperations}
      action={
        <Link href="/field/deployment" className="text-meta font-medium text-teal hover:underline">
          Planner
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-3">
        <Figure label="Assigned slots" value={a.assignedSlots} />
        <Figure label="Confirmed" value={a.confirmed} of={a.assignedSlots} />
        <Figure label="Checked in" value={a.checkedIn} of={a.assignedSlots} />
        <Figure label="Stations not assigned" value={a.stationsNotAssigned} of={expected} tone={a.stationsNotAssigned ? 'attention' : undefined} />
        <Figure label="Agents with training completed" value={a.trainingCompletedAgents} />
      </dl>
      {a.assignedSlots > 0 ? (
        <div className="space-y-1" aria-hidden>
          <Bar label="Confirmed" value={a.confirmed} of={a.assignedSlots} />
          <Bar label="Checked in" value={a.checkedIn} of={a.assignedSlots} />
        </div>
      ) : null}
    </Panel>
  );
}

function Bar({ label, value, of }: { label: string; value: number; of: number }) {
  return (
    <div className="flex items-center gap-2 text-meta text-slate">
      <span className="w-20">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-cloud">
        <span className="block h-full bg-teal" style={{ width: `${of ? (value / of) * 100 : 0}%` }} />
      </span>
      <span className="w-12 text-right tabular-nums">{share(value, of)}</span>
    </div>
  );
}

export function IncidentPanel({ o, queue, canOpen }: { o: WarRoomOverview; queue: IncidentSummary[] | null; canOpen: boolean }) {
  const q = o.incidentQueue.data;
  const sev = new Map(q.bySeverity.map((s) => [s.severity, s.count]));
  return (
    <Panel
      id="wr-p-incidents"
      title="Incident queue"
      icon={Siren}
      envelope={o.incidentQueue}
      action={
        canOpen ? (
          <Link href="/field/incidents" className="text-meta font-medium text-teal hover:underline">
            Incident desk
          </Link>
        ) : null
      }
    >
      <dl className="grid grid-cols-3 gap-3">
        <Figure label="Open" value={q.open} />
        <Figure label="Unassigned" value={q.unassigned} tone={q.unassigned ? 'attention' : undefined} />
        <div>
          <dt className="text-meta text-slate">Oldest open</dt>
          <dd className="text-[20px] font-semibold leading-8 text-navy">{formatAge(q.oldestOpenMinutes)}</dd>
        </div>
      </dl>
      <ul className="flex flex-wrap gap-2" aria-label="Open incidents by severity">
        {INCIDENT_SEVERITIES.slice()
          .reverse()
          .map((s) => (
            <li key={s} className="inline-flex items-center gap-1">
              <SeverityBadge severity={s} size="sm" />
              <span className="text-body tabular-nums">{(sev.get(s) ?? 0).toLocaleString('en-KE')}</span>
            </li>
          ))}
      </ul>
      {q.byStatus.length ? (
        <p className="text-meta text-slate">{q.byStatus.map((s) => `${INCIDENT_STATUS_LABELS[s.status]} ${s.count}`).join(' · ')}</p>
      ) : null}
      {queue ? (
        <ol className="divide-y divide-line rounded-lg border border-line">
          {queue.length === 0 ? <li className="px-3 py-2 text-meta text-slate">No open incidents.</li> : null}
          {queue.map((i) => (
            <li key={i.id}>
              <Link href={`/field/incidents/${i.id}`} className="flex items-start gap-2 px-3 py-2 hover:bg-cloud">
                <SeverityBadge severity={i.severity} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta font-medium text-ink">
                    {i.reference} · {INCIDENT_CATEGORY_LABELS[i.category]}
                  </span>
                  <span className="block truncate text-[11px] text-slate">
                    {stationLabel(i.location)} · {INCIDENT_STATUS_LABELS[i.status]} · {i.assignee?.displayName ?? 'unassigned'}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate">{formatAge(i.ageMinutes)}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  );
}

export function FormIntakePanel({ o, canOpen }: { o: WarRoomOverview; canOpen: boolean }) {
  const f = o.formIntake.data;
  return (
    <Panel
      id="wr-p-intake"
      title="Tally intake progress"
      icon={FileStack}
      envelope={o.formIntake}
      action={
        canOpen ? (
          <Link href="/tally/inbox" className="text-meta font-medium text-teal hover:underline">
            Form inbox
          </Link>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <Figure label="Forms received" value={f.received} />
        <Figure label="Awaiting capture" value={f.awaitingCapture} />
        <Figure label="Awaiting second review" value={f.awaitingSecondReview} tone={f.awaitingSecondReview ? 'attention' : undefined} />
        <Figure label="Verified" value={f.verified} />
        <Figure label="Flagged" value={f.flagged} tone={f.flagged ? 'danger' : undefined} />
      </dl>
    </Panel>
  );
}

export function TallyPanel({ o, canOpen }: { o: WarRoomOverview; canOpen: boolean }) {
  const t = o.tallyVerification.data;
  const expected = o.tallyVerification.completeness.expected;
  return (
    <Panel
      id="wr-p-tally"
      title="Tally verification"
      icon={Scale}
      envelope={o.tallyVerification}
      action={
        canOpen ? (
          <Link href="/tally/results" className="text-meta font-medium text-teal hover:underline">
            Internal parallel tally
          </Link>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 gap-3">
        <Figure label="Stations verified" value={t.verifiedStations} of={expected} />
        <Figure label="Open discrepancies" value={t.openDiscrepancies} tone={t.openDiscrepancies ? 'attention' : undefined} />
      </dl>
      <p className="text-meta text-slate">Last internal snapshot: {formatDateTime(t.lastSnapshotAt)}</p>
      <p className="rounded-lg bg-cloud px-3 py-2 text-[11px] leading-4 text-slate">{PARALLEL_TALLY_DISCLAIMER}</p>
    </Panel>
  );
}

function Health({ ok, label }: { ok: boolean | null; label: string }) {
  const Icon = ok === null ? Activity : ok ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-body text-ink">{label}</span>
      <span className={cn('inline-flex items-center gap-1 text-meta font-medium', ok === null ? 'text-slate' : ok ? 'text-success' : 'text-error')}>
        <Icon className="h-3.5 w-3.5" aria-hidden /> {ok === null ? 'Not checked' : ok ? 'OK' : 'Problem'}
      </span>
    </li>
  );
}

export function HealthPanel({ o }: { o: WarRoomOverview }) {
  const h = o.systemHealth.data;
  return (
    <Panel id="wr-p-health" title="System health" icon={HeartPulse} envelope={o.systemHealth}>
      <ul className="space-y-1.5">
        <Health ok={h.apiOk} label="API" />
        <Health ok={h.databaseOk} label="Database" />
        <Health ok={h.queueOk} label="Job queue" />
      </ul>
      <dl className="grid grid-cols-2 gap-3">
        <Figure label="Sync items (15 min)" value={h.syncItemsLast15m} />
        <Figure label="Sync conflicts (15 min)" value={h.syncConflictsLast15m} tone={h.syncConflictsLast15m ? 'attention' : undefined} />
      </dl>
    </Panel>
  );
}

const TIMELINE_ICON: Record<TimelineEntry['kind'], LucideIcon> = { check_in: Radio, field_update: ClipboardList, incident: Siren };
const TIMELINE_KIND: Record<TimelineEntry['kind'], string> = { check_in: 'Check-in', field_update: 'Field update', incident: 'Incident' };

export function TimelinePanel({ entries, asOf }: { entries: TimelineEntry[]; asOf: string | null }) {
  return (
    <section aria-labelledby="wr-timeline" className="ngao-card flex flex-col">
      <div className="border-b border-line px-4 py-3">
        <h2 id="wr-timeline" className="inline-flex items-center gap-2 text-card font-semibold text-ink">
          <Activity className="h-4 w-4 text-deep-blue" aria-hidden /> Timeline
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-slate">
          {WAR_ROOM_LABEL} Latest check-ins, field updates and incidents from the stations and incidents in view{asOf ? `, as of ${formatDateTime(asOf)}` : ''}.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-meta text-slate">No activity yet.</p>
      ) : (
        <ol className="max-h-[520px] divide-y divide-line overflow-y-auto" aria-live="off">
          {entries.map((e, idx) => {
            const Icon = TIMELINE_ICON[e.kind];
            const body = (
              <>
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-meta font-medium text-ink">
                    <span className="sr-only">{TIMELINE_KIND[e.kind]}: </span>
                    {e.title}
                  </span>
                  <span className="block truncate text-[11px] text-slate">{e.detail}</span>
                </span>
                {e.severity ? <SeverityBadge severity={e.severity} size="sm" /> : null}
                <time dateTime={e.at} className="shrink-0 text-[11px] tabular-nums text-slate">
                  {formatDateTime(e.at)}
                </time>
              </>
            );
            return (
              <li key={`${e.kind}-${e.at}-${idx}`}>
                {e.href ? (
                  <Link href={e.href} className="flex items-start gap-2 px-4 py-2 hover:bg-cloud">
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-start gap-2 px-4 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
