'use client';

import {
  type CreateVerification,
  type SubmissionDetail,
  type SupervisorAction,
  VERIFICATION_DECISION_LABELS,
  type VerificationChecklist,
  type VerificationDecision,
} from '@ngao360/shared';
import { Ban, CheckCircle2, EyeOff, History, MessageSquare, RotateCcw, ShieldAlert, Star, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useTallyActions } from './action-provider';
import { AuditDrawer } from './audit-drawer';
import { rowLabel } from './capture-field-table';
import { blockingFailures, type CaptureRow, type Draft, liveValidation, parseCell, storedText } from './capture-model';
import { describeError, isAccessError } from './errors';
import { Notice } from './notice';
import { SourceViewer } from './source-viewer';
import { StageComparisonPanel } from './stage-comparison-panel';
import { SubmissionMeta } from './submission-meta';
import { SubmissionRail } from './submission-rail';
import { tallyApi } from './tally-api';
import { useSubmission } from './use-submission';
import { ValidationChecklist } from './validation-checklist';
import { CHECKLIST_LABELS, checklistComplete, compareCells, REQUIRED_CONFIRMATIONS, reentryRows, independentValuesFor, verifyBlockReason } from './verify-model';

type Mode = 'blind' | 'confirm';

const EMPTY_CHECKLIST: VerificationChecklist = {
  imageMatchesMetadata: false,
  allValuesComparedToSource: false,
  stationIdentityConfirmed: false,
  legible: false,
  stampObserved: null,
  signatureObserved: null,
};

/** S20 Verification workspace: independent second-person review against the original image. */
export function VerifyWorkspace({ id }: { id: string }) {
  const bundle = useSubmission(id);
  if (bundle.error) {
    return (
      <Card>
        <EmptyState title={isAccessError(bundle.error) ? 'You cannot open this submission' : 'Could not load the submission'} description={describeError(bundle.error)} />
      </Card>
    );
  }
  if (!bundle.detail || !bundle.ready) return <p className="text-slate">Loading submission…</p>;
  return (
    <VerifyLayout
      key={`${bundle.detail.id}|${bundle.template?.id ?? 'none'}`}
      detail={bundle.detail}
      rows={bundle.rows}
      rules={bundle.template?.validationRules}
      referenceError={bundle.referenceError}
      reload={bundle.reload}
      setDetail={bundle.setDetail}
    />
  );
}

