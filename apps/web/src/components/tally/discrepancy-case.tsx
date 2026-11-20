'use client';

import {
  DISCREPANCY_STATUS_LABELS,
  type DiscrepancyCaseDetail,
  type DiscrepancyLinkRole,
  type DiscrepancyStatus,
  ResolveDiscrepancySchema,
} from '@ngao360/shared';
import { CheckCircle2, Lock, MessageSquare, UserCheck, UserMinus } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useTallyActions } from './action-provider';
import { IssueTypeBadge, SeverityBadge } from './badges';
import { formatAge } from './discrepancy-list';
import { arithmeticFailures, manualTransitions, normaliseComparison } from './discrepancy-model';
import { describeError, isAccessError } from './errors';
import { MetaRow } from './fields';
import { Notice } from './notice';
import { SourceViewer } from './source-viewer';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

const ROLE_LABELS: Record<DiscrepancyLinkRole, string> = { SOURCE_A: 'Source A', SOURCE_B: 'Source B', RELATED: 'Related' };

function humanKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** S22 Discrepancy case: source A/B comparison, issue type, owner, actions, decision and closure. */
export function DiscrepancyCase({ id }: { id: string }) {
  const q = useAsync(() => tallyApi.discrepancy(id), [id]);
  if (q.error && !q.data) {
    return (
      <Card>
        <EmptyState title={isAccessError(q.error) ? 'You cannot open this case' : 'Could not load the case'} description={describeError(q.error)} />
      </Card>
    );
  }
  if (!q.data) return <p className="text-slate">Loading case…</p>;
  return <CaseView c={q.data} onChange={q.setData} reload={q.reload} />;
}

