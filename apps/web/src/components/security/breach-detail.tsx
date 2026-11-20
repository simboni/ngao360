'use client';

/**
 * Breach record (blueprint 15.4; API §30): steps, assessment, notification
 * decision, remediation and lessons, the append-only timeline with evidence,
 * and the audited timeline export (re-authentication). Closing needs lessons
 * learned and someone other than the reporter.
 */
import {
  type AddBreachEvent,
  type BreachDetail,
  type BreachEventType,
  BREACH_SEVERITIES,
  BREACH_STATUS_LABELS,
  type BreachSeverity,
  type ExportBreachTimeline,
  type SignedUrlResponse,
  type UpdateBreach,
} from '@ngao360/shared';
import { Check, Download, ExternalLink, Pencil, Plus, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { Facts, FormField, isoToLocalInput, localInputToIso, SensitivityBadge, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { BREACH_DATA_CATEGORY_LABELS, BREACH_EVENT_TYPE_LABELS, BREACH_SEVERITY_LABELS, BREACH_STEPS, breachStepIndex, closeBlockers, elapsedSince, eventTypesForCaller } from './breach-model';
import { BreachSeverityBadge, BreachStatusBadge, DrillBadge, LiveBadge } from './breach-ui';
import { securityApi } from './security-api';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

export function BreachDetailView({ id }: { id: string }) {
  const { me } = useAuth();
  const { data: b, error, loading, reload, setData } = useAsync(() => securityApi.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (loading && !b) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  if (error && !b) {
    return (
      <>
        <PageHeader title="Breach record" breadcrumbs={[{ label: 'Administration' }, { label: 'Breach register', href: '/security/breaches' }, { label: 'Record' }]} />
        <Card>
          <EmptyState icon={ShieldOff} title="This record could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </Card>
      </>
    );
  }
  if (!b) return null;
  const can = (a: BreachDetail['allowedActions'][number]) => b.allowedActions.includes(a);
  const blockers = closeBlockers(b, me?.user.id);

  return (
    <>
      <PageHeader
        title={b.title}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Breach register', href: '/security/breaches' }, { label: b.reference }]}
        status={
          <span className="flex flex-wrap gap-2">
            <BreachStatusBadge status={b.status} />
            <BreachSeverityBadge severity={b.severity} />
            {b.isDrill ? <DrillBadge size="md" /> : <LiveBadge size="md" />}
          </span>
        }
        description={`${b.reference} · detected ${formatDateTime(b.detectedAt)}${b.closedAt ? ` · closed ${formatDateTime(b.closedAt)}` : ` · open for ${elapsedSince(b.detectedAt)}`}`}
        actions={
          <>
            {can('EDIT') ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit record
              </Button>
            ) : null}
            {can('ADD_EVENT') || can('ADVANCE') || can('CLOSE') || can('REOPEN') ? (
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Add timeline entry
              </Button>
            ) : null}
            {can('EXPORT') ? (
              <Button variant="secondary" onClick={() => setExporting(true)}>
                <Download className="h-4 w-4" aria-hidden />
                Export timeline
              </Button>
            ) : null}
          </>
        }
      />
      {b.isDrill ? (
        <Notice tone="info" className="mb-4" title="Drill">
          This record is an exercise. It follows the real steps and is labelled as a drill in every list and export.
        </Notice>
      ) : null}

      <nav aria-label="Breach response steps" className="ngao-card mb-4 overflow-x-auto p-3">
        <ol className="flex min-w-max items-center gap-2">
          {BREACH_STEPS.map((s, i) => {
            const cur = breachStepIndex(b.status);
            const done = i < cur || b.status === 'CLOSED';
            const here = i === cur;
            return (
              <li key={s} className="flex items-center gap-2" aria-current={here ? 'step' : undefined}>
                <span
                  className={cn('flex h-6 w-6 items-center justify-center rounded-full border text-meta font-semibold', done ? 'border-success bg-success text-white' : here ? 'border-deep-blue bg-deep-blue text-white' : 'border-line bg-surface text-slate')}
                  aria-hidden
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={cn('text-body', here ? 'font-semibold text-navy' : 'text-ink')}>
                  {BREACH_STATUS_LABELS[s]}
                  <span className="sr-only">{done ? ', done' : here ? ', current step' : ', not reached'}</span>
                </span>
                {i < BREACH_STEPS.length - 1 ? <span className="h-px w-4 bg-line" aria-hidden /> : null}
              </li>
            );
          })}
        </ol>
      </nav>

      {b.status === 'REMEDIATED' && blockers.length ? (
        <Notice tone="sod" className="mb-4" title="Before this record can be closed">
          <ul className="list-disc pl-4">
            {blockers.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="What happened" />
            <CardBody>
              <p className="whitespace-pre-wrap text-body text-ink">{b.description}</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Response" description="Containment, assessment, notification decision, remediation and lessons." />
            <CardBody>
              <Facts
                className="sm:grid-cols-1"
                items={[
                  { label: 'Containment', value: b.containmentSummary ?? '—' },
                  { label: 'Scope and risk assessment', value: b.riskAssessment ?? '—' },
                  { label: 'Notification decision and legal basis', value: b.notificationDecision ?? '—' },
                  { label: 'Remediation', value: b.remediationSummary ?? '—' },
                  { label: 'Lessons learned', value: b.lessonsLearned ?? '—' },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Timeline" description="Append-only, by when each step happened." />
            <CardBody>
              <ol className="relative space-y-3 border-l border-line pl-5">
                {b.timeline.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={cn('absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface', e.toStatus && e.toStatus !== e.fromStatus ? 'bg-deep-blue' : 'bg-slate')} aria-hidden />
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="font-medium text-ink">{BREACH_EVENT_TYPE_LABELS[e.type]}</span>
                      {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? (
                        <span className="inline-flex items-center gap-1">
                          <BreachStatusBadge status={e.fromStatus} size="sm" />→<BreachStatusBadge status={e.toStatus} size="sm" />
                        </span>
                      ) : null}
                      <span className="text-meta text-slate">
                        <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time> · {e.actor.displayName}
                        {e.createdAt !== e.occurredAt ? ` · recorded ${formatDateTime(e.createdAt)}` : ''}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-body text-ink">{e.note}</p>
                    {e.evidence ? <EvidenceLink breachId={b.id} eventId={e.id} name={e.evidence.originalFilename} /> : null}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader title="Record" />
          <CardBody>
            <Facts
              className="sm:grid-cols-1"
              items={[
                { label: 'Reference', value: b.reference },
                { label: 'Type', value: b.isDrill ? 'Drill (exercise)' : 'Real incident' },
                { label: 'Severity', value: BREACH_SEVERITY_LABELS[b.severity] },
                { label: 'Detected', value: formatDateTime(b.detectedAt) },
                { label: 'Reported by', value: b.reportedBy.displayName },
                { label: 'Owner', value: b.owner?.displayName ?? '—' },
                { label: 'Categories of data', value: b.dataCategories.length ? b.dataCategories.map((c) => BREACH_DATA_CATEGORY_LABELS[c]).join(', ') : '—' },
                { label: 'People affected (estimate)', value: b.estimatedSubjects === null ? 'Unknown' : b.estimatedSubjects.toLocaleString('en-KE') },
                { label: 'Systems affected', value: b.systemsAffected ?? '—' },
                { label: 'Controller notified', value: formatDateTime(b.controllerNotifiedAt) },
                { label: 'Regulator notified', value: formatDateTime(b.regulatorNotifiedAt) },
                { label: 'Affected people notified', value: formatDateTime(b.subjectsNotifiedAt) },
                { label: 'Closed', value: b.closedAt ? `${formatDateTime(b.closedAt)} by ${b.closedBy?.displayName ?? '—'}` : '—' },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {editing ? <EditBreachDialog b={b} onClose={() => setEditing(false)} onSaved={setData} /> : null}
      {adding ? <AddEventDialog b={b} onClose={() => setAdding(false)} onSaved={setData} /> : null}
      {exporting ? <ExportTimelineDialog b={b} onClose={() => setExporting(false)} /> : null}
    </>
  );
}

function EvidenceLink({ breachId, eventId, name }: { breachId: string; eventId: string; name: string }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          setErr(null);
          try {
            const { url } = await securityApi.evidenceUrl(breachId, eventId);
            window.open(url, '_blank', 'noopener,noreferrer');
          } catch (e) {
            setErr(describeCampaignError(e));
          }
        }}
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        Evidence: {name}
      </Button>
      {err ? <span className="text-meta text-error">{err}</span> : null}
    </span>
  );
}

function EditBreachDialog({ b, onClose, onSaved }: { b: BreachDetail; onClose: () => void; onSaved: (b: BreachDetail) => void }) {
  const [f, setF] = useState({
    title: b.title,
    severity: b.severity,
    estimatedSubjects: b.estimatedSubjects === null ? '' : String(b.estimatedSubjects),
    systemsAffected: b.systemsAffected ?? '',
    containmentSummary: b.containmentSummary ?? '',
    riskAssessment: b.riskAssessment ?? '',
    notificationDecision: b.notificationDecision ?? '',
    remediationSummary: b.remediationSummary ?? '',
    lessonsLearned: b.lessonsLearned ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = (k: keyof typeof f) => (f[k] as string).trim() || null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: UpdateBreach = {
        title: f.title.trim(),
        severity: f.severity,
        estimatedSubjects: f.estimatedSubjects.trim() ? Number(f.estimatedSubjects) : null,
        systemsAffected: t('systemsAffected'),
        containmentSummary: t('containmentSummary'),
        riskAssessment: t('riskAssessment'),
        notificationDecision: t('notificationDecision'),
        remediationSummary: t('remediationSummary'),
        lessonsLearned: t('lessonsLearned'),
        expectedVersion: b.version,
      };
      onSaved(await securityApi.update(b.id, body));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  const area = (id: string, label: string, k: keyof typeof f, hint?: string) => (
    <FormField id={id} label={label} hint={hint}>
      <textarea id={id} className={textareaClass} value={f[k] as string} maxLength={5000} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </FormField>
  );
  return (
    <Dialog open onClose={onClose} size="lg" variant="drawer" title={`Edit ${b.reference}`} description="Reference, drill flag, detection time and reporter cannot be changed.">
      <form onSubmit={submit}>
        <FormField id="eb-title" label="Title" required>
          <input id="eb-title" className="ngao-input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="eb-sev" label="Severity" required>
            <select id="eb-sev" className="ngao-input pr-8" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as BreachSeverity })}>
              {BREACH_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {BREACH_SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="eb-subj" label="People affected (estimate)">
            <input id="eb-subj" inputMode="numeric" className="ngao-input" value={f.estimatedSubjects} onChange={(e) => setF({ ...f, estimatedSubjects: e.target.value.replace(/\D/g, '') })} />
          </FormField>
        </div>
        {area('eb-sys', 'Systems affected', 'systemsAffected')}
        {area('eb-cont', 'Containment', 'containmentSummary')}
        {area('eb-risk', 'Scope and risk assessment', 'riskAssessment')}
        {area('eb-dec', 'Notification decision and legal basis', 'notificationDecision', 'Whether notification is legally required and why, or which duty is relied on.')}
        {area('eb-rem', 'Remediation', 'remediationSummary')}
        {area('eb-les', 'Lessons learned', 'lessonsLearned', 'Required before closing.')}
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddEventDialog({ b, onClose, onSaved }: { b: BreachDetail; onClose: () => void; onSaved: (b: BreachDetail) => void }) {
  const { me } = useAuth();
  const types = eventTypesForCaller(b.status, b.allowedActions);
  const [type, setType] = useState<Exclude<BreachEventType, 'DETECTED'>>(types[0] ?? 'NOTE');
  const [note, setNote] = useState('');
  const [occurredAt, setOccurredAt] = useState(isoToLocalInput(new Date().toISOString()));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closing = type === 'CLOSED' ? closeBlockers(b, me?.user.id) : [];
  const decisionMissing = type === 'NOTIFICATION_NOT_REQUIRED' && !b.notificationDecision?.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const evidence = file ? await securityApi.upload(file) : null;
      const body: AddBreachEvent = {
        type,
        note: note.trim(),
        ...(occurredAt ? { occurredAt: localInputToIso(occurredAt) } : {}),
        ...(evidence ? { evidenceFileId: evidence.id } : {}),
        expectedVersion: b.version,
      };
      onSaved(await securityApi.addEvent(b.id, body));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Add a timeline entry" description="Entries are append-only. Status-moving steps follow the response order; notes and lessons can be added at any time.">
      <form onSubmit={submit}>
        <FormField id="ev-type" label="Step" required>
          <select id="ev-type" className="ngao-input pr-8" value={type} onChange={(e) => setType(e.target.value as Exclude<BreachEventType, 'DETECTED'>)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {BREACH_EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </FormField>
        {closing.length ? (
          <Notice tone="sod" className="mb-4" title="This record cannot be closed yet">
            <ul className="list-disc pl-4">
              {closing.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {decisionMissing ? (
          <Notice tone="warning" className="mb-4">
            Record the notification decision and its legal basis on the record first (Edit record).
          </Notice>
        ) : null}
        <FormField id="ev-note" label="Note" required hint="What was done and by whom. Categories and counts only, not the affected data.">
          <textarea id="ev-note" className={textareaClass} value={note} minLength={3} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        <FormField id="ev-when" label="When it happened" hint="Africa/Nairobi time. Defaults to now.">
          <input id="ev-when" type="datetime-local" className="ngao-input" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </FormField>
        <FormField id="ev-file" label="Evidence file" hint="PDF or image, stored immutably with its SHA-256.">
          <input id="ev-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={note.trim().length < 3 || closing.length > 0 || decisionMissing}>
            Add entry
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ExportTimelineDialog({ b, onClose }: { b: BreachDetail; onClose: () => void }) {
  const highRisk = useHighRisk();
  const [format, setFormat] = useState<ExportBreachTimeline['format']>('PDF');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignedUrlResponse | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await highRisk(() => securityApi.exportTimeline(b.id, { format, reason: reason.trim() })));
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`Export timeline · ${b.reference}`} description="You will be asked to confirm your password. The export and your reason are recorded.">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-body">
        Classification: <SensitivityBadge level="CONFIDENTIAL" />
        {b.isDrill ? <DrillBadge /> : null}
      </div>
      {result ? (
        <div className="space-y-3">
          <Notice tone="success" title="Export ready">
            Link expires {formatDateTime(result.expiresAt)}.
          </Notice>
          <a href={result.url} download className="inline-flex h-10 items-center gap-2 rounded-lg bg-teal px-4 text-body font-medium text-white hover:bg-teal/90">
            <Download className="h-4 w-4" aria-hidden />
            Download timeline
          </a>
        </div>
      ) : (
        <form onSubmit={submit}>
          <FormField id="bx-format" label="Format" required>
            <select id="bx-format" className="ngao-input pr-8" value={format} onChange={(e) => setFormat(e.target.value as ExportBreachTimeline['format'])}>
              <option value="PDF">PDF</option>
              <option value="CSV">CSV</option>
            </select>
          </FormField>
          <FormField id="bx-reason" label="Reason" required hint="For example: report to the data controller. At least 3 characters.">
            <textarea id="bx-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <p className="mb-4 text-meta text-slate">The file carries the drill label where applicable, the generation time and the classification.</p>
          {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={reason.trim().length < 3}>
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Confirm and export
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
