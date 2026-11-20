'use client';

import type { DiscrepancyType, FormTemplate, SubmissionDetail, SubmissionStatus } from '@ngao360/shared';
import { ArrowLeft, Flag, History, RotateCcw, Save, Send, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { useAuth } from '@/lib/auth-context';
import { useTallyActions } from './action-provider';
import { AuditDrawer } from './audit-drawer';
import { CaptureFieldTable, rowLabel } from './capture-field-table';
import { analyseDraft, type CaptureRow, initialDraft, liveValidation, unconfirmedRequired } from './capture-model';
import { describeError, isAccessError } from './errors';
import { FlagDiscrepancyDialog } from './flag-discrepancy-dialog';
import { Notice } from './notice';
import { SourceViewer } from './source-viewer';
import { SubmissionMeta } from './submission-meta';
import { SubmissionRail } from './submission-rail';
import { tallyApi } from './tally-api';
import { useSubmission } from './use-submission';
import { ValidationChecklist } from './validation-checklist';

const CAPTURE_QUEUE: SubmissionStatus[] = ['SUBMITTED', 'OCR_COMPLETE', 'RETURNED', 'DATA_ENTRY_REVIEWED'];

/** S19 Form capture: split view with queue, original image and metadata + field table. */
export function CaptureWorkspace({ id }: { id: string }) {
  const bundle = useSubmission(id);
  const { detail, template, rows } = bundle;

  if (bundle.error) {
    return (
      <Card>
        <EmptyState title={isAccessError(bundle.error) ? 'You cannot open this submission' : 'Could not load the submission'} description={describeError(bundle.error)} />
      </Card>
    );
  }
  if (!detail || !bundle.ready) return <p className="text-slate">Loading submission…</p>;

  // Re-mount the editable grid when the record or its reference data changes.
  const gridKey = `${detail.id}|${template?.id ?? 'none'}|${bundle.candidates.length}`;
  return (
    <CaptureLayout
      key={gridKey}
      detail={detail}
      template={template}
      rows={rows}
      referenceError={bundle.referenceError}
      onSaved={(d) => bundle.setDetail(d)}
      reload={bundle.reload}
    />
  );
}

function CaptureLayout({
  detail,
  template,
  rows,
  referenceError,
  onSaved,
  reload,
}: {
  detail: SubmissionDetail;
  template: FormTemplate | undefined;
  rows: CaptureRow[];
  referenceError: unknown;
  onSaved: (d: SubmissionDetail) => void;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const { can } = useAuth();
  const { run, askReason } = useTallyActions();
  const [draft, setDraft] = useState(() => initialDraft(rows));
  // After a save the stored values change: start the grid again from them.
  const [syncedAt, setSyncedAt] = useState(detail.updatedAt);
  if (syncedAt !== detail.updatedAt) {
    setSyncedAt(detail.updatedAt);
    setDraft(initialDraft(rows));
  }
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [flag, setFlag] = useState<{ type: DiscrepancyType; details?: Record<string, unknown> } | null>(null);

  const actions = new Set(detail.allowedActions);
  const editable = actions.has('CAPTURE');
  const analysis = useMemo(() => analyseDraft(rows, draft), [rows, draft]);
  const checks = useMemo(() => liveValidation(template?.validationRules, rows, draft), [template, rows, draft]);
  const dirty = analysis.changes.length > 0 || Object.keys(analysis.errors).length > 0;
  const liveFails = checks.filter((c) => c.outcome === 'FAIL');
  const missing = unconfirmedRequired(rows);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const labelFor = (fieldKey: string) => rows.find((r) => r.fieldKey === fieldKey)?.label ?? fieldKey;

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act('save', async () => {
      let reason: string | undefined;
      if (analysis.confirmedEdits.length > 0) {
        const names = analysis.confirmedEdits.map((c) => rowLabel(rows.find((r) => r.cell === c)!));
        const r = await askReason({
          title: 'Why are you changing confirmed values?',
          description: (
            <>
              You are changing {names.length === 1 ? 'a value' : `${names.length} values`} that a person already confirmed:{' '}
              <strong>{names.join(', ')}</strong>. The old value, new value, your name, the time and this reason are kept permanently.
            </>
          ),
          label: 'Reason for the change',
          confirmLabel: 'Save changes',
        });
        if (!r) return;
        reason = r;
      }
      const updated = await run(() => tallyApi.saveValues(detail.id, { values: analysis.changes, ...(reason ? { reason } : {}) }));
      onSaved(updated);
      setMessage('Draft saved. Your entries are recorded as confirmed by you.');
    });

  const submitForReview = () =>
    act('submit', async () => {
      const updated = await run(() => tallyApi.submitForReview(detail.id));
      onSaved(updated);
      setMessage('Sent for independent second review. A different person must verify it.');
    });

  const returnToSubmitter = () =>
    act('return', async () => {
      const reason = await askReason({
        title: 'Return to submitter',
        description: 'Explain what is needed, for example a clearer copy or a missing page. The record stays in the audit trail.',
        confirmLabel: 'Return',
      });
      if (!reason) return;
      onSaved(await run(() => tallyApi.transition(detail.id, { to: 'RETURNED', reason })));
      setMessage('Returned to the submitter.');
    });

  const runServerValidation = () =>
    act('validate', async () => {
      await run(() => tallyApi.validate(detail.id));
      await reload();
    });

  const submitBlockers: string[] = [];
  if (dirty) submitBlockers.push('Save your changes first.');
  if (detail.status !== 'DATA_ENTRY_REVIEWED' && !dirty) submitBlockers.push('Save the captured values first (the record must be in “Data entry reviewed”).');
  if (liveFails.length > 0) submitBlockers.push(`${liveFails.length} validation rule(s) fail. Check the figures against the image, or flag a discrepancy.`);
  if (missing.length > 0) submitBlockers.push(`${missing.length} required value(s) are not yet confirmed by a person.`);

  return (
    <>
      <PageHeader
        title={`Capture ${detail.reference}`}
        breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Form inbox', href: '/tally/inbox' }, { label: detail.reference }]}
        status={<StatusBadge kind="submission" status={detail.status} />}
        description="Compare every value with the original image. The original document is never hidden or overwritten."
        actions={
          <>
            <Link href="/tally/inbox" className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-body text-ink hover:bg-cloud">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Inbox
            </Link>
            <Button variant="secondary" onClick={() => setAuditOpen(true)}>
              <History className="h-4 w-4" aria-hidden /> Audit history
            </Button>
            {actions.has('VERIFY') ? (
              <Button variant="secondary" onClick={() => router.push(`/tally/verify/${detail.id}`)}>
                <ShieldCheck className="h-4 w-4" aria-hidden /> Open verification
              </Button>
            ) : null}
          </>
        }
      />

      {detail.status === 'QUARANTINED' ? (
        <Notice tone="warning" className="mb-3" title="Quarantined: form version not approved">
          A configuration administrator must confirm the applicable template version before this record can be processed.
        </Notice>
      ) : null}
      {referenceError ? (
        <Notice tone="warning" className="mb-3" title="Form template could not be loaded">
          Showing stored values only; live validation is unavailable. {describeError(referenceError)}
        </Notice>
      ) : null}

      <div className="grid gap-3 xl:h-[calc(100dvh-230px)] xl:grid-cols-[240px_minmax(0,1fr)_minmax(440px,560px)]">
        <div className="ngao-card hidden min-h-0 overflow-hidden xl:flex xl:flex-col">
          <SubmissionRail
            title="Capture queue"
            currentId={detail.id}
            electionCycleId={detail.electionCycleId}
            contestId={detail.contestId}
            statuses={CAPTURE_QUEUE}
            hrefFor={(sid) => `/tally/capture/${sid}`}
          />
        </div>

        <div className="ngao-card flex min-h-[480px] flex-col overflow-hidden">
          <SourceViewer submissionId={detail.id} file={detail.sourceFile} pageCount={detail.pageCount} canDownload={actions.has('DOWNLOAD_SOURCE')} className="h-full" />
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Card>
            <CardHeader title="Metadata" />
            <CardBody>
              <SubmissionMeta s={detail} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Captured figures"
              description={editable ? 'Type each value exactly as printed. Leave blank if it cannot be read; never guess.' : 'Read-only in the current status.'}
            />
            <CardBody>
              <CaptureFieldTable idPrefix="cap" rows={rows} draft={draft} errors={analysis.errors} checks={checks} editable={editable} onChange={(cell, v) => setDraft((d) => ({ ...d, [cell]: v }))} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Validation checklist"
              actions={
                actions.has('CAPTURE') || can('tally.verify') ? (
                  <Button size="sm" variant="secondary" onClick={() => void runServerValidation()} loading={busy === 'validate'} disabled={dirty}>
                    Run saved check
                  </Button>
                ) : null
              }
            />
            <CardBody>
              <ValidationChecklist checks={checks} serverRun={detail.latestValidation} />
            </CardBody>
          </Card>

          <Card className="sticky bottom-0 z-10">
            <CardBody className="space-y-3">
              {error ? <Notice tone="error">{error}</Notice> : null}
              {message ? <Notice tone="success">{message}</Notice> : null}
              <div className="flex flex-wrap gap-2">
                {editable ? (
                  <Button onClick={() => void save()} disabled={!dirty || Object.keys(analysis.errors).length > 0} loading={busy === 'save'}>
                    <Save className="h-4 w-4" aria-hidden /> Save draft
                  </Button>
                ) : null}
                {actions.has('SUBMIT_FOR_REVIEW') || (editable && dirty) ? (
                  <Button
                    variant="secondary"
                    onClick={() => void submitForReview()}
                    disabled={submitBlockers.length > 0 || !actions.has('SUBMIT_FOR_REVIEW')}
                    loading={busy === 'submit'}
                    aria-describedby="submit-blockers"
                  >
                    <Send className="h-4 w-4" aria-hidden /> Submit for second review
                  </Button>
                ) : null}
                {actions.has('RETURN') ? (
                  <Button variant="secondary" onClick={() => void returnToSubmitter()} loading={busy === 'return'}>
                    <RotateCcw className="h-4 w-4" aria-hidden /> Return to submitter
                  </Button>
                ) : null}
                {actions.has('FLAG_DISCREPANCY') ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setFlag(
                        liveFails.length > 0
                          ? { type: 'ARITHMETIC', details: { failures: liveFails.map((f) => ({ ruleKey: f.ruleKey, fieldKeys: f.fields, arithmetic: f.detail })) } }
                          : { type: 'METADATA' },
                      )
                    }
                  >
                    <Flag className="h-4 w-4" aria-hidden /> Flag discrepancy
                  </Button>
                ) : null}
              </div>
              {(actions.has('SUBMIT_FOR_REVIEW') || (editable && dirty)) && submitBlockers.length > 0 ? (
                <ul id="submit-blockers" className="list-disc pl-5 text-meta text-slate">
                  {submitBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
              {!actions.has('FLAG_DISCREPANCY') ? (
                <p className="text-meta text-slate">To report a problem without case-management permission, return the form or tell your supervisor.</p>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>

      <AuditDrawer submissionId={detail.id} open={auditOpen} onClose={() => setAuditOpen(false)} labelFor={labelFor} />
      <FlagDiscrepancyDialog
        open={flag !== null}
        onClose={() => setFlag(null)}
        submissionId={detail.id}
        reference={detail.reference}
        defaultType={flag?.type}
        details={flag?.details}
        onCreated={(c) => {
          setFlag(null);
          setMessage(`Case ${c.reference} opened.`);
          void reload();
        }}
      />
    </>
  );
}
