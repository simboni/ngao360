'use client';

/**
 * My submissions (blueprint 11.3): status, timestamps, returned reports and
 * corrections. Needs a connection (server records are not cached on the
 * phone). A returned report is answered with a new linked report; an incident
 * is corrected with a CORRECTION event that never changes the original.
 */
import {
  FIELD_REPORT_REVIEW_STATUS_LABELS,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_STATUS_LABELS,
  type FieldReportSummary,
  type IncidentSummary,
  type Paginated,
} from '@ngao360/shared';
import { CloudOff } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { QueueValidationError } from '@/lib/offline/queue';
import { fromLocalInputValue, pendingTargets } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, Field, inputCls, MobileCard, Notice, PageTitle, Sheet, Spinner } from './mobile-ui';

export function SubmissionsScreen() {
  const s = useMobileSession();
  const canReports = s.can('field.reports.submit');
  const canIncidents = s.can('field.incidents.report');
  const [reports, setReports] = useState<FieldReportSummary[] | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<IncidentSummary | null>(null);

  const load = useCallback(async () => {
    if (!s.online) return;
    setError(null);
    try {
      const [r, i] = await Promise.all([
        canReports ? api.get<Paginated<FieldReportSummary>>('/field/reports', { query: { view: 'mine', pageSize: 30 } }) : Promise.resolve(null),
        canIncidents ? api.get<Paginated<IncidentSummary>>('/field/incidents', { query: { view: 'mine', pageSize: 30 } }) : Promise.resolve(null),
      ]);
      setReports(r?.items ?? []);
      setIncidents(i?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your submissions');
    }
  }, [s.online, canReports, canIncidents]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingNotes = pendingTargets(s.entries, 'INCIDENT_NOTE');

  if (!s.online) {
    return (
      <>
        <PageTitle>My submissions</PageTitle>
        <div className="ngao-card">
          <EmptyState
            icon={CloudOff}
            title="Needs a connection"
            description={
              <>
                Server records are not kept on this phone. What you saved offline is in the <Link className="font-semibold text-teal underline" href="/m/queue">upload queue</Link>.
              </>
            }
          />
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub="What the server has received from you.">My submissions</PageTitle>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canReports ? (
        <section aria-labelledby="sub-reports" className="flex flex-col gap-2">
          <h2 id="sub-reports" className="text-card font-semibold text-navy">
            Field reports
          </h2>
          {reports === null ? <Spinner /> : reports.length === 0 ? <p className="text-body text-slate">No field reports yet.</p> : null}
          {reports?.map((r) => (
            <MobileCard key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-ink">{r.reference}</p>
                  <p className="text-meta text-slate">
                    {r.location.station ? `${r.location.station.name} (${r.location.station.code})` : (r.location.ward?.name ?? '')} · {formatDateTime(r.eventAt)}
                  </p>
                </div>
                <span className="rounded-full bg-cloud px-2 py-1 text-meta font-semibold text-ink">{FIELD_REPORT_REVIEW_STATUS_LABELS[r.reviewStatus]}</span>
              </div>
              {r.reviewStatus === 'RETURNED' ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Notice tone="warning">Returned for clarification. Your report stays on record; answer with a new report.</Notice>
                  <Link
                    href={`/m/report?template=${encodeURIComponent(r.templateId)}&supersedes=${encodeURIComponent(r.id)}`}
                    className="flex min-h-[52px] items-center justify-center rounded-xl bg-teal px-4 font-semibold text-white"
                  >
                    Answer with a new report
                  </Link>
                </div>
              ) : null}
            </MobileCard>
          ))}
        </section>
      ) : null}
      {canIncidents ? (
        <section aria-labelledby="sub-incidents" className="flex flex-col gap-2">
          <h2 id="sub-incidents" className="text-card font-semibold text-navy">
            Incidents
          </h2>
          {incidents === null ? <Spinner /> : incidents.length === 0 ? <p className="text-body text-slate">No incidents reported yet.</p> : null}
          {incidents?.map((i) => (
            <MobileCard key={i.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-ink">{i.reference}</p>
                  <p className="text-body text-ink">{INCIDENT_CATEGORY_LABELS[i.reportedCategory]}</p>
                  <p className="text-meta text-slate">
                    {i.location.station ? `${i.location.station.name} · ` : ''}
                    {formatDateTime(i.occurredAt)}
                  </p>
                </div>
                <span className="rounded-full bg-cloud px-2 py-1 text-meta font-semibold text-ink">{INCIDENT_STATUS_LABELS[i.status]}</span>
              </div>
              {i.status !== 'CLOSED' ? (
                pendingNotes.has(i.id) ? (
                  <p className="mt-2 text-body text-deep-blue">Correction saved on this phone; see the upload queue.</p>
                ) : (
                  <BigButton className="mt-3" tone="secondary" onClick={() => setCorrecting(i)}>
                    Add a correction
                  </BigButton>
                )
              ) : null}
            </MobileCard>
          ))}
        </section>
      ) : null}
      <CorrectionSheet incident={correcting} onClose={() => setCorrecting(null)} />
    </div>
  );
}

function CorrectionSheet({ incident, onClose }: { incident: IncidentSummary | null; onClose: () => void }) {
  const s = useMobileSession();
  const [note, setNote] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!incident) return;
    setError(null);
    if (note.trim().length < 3) {
      setError('Say what should be corrected');
      return;
    }
    const occurredAt = time ? fromLocalInputValue(time) : null;
    setSaving(true);
    try {
      await s.enqueue({
        kind: 'INCIDENT_NOTE',
        targetId: incident.id,
        summary: `Correction · ${incident.reference}`,
        payload: { incidentId: incident.id, event: { type: 'CORRECTION', note: note.trim(), ...(occurredAt ? { correction: { occurredAt } } : {}) } },
      });
      setNote('');
      setTime('');
      onClose();
    } catch (err) {
      setError(err instanceof QueueValidationError ? err.issues.map((i) => i.message).join('; ') : err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={incident !== null} title={`Correct ${incident?.reference ?? ''}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-meta text-slate">Your original report stays unchanged. The correction is added beside it for the incident desk.</p>
        <Field label="What should be corrected?" htmlFor="corr-note">
          <textarea id="corr-note" className={`${inputCls} min-h-[96px] py-2`} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Corrected time (optional)" htmlFor="corr-time">
          <input id="corr-time" type="datetime-local" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        {error ? (
          <p className="text-meta font-medium text-error" role="alert">
            {error}
          </p>
        ) : null}
        <BigButton loading={saving} onClick={save}>
          Save correction
        </BigButton>
        <BigButton tone="ghost" onClick={onClose}>
          Cancel
        </BigButton>
      </div>
    </Sheet>
  );
}