function VerifyLayout({
  detail,
  rows,
  rules,
  referenceError,
  reload,
  setDetail,
}: {
  detail: SubmissionDetail;
  rows: CaptureRow[];
  rules: Parameters<typeof liveValidation>[0];
  referenceError: unknown;
  reload: () => Promise<void>;
  setDetail: (d: SubmissionDetail) => void;
}) {
  const router = useRouter();
  const { me, can } = useAuth();
  const { run, askReason } = useTallyActions();
  const [mode, setMode] = useState<Mode>('blind');
  const [revealed, setRevealed] = useState(false);
  const [entry, setEntry] = useState<Draft>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<VerificationChecklist>(EMPTY_CHECKLIST);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const notesId = useId();

  const actions = new Set(detail.allowedActions);
  const blockReason = verifyBlockReason(detail, me, can('tally.verify'));
  const canVerify = blockReason === null;
  const reentry = useMemo(() => reentryRows(rows), [rows]);
  const comparison = useMemo(() => compareCells(reentry, entry), [reentry, entry]);
  const entryErrors = Object.fromEntries(
    reentry.flatMap((r) => {
      const p = parseCell(r, entry[r.cell] ?? '');
      return p.ok ? [] : [[r.cell, p.error] as const];
    }),
  );
  const allEntered = reentry.every((r) => (entry[r.cell] ?? '').trim() !== '') && Object.keys(entryErrors).length === 0;
  const mismatches = comparison.filter((c) => !c.match);
  const capturedDraft = useMemo(() => Object.fromEntries(rows.map((r) => [r.cell, storedText(r)])), [rows]);
  const checks = useMemo(() => liveValidation(rules, rows, capturedDraft), [rules, rows, capturedDraft]);
  const fails = checks.filter((c) => c.outcome === 'FAIL');
  const showCaptured = mode === 'confirm' || revealed;

  const decide = async (decision: VerificationDecision) => {
    setError(null);
    setMessage(null);
    if (decision !== 'PASS' && !notes.trim()) {
      const reason = await askReason({
        title: decision === 'RETURN' ? 'Return to submitter' : 'Dispute this record',
        description: decision === 'RETURN' ? 'Say what needs to be fixed.' : 'Explain what is disputed. A discrepancy case will be reviewed by a supervisor.',
        danger: decision === 'DISPUTE',
        confirmLabel: VERIFICATION_DECISION_LABELS[decision],
      });
      if (!reason) return;
      setNotes(reason);
      return submit(decision, reason);
    }
    return submit(decision, notes.trim() || undefined);
  };

  const submit = async (decision: VerificationDecision, note?: string) => {
    setBusy(decision);
    try {
      const body: CreateVerification = {
        decision,
        checklist,
        independentValues: independentValuesFor(decision, mode, reentry, entry),
        fieldComments: Object.entries(comments)
          .filter(([, c]) => c.trim())
          .map(([cell, comment]) => ({ fieldKey: cell, comment: comment.trim() })),
        ...(note ? { notes: note } : {}),
      };
      const v = await run(() => tallyApi.verify(detail.id, body));
      setMessage(
        v.mismatchedFieldKeys.length > 0
          ? `Recorded. ${v.mismatchedFieldKeys.length} value(s) differ from the capture, so the record is disputed and a reviewer-disagreement case was opened for a supervisor.`
          : `Recorded: ${VERIFICATION_DECISION_LABELS[decision]}.`,
      );
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const supervisor = async (verificationId: string, action: SupervisorAction) => {
    const labels: Record<SupervisorAction, string> = { APPROVED: 'Approve outcome', REJECTED: 'Reject outcome', THIRD_CHECK_REQUESTED: 'Request a third check' };
    const reason = await askReason({ title: labels[action], confirmLabel: labels[action], danger: action === 'REJECTED' });
    if (!reason) return;
    setBusy(action);
    setError(null);
    try {
      await run(() => tallyApi.supervisorAction(verificationId, { action, reason }));
      setMessage(`${labels[action]}: recorded.`);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const exclude = async () => {
    const reason = await askReason({
      title: 'Exclude from the verified aggregate',
      description: 'The record and its source stay stored and visible as excluded. This is a high-risk action and may ask you to confirm your password.',
      danger: true,
      confirmLabel: 'Exclude',
    });
    if (!reason) return;
    setBusy('exclude');
    try {
      setDetail(await run(() => tallyApi.transition(detail.id, { to: 'EXCLUDED_FROM_AGGREGATE', reason })));
      setMessage('Excluded from the aggregate. The record remains visible.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const designate = async () => {
    const reason = await askReason({ title: 'Designate as canonical record', description: 'Other records in the duplicate group stay stored but are no longer canonical.' });
    if (!reason) return;
    setBusy('canonical');
    try {
      setDetail(await run(() => tallyApi.designateCanonical(detail.id, reason)));
      setMessage('Designated as the canonical record.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const passBlockers: string[] = [];
  if (!checklistComplete(checklist)) passBlockers.push('Tick all four confirmations.');
  // Arithmetic failures can pass only after a supervisor resolved the arithmetic
  // case (the server checks); other failures always block a pass.
  const failSplit = blockingFailures(fails);
  if (failSplit.blocking.length > 0) passBlockers.push(`${failSplit.blocking.length} validation rule(s) fail; Pass is not possible. Return or dispute instead.`);
  if (mode === 'blind' && !allEntered) passBlockers.push('Enter every figure independently from the image.');
  if (mode === 'blind' && allEntered && mismatches.length > 0) passBlockers.push(`${mismatches.length} of your figures differ from the capture. Recheck, or dispute.`);

  const latest = detail.verifications[detail.verifications.length - 1];
  const decisionDisabled = !canVerify || busy !== null;

  return (
    <>
      <PageHeader
        title={`Verify ${detail.reference}`}
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Verification queue', href: '/tally/inbox?view=awaiting_me' }, { label: detail.reference }]}
        status={<StatusBadge kind="submission" status={detail.status} />}
        description="Independently check the original image against the captured figures. You cannot verify a form you submitted or captured."
        actions={
          <Button variant="secondary" onClick={() => setAuditOpen(true)}>
            <History className="h-4 w-4" aria-hidden /> Audit history
          </Button>
        }
      />

      {blockReason ? (
        <Notice tone="sod" className="mb-3" title="Verification is not available to you">
          {blockReason}
        </Notice>
      ) : null}
      {referenceError ? (
        <Notice tone="warning" className="mb-3" title="Form template could not be loaded">
          Live validation is unavailable. {describeError(referenceError)}
        </Notice>
      ) : null}

      <div className="grid gap-3 xl:h-[calc(100dvh-230px)] xl:grid-cols-[240px_minmax(0,1fr)_minmax(460px,600px)]">
        <div className="ngao-card hidden min-h-0 overflow-hidden xl:flex xl:flex-col">
          <SubmissionRail
            title="Awaiting my review"
            currentId={detail.id}
            electionCycleId={detail.electionCycleId}
            contestId={detail.contestId}
            statuses={['SECOND_REVIEW_PENDING']}
            view="awaiting_me"
            hrefFor={(sid) => `/tally/verify/${sid}`}
          />
        </div>

        <div className="ngao-card flex min-h-[480px] flex-col overflow-hidden">
          <SourceViewer submissionId={detail.id} file={detail.sourceFile} pageCount={detail.pageCount} canDownload={actions.has('DOWNLOAD_SOURCE')} className="h-full" />
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Card>
            <CardHeader title="Metadata" />
            <CardBody>
              <SubmissionMeta s={detail} compact />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Figures"
              description={mode === 'blind' ? 'Blind mode: enter each figure from the image before you see the capture.' : 'Confirm mode: compare each captured figure with the image.'}
              actions={
                <div role="radiogroup" aria-label="Review mode" className="flex rounded-lg border border-line p-0.5">
                  {(['blind', 'confirm'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      disabled={!canVerify}
                      onClick={() => {
                        setMode(m);
                        setRevealed(false);
                      }}
                      className={cn('rounded-md px-2.5 py-1 text-meta font-medium', mode === m ? 'bg-deep-blue text-white' : 'text-ink hover:bg-cloud')}
                    >
                      {m === 'blind' ? 'Blind re-entry' : 'Confirm'}
                    </button>
                  ))}
                </div>
              }
            />
            <CardBody>
              <ComparisonTable
                rows={mode === 'blind' ? reentry : rows}
                mode={mode}
                showCaptured={showCaptured}
                entry={entry}
                entryErrors={entryErrors}
                comparison={comparison}
                comments={comments}
                openComment={openComment}
                disabled={!canVerify}
                onEntry={(cell, v) => setEntry((e) => ({ ...e, [cell]: v }))}
                onComment={(cell, v) => setComments((c) => ({ ...c, [cell]: v }))}
                onToggleComment={(cell) => setOpenComment((c) => (c === cell ? null : cell))}
              />
              {mode === 'blind' && !revealed ? (
                <div className="mt-3 flex items-center justify-between gap-2">
                  <p className="text-meta text-slate">
                    <EyeOff className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                    Captured figures are hidden until you have entered all of yours.
                  </p>
                  <Button size="sm" variant="secondary" disabled={!allEntered} onClick={() => setRevealed(true)}>
                    Compare side by side
                  </Button>
                </div>
              ) : null}
              {mode === 'blind' && revealed ? (
                <p className={cn('mt-3 text-meta', mismatches.length ? 'text-error' : 'text-success')} role="status">
                  {mismatches.length ? `${mismatches.length} figure(s) differ from the capture.` : 'All your figures match the capture.'}
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Validation checklist" />
            <CardBody>
              <ValidationChecklist checks={checks} serverRun={detail.latestValidation} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Reviewer confirmations" />
            <CardBody>
              <fieldset disabled={!canVerify} className="space-y-2">
                <legend className="sr-only">Reviewer confirmations</legend>
                {REQUIRED_CONFIRMATIONS.map((k) => (
                  <label key={k} className="flex items-start gap-2 text-body">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal" checked={checklist[k]} onChange={(e) => setChecklist((c) => ({ ...c, [k]: e.target.checked }))} />
                    {CHECKLIST_LABELS[k]}
                  </label>
                ))}
                {(['stampObserved', 'signatureObserved'] as const).map((k) => (
                  <div key={k} className="flex flex-wrap items-center gap-3 text-body">
                    <span className="min-w-56">{CHECKLIST_LABELS[k]}</span>
                    {(
                      [
                        [true, 'Yes'],
                        [false, 'No'],
                        [null, 'Not recorded'],
                      ] as const
                    ).map(([val, label]) => (
                      <label key={label} className="flex items-center gap-1">
                        <input type="radio" name={k} className="accent-teal" checked={checklist[k] === val} onChange={() => setChecklist((c) => ({ ...c, [k]: val }))} />
                        {label}
                      </label>
                    ))}
                  </div>
                ))}
                <div>
                  <label htmlFor={notesId} className="ngao-label mt-2">
                    Notes (required to return or dispute)
                  </label>
                  <textarea id={notesId} rows={3} maxLength={4000} className="ngao-input h-auto py-2" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
              </fieldset>
            </CardBody>
          </Card>

          <Card className="sticky bottom-0 z-10">
            <CardBody className="space-y-3">
              {error ? <Notice tone="error">{error}</Notice> : null}
              {message ? <Notice tone="success">{message}</Notice> : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void decide('PASS')} disabled={decisionDisabled || passBlockers.length > 0} loading={busy === 'PASS'} aria-describedby="pass-blockers">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Pass
                </Button>
                <Button variant="secondary" onClick={() => void decide('RETURN')} disabled={decisionDisabled} loading={busy === 'RETURN'}>
                  <RotateCcw className="h-4 w-4" aria-hidden /> Return
                </Button>
                <Button variant="danger" onClick={() => void decide('DISPUTE')} disabled={decisionDisabled} loading={busy === 'DISPUTE'}>
                  <ShieldAlert className="h-4 w-4" aria-hidden /> Dispute
                </Button>
              </div>
              {canVerify && passBlockers.length > 0 ? (
                <ul id="pass-blockers" className="list-disc pl-5 text-meta text-slate">
                  {passBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
              {!canVerify ? <p className="text-meta text-slate">Decision buttons are disabled: {blockReason}</p> : null}
            </CardBody>
          </Card>

          <StageComparisonPanel detail={detail} />

          {detail.verifications.length > 0 || actions.has('EXCLUDE') || actions.has('DESIGNATE_CANONICAL') ? (
            <Card>
              <CardHeader title="Review history and supervisor actions" />
              <CardBody className="space-y-3">
                <ol className="space-y-2">
                  {detail.verifications.map((v) => (
                    <li key={v.id} className="rounded-lg border border-line p-2 text-body">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          Round {v.round}: {VERIFICATION_DECISION_LABELS[v.decision]} by {v.reviewer.displayName}
                        </span>
                        <span className="text-meta text-slate">{formatDateTime(v.reviewedAt)}</span>
                      </div>
                      {v.mismatchedFieldKeys.length > 0 ? (
                        <p className="mt-1 text-meta text-error">
                          <XCircle className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                          Differences: {v.mismatchedFieldKeys.map((k) => rowLabelFor(rows, k)).join(', ')}
                        </p>
                      ) : null}
                      {v.notes ? <p className="mt-1 text-meta text-ink">Notes: {v.notes}</p> : null}
                      {v.supervisorAction ? (
                        <p className="mt-1 text-meta text-slate">
                          Supervisor {v.supervisor?.displayName}: {v.supervisorAction.replace(/_/g, ' ').toLowerCase()} — {v.supervisorReason}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {actions.has('SUPERVISOR_ACTION') && latest && !latest.supervisorAction ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void supervisor(latest.id, 'APPROVED')} loading={busy === 'APPROVED'}>
                      Approve outcome
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void supervisor(latest.id, 'REJECTED')} loading={busy === 'REJECTED'}>
                      Reject outcome
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void supervisor(latest.id, 'THIRD_CHECK_REQUESTED')} loading={busy === 'THIRD_CHECK_REQUESTED'}>
                      Request third check
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {actions.has('DESIGNATE_CANONICAL') ? (
                    <Button size="sm" variant="secondary" onClick={() => void designate()} loading={busy === 'canonical'}>
                      <Star className="h-4 w-4" aria-hidden /> Designate canonical
                    </Button>
                  ) : null}
                  {actions.has('EXCLUDE') ? (
                    <Button size="sm" variant="danger" onClick={() => void exclude()} loading={busy === 'exclude'}>
                      <Ban className="h-4 w-4" aria-hidden /> Exclude from aggregate
                    </Button>
                  ) : null}
                  {actions.has('CAPTURE') ? (
                    <Button size="sm" variant="ghost" onClick={() => router.push(`/tally/capture/${detail.id}`)}>
                      Open capture
                    </Button>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <AuditDrawer submissionId={detail.id} open={auditOpen} onClose={() => setAuditOpen(false)} labelFor={(k) => rows.find((r) => r.fieldKey === k)?.label ?? k} />
    </>
  );
}

function rowLabelFor(rows: readonly CaptureRow[], key: string): string {
  const r = rows.find((x) => x.cell === key) ?? rows.find((x) => x.fieldKey === key);
  return r ? rowLabel(r) : key;
}

function ComparisonTable({
  rows,
  mode,
  showCaptured,
  entry,
  entryErrors,
  comparison,
  comments,
  openComment,
  disabled,
  onEntry,
  onComment,
  onToggleComment,
}: {
  rows: CaptureRow[];
  mode: Mode;
  showCaptured: boolean;
  entry: Draft;
  entryErrors: Record<string, string>;
  comparison: ReturnType<typeof compareCells>;
  comments: Record<string, string>;
  openComment: string | null;
  disabled: boolean;
  onEntry: (cell: string, v: string) => void;
  onComment: (cell: string, v: string) => void;
  onToggleComment: (cell: string) => void;
}) {
  const byCell = new Map(comparison.map((c) => [c.cell, c] as const));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">{mode === 'blind' ? 'Independent re-entry and comparison' : 'Captured figures to confirm'}</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta uppercase tracking-wide text-slate">
            <th scope="col" className="py-2 pr-2 font-semibold">
              Printed label
            </th>
            {mode === 'blind' ? (
              <th scope="col" className="px-2 py-2 font-semibold">
                Your reading
              </th>
            ) : null}
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              Captured
            </th>
            {mode === 'blind' && showCaptured ? (
              <th scope="col" className="px-2 py-2 font-semibold">
                Result
              </th>
            ) : null}
            <th scope="col" className="py-2 pl-2 font-semibold">
              <span className="sr-only">Comment</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cmp = byCell.get(r.cell);
            const inputId = `ver-${r.cell}`;
            const commentId = `ver-c-${r.cell}`;
            const err = entryErrors[r.cell];
            return (
              <tr key={r.cell} className={cn('border-b border-line align-top', mode === 'blind' && showCaptured && cmp && !cmp.match && 'bg-error/5')}>
                <td className="py-2 pr-2">
                  <label htmlFor={mode === 'blind' ? inputId : undefined} className="block">
                    {r.candidateName ? <span className="font-medium">{r.candidateName}</span> : r.label}
                  </label>
                  {r.candidateName ? <span className="block text-meta text-slate">{r.label}</span> : null}
                  {openComment === r.cell || comments[r.cell] ? (
                    <div className="mt-1">
                      <label htmlFor={commentId} className="sr-only">
                        Comment on {rowLabel(r)}
                      </label>
                      <textarea
                        id={commentId}
                        rows={2}
                        maxLength={1000}
                        disabled={disabled}
                        placeholder="Comment for the record"
                        className="ngao-input h-auto py-1 text-meta"
                        value={comments[r.cell] ?? ''}
                        onChange={(e) => onComment(r.cell, e.target.value)}
                      />
                    </div>
                  ) : null}
                </td>
                {mode === 'blind' ? (
                  <td className="px-2 py-2">
                    <input
                      id={inputId}
                      inputMode="numeric"
                      autoComplete="off"
                      disabled={disabled}
                      aria-invalid={!!err}
                      className="ngao-input h-9 w-28 text-right font-mono tabular-nums"
                      value={entry[r.cell] ?? ''}
                      onChange={(e) => onEntry(r.cell, e.target.value)}
                    />
                    {err ? <p className="mt-1 text-meta text-error">{err}</p> : null}
                  </td>
                ) : null}
                <td className="px-2 py-2 text-right font-mono tabular-nums">
                  {showCaptured ? (storedText(r) || <span className="text-slate">empty</span>) : <span className="text-slate" aria-label="hidden until you finish">••••</span>}
                </td>
                {mode === 'blind' && showCaptured ? (
                  <td className="px-2 py-2">
                    {cmp?.match ? (
                      <StatusBadge kind="custom" status="match" label="Match" tone="success" icon={CheckCircle2} size="sm" />
                    ) : (
                      <StatusBadge
                        kind="custom"
                        status="diff"
                        label={cmp?.difference !== null && cmp?.difference !== undefined ? `Differs by ${cmp.difference > 0 ? '+' : ''}${cmp.difference}` : 'Differs'}
                        tone="danger"
                        icon={XCircle}
                        size="sm"
                      />
                    )}
                  </td>
                ) : null}
                <td className="py-2 pl-2">
                  <button
                    type="button"
                    className="rounded p-1 text-slate hover:bg-cloud hover:text-ink"
                    onClick={() => onToggleComment(r.cell)}
                    aria-expanded={openComment === r.cell}
                    aria-label={`Comment on ${rowLabel(r)}`}
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