function CaseView({ c, onChange, reload }: { c: DiscrepancyCaseDetail; onChange: (c: DiscrepancyCaseDetail) => void; reload: () => Promise<void> }) {
  const { me, can } = useAuth();
  const { run, askReason } = useTallyActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [showSources, setShowSources] = useState(false);
  const commentId = useId();

  const candidates = useAsync(() => tallyApi.candidates(c.contestId!), [c.contestId], !!c.contestId);
  const candName = useMemo(() => new Map((candidates.data ?? []).map((x) => [x.id, x.candidateNameAsPublished] as const)), [candidates.data]);
  const comparison = normaliseComparison(c);
  const failures = arithmeticFailures(c);
  const closed = c.status === 'CLOSED';
  const resolved = c.status === 'RESOLVED';
  const canManage = can('tally.discrepancy.manage') && !closed && !resolved;
  const canResolve = can('tally.discrepancy.resolve');
  const isResolver = !!me && c.resolvedBy?.id === me.user.id;

  const sourceA = c.links.find((l) => l.role === 'SOURCE_A');
  const sourceB = c.links.find((l) => l.role === 'SOURCE_B');

  const act = async (name: string, fn: () => Promise<DiscrepancyCaseDetail | void>, ok?: string) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      const updated = await fn();
      if (updated) onChange(updated);
      if (ok) setMessage(ok);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const transition = (to: DiscrepancyStatus) =>
    act(`to-${to}`, async () => {
      const reason = await askReason({ title: `Move case to “${DISCREPANCY_STATUS_LABELS[to]}”`, confirmLabel: DISCREPANCY_STATUS_LABELS[to] });
      if (!reason) return;
      return run(() => tallyApi.transitionDiscrepancy(c.id, { to, reason }));
    });

  const assign = (assignedToId: string | null) =>
    act('assign', () => run(() => tallyApi.assignDiscrepancy(c.id, { assignedToId })), assignedToId ? 'Assigned to you.' : 'Unassigned.');

  const addComment = () =>
    act('comment', async () => {
      await run(() => tallyApi.commentDiscrepancy(c.id, comment.trim()));
      setComment('');
      await reload();
    });

  const close = () =>
    act('close', async () => {
      const closureNote = await askReason({
        title: 'Approve closure',
        description: 'You confirm the recorded decision was carried out. The approver must be a different person from the resolver.',
        confirmLabel: 'Close case',
      });
      if (!closureNote) return;
      return run(() => tallyApi.closeDiscrepancy(c.id, { closureNote }));
    }, 'Case closed.');

  return (
    <>
      <PageHeader
        title={`${c.reference}: ${c.title}`}
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Discrepancies', href: '/tally/discrepancies' }, { label: c.reference }]}
        status={<StatusBadge kind="discrepancy" status={c.status} />}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Issue" actions={<div className="flex flex-wrap gap-1"><IssueTypeBadge type={c.varianceType} /><SeverityBadge severity={c.severity} /></div>} />
            <CardBody className="space-y-3">
              <p className="whitespace-pre-line text-body text-ink">{c.description}</p>
              <Notice tone="info" title="Required handling">
                {c.requiredHandling}
              </Notice>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Source comparison"
              description="Both source records are kept unchanged. Differences are shown, never applied automatically."
              actions={
                sourceA || sourceB ? (
                  <Button size="sm" variant="secondary" onClick={() => setShowSources((s) => !s)} aria-expanded={showSources}>
                    {showSources ? 'Hide source images' : 'Show source images'}
                  </Button>
                ) : null
              }
            />
            <CardBody className="space-y-4">
              <ul className="flex flex-wrap gap-2">
                {c.links.map((l) => (
                  <li key={`${l.role}-${l.submissionId}`}>
                    <Link href={`/tally/verify/${l.submissionId}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-body hover:bg-cloud">
                      <span className="text-meta font-semibold text-slate">{ROLE_LABELS[l.role]}</span>
                      <span className="font-medium text-deep-blue">{l.reference}</span>
                    </Link>
                  </li>
                ))}
              </ul>

              {showSources ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {[sourceA, sourceB].filter(Boolean).map((l) => (
                    <LinkedSource key={l!.submissionId} submissionId={l!.submissionId} label={`${ROLE_LABELS[l!.role]} · ${l!.reference}`} />
                  ))}
                </div>
              ) : null}

              {comparison ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-body">
                    <caption className="sr-only">Field-level comparison</caption>
                    <thead>
                      <tr className="border-b border-line text-left text-meta uppercase tracking-wide text-slate">
                        <th scope="col" className="py-2 pr-2">
                          Field
                        </th>
                        <th scope="col" className="px-2 py-2 text-right">
                          {comparison.labelA}
                        </th>
                        <th scope="col" className="px-2 py-2 text-right">
                          {comparison.labelB}
                        </th>
                        <th scope="col" className="py-2 pl-2 text-right">
                          Difference
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.rows.map((r) => (
                        <tr key={r.key} className="border-b border-line">
                          <td className="py-2 pr-2">
                            {r.candidateReferenceId ? <span className="font-medium">{candName.get(r.candidateReferenceId) ?? 'Candidate'}</span> : null}
                            <span className={r.candidateReferenceId ? 'block text-meta text-slate' : ''}>{humanKey(r.fieldKey)}</span>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{r.sourceA === null ? '—' : formatNumber(r.sourceA)}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{r.sourceB === null ? '—' : formatNumber(r.sourceB)}</td>
                          <td className="py-2 pl-2 text-right font-mono tabular-nums text-error">
                            {r.difference === null ? '—' : `${r.difference > 0 ? '+' : ''}${formatNumber(r.difference)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {failures.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-card font-semibold text-ink">Failed arithmetic rules</h3>
                  <ul className="space-y-1">
                    {failures.map((f, i) => (
                      <li key={`${f.ruleKey}-${i}`} className="rounded-lg border border-error/30 bg-error/5 p-2 text-meta">
                        <span className="font-semibold">{f.ruleKey}</span> · fields {f.fieldKeys.map(humanKey).join(', ')}
                        {Object.keys(f.extra).length > 0 ? (
                          <span className="block font-mono text-ink">
                            {Object.entries(f.extra)
                              .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                              .join(' · ')}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!comparison && failures.length === 0 ? <p className="text-meta text-slate">No field-level comparison is recorded for this issue type.</p> : null}

              <details>
                <summary className="cursor-pointer text-meta font-medium text-ink">All recorded details</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-cloud p-2 text-[11px] text-ink">{JSON.stringify(c.details, null, 2)}</pre>
              </details>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Activity" description="Append-only log of assignments, comments and decisions." />
            <CardBody className="space-y-3">
              <ol className="relative space-y-3 border-l border-line pl-4">
                {c.actions.map((a) => (
                  <li key={a.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-deep-blue" aria-hidden />
                    <p className="text-body font-medium text-ink">{humanKey(a.action.toLowerCase())}</p>
                    {a.note ? <p className="whitespace-pre-line text-body text-ink">{a.note}</p> : null}
                    <p className="text-meta text-slate">
                      {a.actor.displayName} · {formatDateTime(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ol>
              {can('tally.discrepancy.manage') && !closed ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (comment.trim()) void addComment();
                  }}
                >
                  <label htmlFor={commentId} className="ngao-label">
                    Add a comment
                  </label>
                  <textarea id={commentId} rows={3} maxLength={4000} className="ngao-input h-auto py-2" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <Button type="submit" size="sm" variant="secondary" disabled={!comment.trim()} loading={busy === 'comment'}>
                    <MessageSquare className="h-4 w-4" aria-hidden /> Comment
                  </Button>
                </form>
              ) : null}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {error ? <Notice tone="error">{error}</Notice> : null}
          {message ? <Notice tone="success">{message}</Notice> : null}

          <Card>
            <CardHeader title="Case" />
            <CardBody>
              <dl>
                <MetaRow label="Status">
                  <StatusBadge kind="discrepancy" status={c.status} size="sm" />
                </MetaRow>
                <MetaRow label="Owner">{c.assignedTo?.displayName ?? 'Unassigned'}</MetaRow>
                <MetaRow label="Opened by">{c.openedBy.displayName}</MetaRow>
                <MetaRow label="Opened">{formatDateTime(c.createdAt)}</MetaRow>
                <MetaRow label="Age">{formatAge(c.ageHours)}</MetaRow>
                <MetaRow label="Linked records">{c.links.length}</MetaRow>
              </dl>
              {canManage ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.assignedTo?.id !== me?.user.id ? (
                    <Button size="sm" variant="secondary" onClick={() => void assign(me!.user.id)} loading={busy === 'assign'}>
                      <UserCheck className="h-4 w-4" aria-hidden /> Assign to me
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void assign(null)} loading={busy === 'assign'}>
                      <UserMinus className="h-4 w-4" aria-hidden /> Unassign
                    </Button>
                  )}
                  {manualTransitions(c.status).map((to) => (
                    <Button key={to} size="sm" variant="secondary" onClick={() => void transition(to)} loading={busy === `to-${to}`}>
                      {to === 'ESCALATED' ? 'Escalate' : `Mark ${DISCREPANCY_STATUS_LABELS[to].toLowerCase()}`}
                    </Button>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Decision" />
            <CardBody className="space-y-3">
              {c.resolution ? (
                <div>
                  <p className="whitespace-pre-line text-body text-ink">{c.resolution}</p>
                  <p className="mt-1 text-meta text-slate">Resolved by {c.resolvedBy?.displayName ?? '—'}</p>
                </div>
              ) : canResolve && !closed ? (
                <ResolveForm c={c} busy={busy === 'resolve'} onSubmit={(body) => void act('resolve', () => run(() => tallyApi.resolveDiscrepancy(c.id, body)), 'Decision recorded. Source records were not overwritten.')} />
              ) : (
                <p className="text-meta text-slate">No decision recorded yet. A tally supervisor records the decision.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Closure" />
            <CardBody className="space-y-2">
              {closed ? (
                <p className="flex items-center gap-2 text-body">
                  <Lock className="h-4 w-4 text-slate" aria-hidden /> Closed {formatDateTime(c.closedAt)} · approved by {c.closureApprover?.displayName ?? '—'}
                </p>
              ) : resolved && canResolve ? (
                <>
                  <Button onClick={() => void close()} disabled={isResolver} loading={busy === 'close'}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Approve closure
                  </Button>
                  {isResolver ? (
                    <Notice tone="sod">Separation of duties: you recorded the decision, so a different authorised person must approve closure.</Notice>
                  ) : null}
                </>
              ) : (
                <p className="text-meta text-slate">{resolved ? 'Waiting for a closure approver.' : 'A case can be closed after a decision is recorded.'}</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function LinkedSource({ submissionId, label }: { submissionId: string; label: string }) {
  const q = useAsync(() => tallyApi.submission(submissionId), [submissionId]);
  return (
    <div className="ngao-card flex h-[480px] flex-col overflow-hidden">
      <p className="border-b border-line px-3 py-2 text-meta font-semibold text-ink">{label}</p>
      {q.data ? (
        <SourceViewer submissionId={submissionId} file={q.data.sourceFile} pageCount={q.data.pageCount} canDownload={q.data.allowedActions.includes('DOWNLOAD_SOURCE')} className="min-h-0 flex-1" />
      ) : (
        <p className="p-3 text-meta text-slate">{q.error ? describeError(q.error) : 'Loading…'}</p>
      )}
    </div>
  );
}

function ResolveForm({ c, busy, onSubmit }: { c: DiscrepancyCaseDetail; busy: boolean; onSubmit: (body: { resolution: string; canonicalSubmissionId?: string; excludeSubmissionIds: string[] }) => void }) {
  const { can } = useAuth();
  const [resolution, setResolution] = useState('');
  const [canonical, setCanonical] = useState('');
  const [exclude, setExclude] = useState<string[]>([]);
  const resId = useId();
  const canonId = useId();
  const body = { resolution: resolution.trim(), ...(canonical ? { canonicalSubmissionId: canonical } : {}), excludeSubmissionIds: exclude };
  const valid = ResolveDiscrepancySchema.safeParse(body).success;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(body);
      }}
    >
      <div>
        <label htmlFor={resId} className="ngao-label">
          Reasoned decision (at least 10 characters)
        </label>
        <textarea id={resId} rows={4} maxLength={4000} className="ngao-input h-auto py-2" value={resolution} onChange={(e) => setResolution(e.target.value)} />
      </div>
      {c.varianceType === 'DUPLICATE' || c.links.length > 1 ? (
        <div>
          <label htmlFor={canonId} className="ngao-label">
            Designate canonical record (optional)
          </label>
          <select id={canonId} className="ngao-input" value={canonical} onChange={(e) => setCanonical(e.target.value)}>
            <option value="">No change</option>
            {c.links.map((l) => (
              <option key={l.submissionId} value={l.submissionId}>
                {ROLE_LABELS[l.role]} · {l.reference}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {can('tally.exclude') ? (
        <fieldset>
          <legend className="ngao-label">Exclude from the verified aggregate (optional, audited)</legend>
          {c.links.map((l) => (
            <label key={l.submissionId} className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                className="h-4 w-4 accent-teal"
                checked={exclude.includes(l.submissionId)}
                onChange={(e) => setExclude((x) => (e.target.checked ? [...x, l.submissionId] : x.filter((v) => v !== l.submissionId)))}
              />
              {ROLE_LABELS[l.role]} · {l.reference}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-meta text-slate">Recording a decision never edits source values. Disputed records go back to second review.</p>
      <Button type="submit" disabled={!valid} loading={busy}>
        Record decision
      </Button>
    </form>
  );
}
