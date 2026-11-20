'use client';

import {
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_ESCALATION_TARGET_LABELS,
  INCIDENT_OUTCOME_LABELS,
  type IncidentAllowedAction,
  type IncidentDetail as IncidentDetailDto,
  type IncidentEvent,
  type IncidentSubject,
} from '@ngao360/shared';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  CloudOff,
  FileText,
  History,
  Lock,
  MessageSquarePlus,
  Paperclip,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldAlert,
  Stethoscope,
  UserCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { MetaRow } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { IncidentStatusBadge, SeverityBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { auditActionLabel, formatAge, stationLabel } from '../common/field-model';
import { IncidentActionDialog, type IncidentDialogKind } from './incident-dialogs';
import { corrections, describeEventData, INCIDENT_EVENT_LABELS, SENSITIVITY_LABELS, sodHints } from './incident-model';

const ACTIONS: Array<{ action: IncidentAllowedAction; kind: IncidentDialogKind; label: string; icon: typeof CheckCircle2; primary?: boolean }> = [
  { action: 'triage', kind: 'triage', label: 'Triage', icon: Stethoscope, primary: true },
  { action: 'assign', kind: 'assign', label: 'Assign', icon: UserCheck },
  { action: 'escalate', kind: 'escalate', label: 'Escalate', icon: ArrowUpRight },
  { action: 'resolve', kind: 'resolve', label: 'Propose resolution', icon: CheckCircle2 },
  { action: 'close', kind: 'close', label: 'Close', icon: XCircle, primary: true },
  { action: 'reopen', kind: 'reopen', label: 'Reopen', icon: RotateCcw },
  { action: 'add_note', kind: 'note', label: 'Add note', icon: MessageSquarePlus },
  { action: 'add_correction', kind: 'correction', label: 'Add correction', icon: PencilLine },
  { action: 'refer', kind: 'refer', label: 'Refer', icon: Scale },
];

/** Incident detail (API §20): immutable original report, triage, workflow actions and the append-only timeline. */
export function IncidentDetail({ id }: { id: string }) {
  const { me } = useAuth();
  const inc = useAsync(() => fieldApi.incident(id), [id]);
  const [dialog, setDialog] = useState<IncidentDialogKind | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const i = inc.data;

  if (inc.error && !i) {
    return (
      <div>
        <BackLink />
        <Notice tone="error" title="Could not open this incident">
          {describeFieldError(inc.error)}
        </Notice>
      </div>
    );
  }
  if (!i) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 py-12 text-slate">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden /> Loading incident…
      </div>
    );
  }

  const allowed = new Set(i.allowedActions);
  const hints = sodHints(i, me?.user.id ?? null);
  const fixes = corrections(i.events);
  const done = () => {
    setDialog(null);
    void inc.reload();
  };

  return (
    <div>
      <BackLink />
      <PageHeader
        title={`${i.reference} · ${INCIDENT_CATEGORY_LABELS[i.category]}`}
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Incidents', href: '/field/incidents' }, { label: i.reference }]}
        description={`${stationLabel(i.location)} · reported ${formatDateTime(i.reportedAt)}${i.status !== 'CLOSED' ? ` · waiting ${formatAge(i.ageMinutes)}` : ''}`}
        status={
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={i.severity} />
            <IncidentStatusBadge status={i.status} />
            {i.evidenceHold ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-deep-blue/20 bg-deep-blue/10 px-2.5 py-0.5 text-meta font-medium text-deep-blue">
                <Lock className="h-3.5 w-3.5" aria-hidden /> Evidence hold
              </span>
            ) : null}
          </div>
        }
        actions={
          <Button variant="secondary" onClick={() => void inc.reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        }
      />

      {hints.length ? (
        <Notice tone="sod" className="mb-4" title="Separation of duties">
          {hints.join(' ')}
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <Lock className="h-4 w-4 text-slate" aria-hidden /> Original report
                </span>
              }
              description="As submitted. It cannot be edited; corrections are added beside it."
            />
            <CardBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
              <div>
                <dl>
                  <MetaRow label="Category reported">{INCIDENT_CATEGORY_LABELS[i.reportedCategory]}</MetaRow>
                  <MetaRow label="When it happened">{formatDateTime(i.occurredAt)}</MetaRow>
                  <MetaRow label="Station or area">{stationLabel(i.location)}</MetaRow>
                  {i.location.station && !i.location.station.inApprovedRegistry ? (
                    <MetaRow label="Registry">Station code no longer in the approved registry</MetaRow>
                  ) : null}
                  <MetaRow label="Place">{i.locationDescription ?? '—'}</MetaRow>
                  <MetaRow label="Location point">{i.point ? 'Attached by the reporter' : 'None'}</MetaRow>
                  <MetaRow label="Reporter">{i.reporter.displayName}</MetaRow>
                  <MetaRow label="Received">
                    {formatDateTime(i.reportedAt)}
                    {i.submittedOffline ? (
                      <span className="ml-1 inline-flex items-center gap-1 text-meta text-slate">
                        <CloudOff className="h-3.5 w-3.5" aria-hidden /> saved offline {i.clientCreatedAt ? formatDateTime(i.clientCreatedAt) : ''}
                      </span>
                    ) : null}
                  </MetaRow>
                </dl>
                <h3 className="mb-1 mt-3 text-meta font-semibold uppercase tracking-wide text-slate">What was observed</h3>
                <p className="whitespace-pre-wrap rounded-lg border border-line bg-cloud px-3 py-2 text-body text-ink">{i.description}</p>
              </div>
              <div>
                <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Corrections added later</h3>
                {fixes.length === 0 ? (
                  <p className="text-meta text-slate">None.</p>
                ) : (
                  <ul className="space-y-2">
                    {fixes.map((c) => (
                      <li key={c.id} className="rounded-lg border border-gold/50 bg-gold/10 px-3 py-2">
                        <p className="text-meta text-slate">
                          {formatDateTime(c.createdAt)} · {c.actor.displayName}
                        </p>
                        {describeEventData(c).map((line) => (
                          <p key={line} className="text-body font-medium text-ink">
                            {line}
                          </p>
                        ))}
                        {c.note ? <p className="text-body text-ink">{c.note}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <EvidenceList incident={i} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Timeline" description="Append-only: every step, note, correction, referral and evidence change, oldest first." />
            <Timeline events={i.events} />
          </Card>

          <Card>
            <CardHeader
              title="Audit history"
              description="From the audit log; restricted subject views are listed without their content."
              actions={
                <Button size="sm" variant="secondary" aria-expanded={showAudit} onClick={() => setShowAudit((s) => !s)}>
                  <History className="h-4 w-4" aria-hidden /> {showAudit ? 'Hide' : 'Show'}
                </Button>
              }
            />
            {showAudit ? <AuditList id={i.id} /> : null}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Actions" description="Only the steps your role allows in the current status are shown." />
            <CardBody className="flex flex-wrap gap-2">
              {ACTIONS.filter((a) => allowed.has(a.action)).map((a) => (
                <Button key={a.kind} variant={a.primary ? 'primary' : 'secondary'} size="sm" onClick={() => setDialog(a.kind)}>
                  <a.icon className="h-4 w-4" aria-hidden /> {a.label}
                </Button>
              ))}
              {allowed.has('evidence_hold') ? (
                <Button variant="secondary" size="sm" onClick={() => setDialog(i.evidenceHold ? 'release' : 'hold')}>
                  <Lock className="h-4 w-4" aria-hidden /> {i.evidenceHold ? 'Release evidence hold' : 'Place evidence hold'}
                </Button>
              ) : null}
              {i.allowedActions.length === 0 ? <p className="text-meta text-slate">No actions available to you.</p> : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Triage and handling" />
            <CardBody>
              <dl>
                <MetaRow label="Working category">{INCIDENT_CATEGORY_LABELS[i.category]}</MetaRow>
                <MetaRow label="Severity">
                  <SeverityBadge severity={i.severity} size="sm" />
                </MetaRow>
                <MetaRow label="Sensitivity">{SENSITIVITY_LABELS[i.sensitivity]}</MetaRow>
                <MetaRow label="Assigned to">{i.assignee?.displayName ?? 'Unassigned'}</MetaRow>
                <MetaRow label="Escalated to">{i.escalatedTo ? INCIDENT_ESCALATION_TARGET_LABELS[i.escalatedTo] : '—'}</MetaRow>
                <MetaRow label="Outcome">{i.outcome ? INCIDENT_OUTCOME_LABELS[i.outcome] : '—'}</MetaRow>
                {i.resolutionNote ? (
                  <MetaRow label="Resolution">
                    {i.resolutionNote}
                    {i.resolvedBy ? <span className="block text-meta text-slate">by {i.resolvedBy.displayName}</span> : null}
                  </MetaRow>
                ) : null}
                {i.closureNote ? (
                  <MetaRow label="Closure">
                    {i.closureNote}
                    <span className="block text-meta text-slate">
                      {i.closedBy ? `by ${i.closedBy.displayName}` : ''} {i.closedAt ? formatDateTime(i.closedAt) : ''}
                    </span>
                  </MetaRow>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          <SubjectCard incident={i} onRecord={() => setDialog('subject')} />
        </div>
      </div>

      {dialog ? <IncidentActionDialog kind={dialog} incident={i} onClose={() => setDialog(null)} onDone={done} /> : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/field/incidents" className="mb-3 inline-flex items-center gap-1 text-meta text-slate hover:text-ink">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Incident queue
    </Link>
  );
}

function EvidenceList({ incident }: { incident: IncidentDetailDto }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (fileId: string) => {
    setError(null);
    try {
      const res = await fieldApi.incidentEvidenceUrl(incident.id, fileId);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setError(describeFieldError(err));
    }
  };
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Evidence</h3>
      {incident.evidence.length === 0 ? (
        <p className="text-meta text-slate">No files.</p>
      ) : (
        <ul className="space-y-1.5">
          {incident.evidence.map((e) => (
            <li key={e.fileId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
              <span className="min-w-0 text-meta">
                <span className="inline-flex items-center gap-1 text-ink">
                  <Paperclip className="h-3.5 w-3.5" aria-hidden /> {e.mimeType} · {(e.sizeBytes / 1024).toFixed(0)} KB
                </span>
                <span className="block text-slate">
                  {e.original ? 'With the original report' : `Added by ${e.addedBy.displayName}`} · SHA-256 {e.sha256.slice(0, 12)}…
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void open(e.fileId)} aria-label={`Open evidence file ${e.sha256.slice(0, 12)}`}>
                <FileText className="h-4 w-4" aria-hidden /> Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-meta text-slate">Opening a file is recorded in the audit log.</p>
      {error ? <Notice tone="error" className="mt-2">{error}</Notice> : null}
    </div>
  );
}

const EVENT_TONE: Partial<Record<IncidentEvent['type'], string>> = {
  ESCALATED: 'border-error',
  CORRECTION: 'border-gold',
  RESOLVED: 'border-teal',
  CLOSED: 'border-slate',
  REOPENED: 'border-gold',
  EVIDENCE_HOLD_PLACED: 'border-deep-blue',
};

export function Timeline({ events }: { events: IncidentEvent[] }) {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className="space-y-0 px-4 py-3">
      {sorted.map((e) => (
        <li key={e.id} className={cn('relative border-l-2 pb-4 pl-4 last:pb-0', EVENT_TONE[e.type] ?? 'border-line')}>
          <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-navy" aria-hidden />
          <p className="text-body font-medium text-ink">{INCIDENT_EVENT_LABELS[e.type]}</p>
          <p className="text-meta text-slate">
            {formatDateTime(e.createdAt)} · {e.actor.displayName}
          </p>
          {describeEventData(e).map((line) => (
            <p key={line} className="text-meta text-ink">
              {line}
            </p>
          ))}
          {e.note ? <p className="mt-0.5 whitespace-pre-wrap text-body text-ink">{e.note}</p> : null}
          {e.fileIds.length ? <p className="text-meta text-slate">{e.fileIds.length} file(s)</p> : null}
        </li>
      ))}
    </ol>
  );
}

function AuditList({ id }: { id: string }) {
  const h = useAsync(() => fieldApi.incidentHistory(id), [id]);
  if (h.error) return <Notice tone="error" className="m-4">{describeFieldError(h.error)}</Notice>;
  if (!h.data) return <p className="px-4 py-3 text-meta text-slate">Loading…</p>;
  return (
    <ol className="divide-y divide-line">
      {h.data.map((e) => (
        <li key={e.id} className="px-4 py-2">
          <p className="text-body text-ink">{auditActionLabel(e.action)}</p>
          <p className="text-meta text-slate">
            {formatDateTime(e.occurredAt)} · {e.actor?.displayName ?? 'System'}
            {e.reason ? ` · ${e.reason}` : ''}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Restricted subject record (API §20 subject). Never loaded automatically:
 * viewing is a deliberate, audited action for holders of the permission.
 */
function SubjectCard({ incident, onRecord }: { incident: IncidentDetailDto; onRecord: () => void }) {
  const { run } = useTallyActions();
  const canView = incident.allowedActions.includes('view_subject');
  const canRecord = incident.allowedActions.includes('record_subject');
  const [subjects, setSubjects] = useState<IncidentSubject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canView && !canRecord && !incident.hasSubject) return null;
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setSubjects(await run(() => fieldApi.incidentSubjects(incident.id)));
    } catch (err) {
      setError(describeFieldError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-deep-blue" aria-hidden /> Restricted subject
          </span>
        }
        description="Who or what the report concerns, recorded only when a referral needs it. Stated as reported, never as a finding."
      />
      <CardBody className="space-y-3">
        <p className="text-body text-ink">{incident.hasSubject ? 'A restricted subject record exists.' : 'No subject record.'}</p>
        {subjects ? (
          <ul className="space-y-2">
            {subjects.map((s, idx) => (
              <li key={`${s.recordedAt}-${idx}`} className="rounded-lg border border-deep-blue/20 bg-deep-blue/5 px-3 py-2">
                <p className="whitespace-pre-wrap text-body text-ink">{s.description}</p>
                <p className="text-meta text-slate">
                  {formatDateTime(s.recordedAt)} · {s.recordedBy.displayName}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          {canView && incident.hasSubject && !subjects ? (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}>
              View (audited)
            </Button>
          ) : null}
          {subjects ? (
            <Button size="sm" variant="ghost" onClick={() => setSubjects(null)}>
              Hide
            </Button>
          ) : null}
          {canRecord ? (
            <Button size="sm" variant="secondary" onClick={onRecord}>
              Add record
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
