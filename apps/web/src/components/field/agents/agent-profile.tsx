'use client';

import {
  AGENT_GENDER_LABELS,
  AGENT_STATUS_LABELS,
  type AgentDetail,
  DEPLOYMENT_ROLE_LABELS,
  DEPLOYMENT_SHIFT_LABELS,
  FIELD_REPORT_REVIEW_STATUS_LABELS,
  FIELD_REPORT_TYPE_LABELS,
  INCIDENT_CATEGORY_LABELS,
} from '@ngao360/shared';
import { ArrowLeft, GraduationCap, History, Plus, RefreshCw, ShieldCheck, UserCog } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Notice } from '@/components/tally/notice';
import { MetaRow } from '@/components/tally/fields';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { AccreditationBadge, AgentStatusBadge, AvailabilityBadge, DeploymentStatusBadge, IncidentStatusBadge, SeverityBadge, TrainingStatusBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { auditActionLabel, stationLabel } from '../common/field-model';
import { ProvenanceTag } from '../common/field-ui';
import { useFieldCycle } from '../common/use-field-cycle';
import { AccreditationDialog, AgentStatusDialog, TrainingDialog } from './agent-dialogs';
import { SensitivePanel } from './reveal-panel';

type Dialog = 'status' | 'training' | 'accreditation' | null;

/** Unique station codes of the agent's deployments, most recent first, capped for the history lookups. */
export function agentStationCodes(agent: Pick<AgentDetail, 'deployments'>, max = 5): string[] {
  return [...new Set(agent.deployments.map((d) => d.pollingStationCode))].slice(0, max);
}

/** S13 Agent profile (API §16 `GET /field/agents/:id`). */
export function AgentProfile({ id }: { id: string }) {
  const { can } = useAuth();
  const agent = useAsync(() => fieldApi.agent(id), [id]);
  const field = useFieldCycle();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showHistory, setShowHistory] = useState(false);
  const a = agent.data;

  if (agent.error && !a) {
    return (
      <div>
        <BackLink />
        <Notice tone="error" title="Could not open this agent">
          {describeFieldError(agent.error)}
        </Notice>
      </div>
    );
  }
  if (!a) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 py-12 text-slate">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal border-r-transparent" aria-hidden /> Loading agent…
      </div>
    );
  }

  const done = () => {
    setDialog(null);
    void agent.reload();
  };
  const cycleAccreditation = field.cycleId ? a.accreditations.find((x) => x.electionCycleId === field.cycleId) : undefined;

  return (
    <div>
      <BackLink />
      <PageHeader
        title={a.displayName}
        breadcrumbs={[{ label: 'Field operations' }, { label: 'Agents', href: '/field/agents' }, { label: a.reference }]}
        description={`${a.reference} · registered ${formatDateTime(a.createdAt)} by ${a.createdBy.displayName}`}
        status={
          <div className="flex flex-wrap items-center gap-2">
            <AgentStatusBadge status={a.status} />
            <AvailabilityBadge status={a.availability} />
            <ProvenanceTag provenance={field.cycle?.dataProvenance} />
          </div>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => void agent.reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </Button>
            {a.allowedActions.includes('change_status') ? (
              <Button variant="secondary" onClick={() => setDialog('status')}>
                <UserCog className="h-4 w-4" aria-hidden /> Change status
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-1">
          <Card>
            <CardHeader title="Identity" />
            <CardBody>
              <dl>
                <MetaRow label="Given name">{a.givenName}</MetaRow>
                <MetaRow label="Family name">{a.familyName}</MetaRow>
                <MetaRow label="Other names">{a.otherNames}</MetaRow>
                <MetaRow label="Gender">{a.gender ? AGENT_GENDER_LABELS[a.gender] : 'Not recorded'}</MetaRow>
                <MetaRow label="Home ward">{[a.homeWard?.name, a.homeConstituency?.name, a.homeCounty?.name].filter(Boolean).join(', ') || '—'}</MetaRow>
                <MetaRow label="Languages">{a.languages.length ? a.languages.join(', ') : '—'}</MetaRow>
                <MetaRow label="Mobile sign-in">{a.hasUserAccount ? 'Linked to a user account' : 'No account linked'}</MetaRow>
                <MetaRow label="Privacy notice">
                  {a.privacyNoticeVersion ? `${a.privacyNoticeVersion}, acknowledged ${formatDateTime(a.privacyNoticeAcknowledgedAt)}` : 'Not recorded'}
                </MetaRow>
                {a.notes ? <MetaRow label="Notes">{a.notes}</MetaRow> : null}
              </dl>
            </CardBody>
          </Card>

          <SensitivePanel agent={a} />

          <Card>
            <CardHeader title="Status history" description="Append-only; every change has a reason." />
            <ol className="divide-y divide-line">
              {[...a.statusHistory]
                .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                .map((e) => (
                  <li key={e.id} className="px-4 py-2.5">
                    <p className="text-body text-ink">
                      {e.fromStatus ? `${AGENT_STATUS_LABELS[e.fromStatus]} → ` : ''}
                      <strong>{AGENT_STATUS_LABELS[e.toStatus]}</strong>
                    </p>
                    <p className="text-meta text-slate">
                      {formatDateTime(e.createdAt)} · {e.actor.displayName}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </p>
                  </li>
                ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader
              title="Accreditation"
              description="Status per election cycle as reported by the accrediting body. NGAO360 never grants accreditation."
              actions={
                a.allowedActions.includes('record_accreditation') && field.cycleId ? (
                  <Button size="sm" variant="secondary" onClick={() => setDialog('accreditation')}>
                    <ShieldCheck className="h-4 w-4" aria-hidden /> Record status
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {field.cycleId && !cycleAccreditation ? (
                <Notice tone="warning" className="mb-3" title="No accreditation record for the field cycle">
                  Agents without approved accreditation are flagged in the deployment planner.
                </Notice>
              ) : null}
              {a.accreditations.length === 0 ? (
                <p className="text-body text-slate">No accreditation recorded.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {a.accreditations.map((acc) => (
                    <li key={acc.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <AccreditationBadge status={acc.status} />
                        <p className="mt-1 text-meta text-slate">
                          {acc.electionCycleId === field.cycleId ? 'Field cycle' : 'Other cycle'}
                          {acc.accreditationReference ? ` · ref. ${acc.accreditationReference}` : ''}
                          {acc.expiresOn ? ` · expires ${acc.expiresOn}` : ''}
                          {acc.evidenceFileId ? ' · evidence on file' : ''}
                        </p>
                      </div>
                      <p className="text-meta text-slate">
                        Updated {formatDateTime(acc.updatedAt)}
                        {acc.updatedBy ? ` by ${acc.updatedBy.displayName}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Training"
              description={`${a.trainingCompleted} of ${a.trainingTotal} recorded sessions completed`}
              actions={
                a.allowedActions.includes('record_training') ? (
                  <Button size="sm" variant="secondary" onClick={() => setDialog('training')}>
                    <GraduationCap className="h-4 w-4" aria-hidden /> Record training
                  </Button>
                ) : null
              }
            />
            {a.trainings.length === 0 ? (
              <EmptyState icon={GraduationCap} title="No training recorded" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <caption className="sr-only">Training records</caption>
                  <thead className="bg-cloud text-meta uppercase tracking-wide text-slate">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left">Session</th>
                      <th scope="col" className="px-4 py-2 text-left">Status</th>
                      <th scope="col" className="px-4 py-2 text-left">Scheduled</th>
                      <th scope="col" className="px-4 py-2 text-left">Materials</th>
                      <th scope="col" className="px-4 py-2 text-right">Score</th>
                      <th scope="col" className="px-4 py-2 text-left">Refresher due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.trainings.map((t) => (
                      <tr key={t.id} className="border-t border-line">
                        <td className="px-4 py-2">{t.title}</td>
                        <td className="px-4 py-2">
                          <TrainingStatusBadge status={t.status} size="sm" />
                        </td>
                        <td className="px-4 py-2">{t.scheduledOn ?? '—'}</td>
                        <td className="px-4 py-2">{t.materialsIssued ? 'Issued' : 'Not issued'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{t.assessmentScore ?? '—'}</td>
                        <td className="px-4 py-2">{t.refresherDueOn ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Deployment history"
              description="Every assignment, including replaced and cancelled ones; nothing is deleted."
              actions={
                can('field.deployment.view') ? (
                  <Link href="/field/deployment" className="text-meta font-medium text-teal hover:underline">
                    Open planner
                  </Link>
                ) : null
              }
            />
            {a.deployments.length === 0 ? (
              <EmptyState icon={Plus} title="Not deployed" description="This agent has no station assignment yet." />
            ) : (
              <ul className="divide-y divide-line">
                {a.deployments.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <div>
                      <p className="text-body font-medium text-ink">
                        {d.pollingStationCode} {d.pollingStationName ?? '(not in the approved registry)'}
                      </p>
                      <p className="text-meta text-slate">
                        {DEPLOYMENT_ROLE_LABELS[d.role]} · {DEPLOYMENT_SHIFT_LABELS[d.shift]}
                        {d.electionCycleId !== field.cycleId ? ' · other cycle' : ''}
                      </p>
                    </div>
                    <DeploymentStatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <StationActivity agent={a} />

          <Card>
            <CardHeader
              title="Record history"
              description="Profile, training, accreditation and reveal events from the audit log (who, when, which fields, why; never the values)."
              actions={
                <Button size="sm" variant="secondary" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
                  <History className="h-4 w-4" aria-hidden /> {showHistory ? 'Hide' : 'Show'}
                </Button>
              }
            />
            {showHistory ? <AgentHistory id={a.id} /> : null}
          </Card>
        </div>
      </div>

      {dialog === 'status' ? <AgentStatusDialog agent={a} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog === 'training' ? <TrainingDialog agent={a} electionCycleId={field.cycleId} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog === 'accreditation' && field.cycleId ? (
        <AccreditationDialog agent={a} electionCycleId={field.cycleId} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/field/agents" className="mb-3 inline-flex items-center gap-1 text-meta text-slate hover:text-ink">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All agents
    </Link>
  );
}

function AgentHistory({ id }: { id: string }) {
  const h = useAsync(() => fieldApi.agentHistory(id), [id]);
  if (h.error) return <Notice tone="error" className="m-4">{describeFieldError(h.error)}</Notice>;
  if (!h.data) return <p className="px-4 py-3 text-meta text-slate">Loading…</p>;
  if (h.data.length === 0) return <p className="px-4 py-3 text-meta text-slate">No events.</p>;
  return (
    <ol className="divide-y divide-line">
      {h.data.map((e) => {
        const fields = (e.after as { fields?: string[] } | null)?.fields;
        return (
          <li key={e.id} className="px-4 py-2.5">
            <p className="text-body text-ink">{auditActionLabel(e.action)}</p>
            <p className="text-meta text-slate">
              {formatDateTime(e.occurredAt)} · {e.actor?.displayName ?? 'System'}
              {Array.isArray(fields) ? ` · fields: ${fields.join(', ')}` : ''}
              {e.reason ? ` · ${e.reason}` : ''}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Field reports and incidents at the agent's stations. The contract has no
 * author/agent filter yet (docs/CHANGE_REQUESTS.md, Field web), so records are
 * read per station code and those submitted from the agent's own sign-in are
 * marked.
 */
function StationActivity({ agent }: { agent: AgentDetail }) {
  const { can } = useAuth();
  const codes = agentStationCodes(agent);
  const canReports = can('field.reports.view');
  const canIncidents = can('field.incidents.view');
  const reports = useAsync(
    async () => (await Promise.all(codes.map((c) => fieldApi.reports({ pollingStationCode: c, pageSize: 20 })))).flatMap((p) => p.items),
    [codes.join(',')],
    canReports && codes.length > 0,
  );
  const incidents = useAsync(
    async () => (await Promise.all(codes.map((c) => fieldApi.incidents({ pollingStationCode: c, pageSize: 20 })))).flatMap((p) => p.items),
    [codes.join(',')],
    canIncidents && codes.length > 0,
  );
  if (!canReports && !canIncidents) return null;
  const mine = (userId: string) => !!agent.userId && agent.userId === userId;
  return (
    <Card>
      <CardHeader title="Reports and incidents at this agent's stations" description={codes.length ? `Stations ${codes.join(', ')}` : 'No stations assigned.'} />
      <CardBody className="grid gap-4 lg:grid-cols-2">
        {canReports ? (
          <div>
            <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Field reports</h3>
            {reports.error ? <Notice tone="error">{describeFieldError(reports.error)}</Notice> : null}
            {(reports.data ?? []).length === 0 ? (
              <p className="text-meta text-slate">{reports.loading ? 'Loading…' : 'None.'}</p>
            ) : (
              <ul className="space-y-2">
                {[...(reports.data ?? [])]
                  .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))
                  .slice(0, 10)
                  .map((r) => (
                    <li key={r.id} className="rounded-lg border border-line px-3 py-2">
                      <p className="text-body text-ink">
                        {r.reference} · {FIELD_REPORT_TYPE_LABELS[r.reportType]}
                      </p>
                      <p className="text-meta text-slate">
                        {stationLabel(r.location)} · {formatDateTime(r.receivedAt)} · {FIELD_REPORT_REVIEW_STATUS_LABELS[r.reviewStatus]}
                        {mine(r.author.id) ? ' · submitted by this agent' : ''}
                      </p>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        ) : null}
        {canIncidents ? (
          <div>
            <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">Incidents</h3>
            {incidents.error ? <Notice tone="error">{describeFieldError(incidents.error)}</Notice> : null}
            {(incidents.data ?? []).length === 0 ? (
              <p className="text-meta text-slate">{incidents.loading ? 'Loading…' : 'None.'}</p>
            ) : (
              <ul className="space-y-2">
                {[...(incidents.data ?? [])]
                  .sort((x, y) => y.reportedAt.localeCompare(x.reportedAt))
                  .slice(0, 10)
                  .map((i) => (
                    <li key={i.id} className="rounded-lg border border-line px-3 py-2">
                      <Link href={`/field/incidents/${i.id}`} className="text-body font-medium text-ink hover:underline">
                        {i.reference} · {INCIDENT_CATEGORY_LABELS[i.category]}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <SeverityBadge severity={i.severity} size="sm" />
                        <IncidentStatusBadge status={i.status} size="sm" />
                        <span className="text-meta text-slate">
                          {formatDateTime(i.reportedAt)}
                          {mine(i.reporter.id) ? ' · reported by this agent' : ''}
                        </span>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
