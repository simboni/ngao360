'use client';

import { CONTENT_AUDIENCE_LABELS, CONTENT_TYPE_LABELS, type ContentDetail, type ContentRevision } from '@ngao360/shared';
import { Check, FileDiff, FilePen, History, Pencil, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { Facts, FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { ContentStatusBadge, describeCampaignError } from '@/components/org/campaign-common';
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
import { commsApi } from './comms-api';
import { type ActionSpec, contentActions, lineDiff, previousText, REVISION_KIND_LABELS, WORKFLOW_STEPS, workflowStepIndex } from './comms-model';
import { ContentEditorDialog, OutreachBoundaryNote } from './content-editor';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

/** Communications content item: text, workflow, revision and correction history (API §26). */
export function ContentDetailView({ id }: { id: string }) {
  const { me } = useAuth();
  const { data: item, error, loading, reload, setData } = useAsync(() => commsApi.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<ActionSpec | null>(null);
  const [correcting, setCorrecting] = useState(false);

  if (loading && !item) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" aria-live="polite" />;
  if (error && !item) {
    return (
      <>
        <PageHeader title="Content item" breadcrumbs={[{ label: 'Campaign' }, { label: 'Communications', href: '/comms' }, { label: 'Item' }]} />
        <Card>
          <EmptyState icon={ShieldOff} title="This item could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </Card>
      </>
    );
  }
  if (!item) return null;

  const actions = contentActions(item);
  const isAuthor = item.author.id === me?.user.id;
  const corrections = item.revisions.filter((r) => r.kind === 'CORRECTED');

  return (
    <>
      <PageHeader
        title={item.title}
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Communications', href: '/comms' }, { label: item.reference }]}
        status={<ContentStatusBadge status={item.status} />}
        description={`${CONTENT_TYPE_LABELS[item.type]} · ${CONTENT_AUDIENCE_LABELS[item.audience]} · revision ${item.revision}`}
        actions={
          <>
            {actions.map((a) => (
              <Button key={a.action} size="sm" variant={a.tone === 'danger' ? 'danger' : a.tone === 'secondary' ? 'secondary' : 'primary'} onClick={() => setAction(a)}>
                {a.label}
              </Button>
            ))}
            {item.allowedActions.includes('CORRECT') ? (
              <Button size="sm" variant="secondary" onClick={() => setCorrecting(true)}>
                <FilePen className="h-4 w-4" aria-hidden />
                Publish a correction
              </Button>
            ) : null}
            {item.allowedActions.includes('EDIT') ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit text
              </Button>
            ) : null}
          </>
        }
      />
      <WorkflowStepper item={item} />
      <div className="mb-4">
        <OutreachBoundaryNote compact />
      </div>
      {isAuthor && (item.status === 'EDITORIAL_REVIEW' || item.status === 'AWAITING_APPROVAL') ? (
        <Notice tone="sod" className="mb-4" title="Separation of duties">
          You wrote this item, so a different editor and approver must review it.
        </Notice>
      ) : null}
      {corrections.length ? (
        <Notice tone="warning" className="mb-4" title={corrections.length === 1 ? 'This item was corrected' : `This item was corrected ${corrections.length} times`}>
          <ul className="list-disc pl-4">
            {corrections.map((c) => (
              <li key={c.id}>
                {formatDateTime(c.createdAt)}: {c.note}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Text" description={item.summary ?? undefined} />
          <CardBody>
            <article className="whitespace-pre-wrap text-body leading-6 text-ink">{item.body}</article>
          </CardBody>
        </Card>
        <Card className="self-start">
          <CardHeader title="Details" />
          <CardBody>
            <Facts
              className="sm:grid-cols-1"
              items={[
                { label: 'Reference', value: item.reference },
                { label: 'Audience category', value: CONTENT_AUDIENCE_LABELS[item.audience] },
                { label: 'Department', value: item.department ? `${item.department.name} (${item.department.code})` : 'Organisation-level' },
                { label: 'Author', value: item.author.displayName },
                { label: 'Editor', value: item.editor?.displayName ?? '—' },
                { label: 'Approver', value: item.approver?.displayName ?? '—' },
                { label: 'Planned publication', value: formatDateTime(item.scheduledFor) },
                { label: 'Published', value: item.publishedAt ? `${formatDateTime(item.publishedAt)}${item.publishedBy ? ` by ${item.publishedBy.displayName}` : ''}` : '—' },
                { label: 'Archived', value: formatDateTime(item.archivedAt) },
                { label: 'Created', value: formatDateTime(item.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
      </div>
      <RevisionHistory revisions={item.revisions} />

      <ContentEditorDialog open={editing} onClose={() => setEditing(false)} item={item} onSaved={setData} />
      <TransitionDialog spec={action} item={item} onClose={() => setAction(null)} onSaved={setData} />
      <CorrectionDialog open={correcting} item={item} onClose={() => setCorrecting(false)} onSaved={setData} />
    </>
  );
}

function WorkflowStepper({ item }: { item: ContentDetail }) {
  const current = workflowStepIndex(item.status);
  return (
    <nav aria-label="Workflow" className="ngao-card mb-4 overflow-x-auto p-3">
      <ol className="flex min-w-max items-center gap-2">
        {WORKFLOW_STEPS.map((s, i) => {
          const done = i < current || (i === current && (item.status === 'ARCHIVED' || item.status === 'PUBLISHED'));
          const here = i === current;
          return (
            <li key={s.status} className="flex items-center gap-2" aria-current={here ? 'step' : undefined}>
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-meta font-semibold',
                  done ? 'border-success bg-success text-white' : here ? 'border-deep-blue bg-deep-blue text-white' : 'border-line bg-surface text-slate',
                )}
                aria-hidden
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn('text-body', here ? 'font-semibold text-navy' : done ? 'text-ink' : 'text-slate')}>
                {s.label}
                {here && item.status === 'WITHDRAWN' ? ' (withdrawn)' : ''}
                <span className="sr-only">{done ? ', done' : here ? ', current step' : ', not reached'}</span>
              </span>
              {i < WORKFLOW_STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-line" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function RevisionHistory({ revisions }: { revisions: ContentRevision[] }) {
  const [view, setView] = useState<{ rev: ContentRevision; mode: 'text' | 'diff' } | null>(null);
  return (
    <Card className="mt-6">
      <CardHeader title="Revision and correction history" description="Append-only: every edit and workflow step, oldest first. Earlier text is never overwritten." />
      <CardBody>
        <ol className="relative space-y-4 border-l border-line pl-5">
          {revisions.map((r) => {
            const prev = previousText(revisions, r);
            const isText = r.kind === 'CREATED' || r.kind === 'EDITED' || r.kind === 'CORRECTED';
            return (
              <li key={r.id} className="relative">
                <span className={cn('absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface', r.kind === 'CORRECTED' ? 'bg-gold' : 'bg-deep-blue')} aria-hidden />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-ink">{REVISION_KIND_LABELS[r.kind]}</span>
                  <span className="text-meta text-slate">r{r.revision}</span>
                  {r.fromStatus && r.toStatus && r.fromStatus !== r.toStatus ? (
                    <span className="inline-flex items-center gap-1">
                      <ContentStatusBadge status={r.fromStatus} size="sm" />→<ContentStatusBadge status={r.toStatus} size="sm" />
                    </span>
                  ) : null}
                  <span className="text-meta text-slate">
                    {r.actor.displayName} · <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                  </span>
                </div>
                {r.note ? <p className={cn('mt-0.5 text-body', r.kind === 'CORRECTED' ? 'font-medium text-ink' : 'text-ink')}>{r.kind === 'CORRECTED' ? `Correction note: ${r.note}` : r.note}</p> : null}
                {isText ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setView({ rev: r, mode: 'text' })}>
                      <History className="h-4 w-4" aria-hidden />
                      View this text
                    </Button>
                    {prev ? (
                      <Button size="sm" variant="ghost" onClick={() => setView({ rev: r, mode: 'diff' })}>
                        <FileDiff className="h-4 w-4" aria-hidden />
                        Compare with r{prev.revision}
                      </Button>
                    ) : null}
                    <span className="self-center font-mono text-[11px] text-slate" title="SHA-256 of the text">
                      sha256 {r.bodySha256.slice(0, 12)}…
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardBody>
      <Dialog
        open={!!view}
        onClose={() => setView(null)}
        variant="drawer"
        title={view ? (view.mode === 'text' ? `Text at revision ${view.rev.revision}` : `Changes in revision ${view.rev.revision}`) : ''}
        description={view?.mode === 'diff' ? 'Removed lines are marked “Removed”, added lines “Added”.' : undefined}
      >
        {view?.mode === 'text' ? (
          <>
            <h3 className="mb-2 text-card font-semibold text-ink">{view.rev.title}</h3>
            <p className="whitespace-pre-wrap text-body text-ink">{view.rev.body}</p>
          </>
        ) : view ? (
          <DiffView before={previousText(revisions, view.rev)!} after={view.rev} />
        ) : null}
      </Dialog>
    </Card>
  );
}

function DiffView({ before, after }: { before: ContentRevision; after: ContentRevision }) {
  const lines = lineDiff(`${before.title}\n\n${before.body}`, `${after.title}\n\n${after.body}`);
  return (
    <ol className="space-y-0.5 font-mono text-[13px]">
      {lines.map((l, i) => (
        <li
          key={i}
          className={cn('whitespace-pre-wrap rounded px-2', l.kind === 'added' ? 'bg-success/10 text-ink' : l.kind === 'removed' ? 'bg-error/10 text-ink line-through decoration-error/60' : 'text-slate')}
        >
          {l.kind === 'added' ? <span className="mr-2 font-sans text-meta font-semibold text-success no-underline">Added</span> : null}
          {l.kind === 'removed' ? <span className="mr-2 font-sans text-meta font-semibold text-error">Removed</span> : null}
          {l.text || ' '}
        </li>
      ))}
    </ol>
  );
}

function TransitionDialog({ spec, item, onClose, onSaved }: { spec: ActionSpec | null; item: ContentDetail; onClose: () => void; onSaved: (d: ContentDetail) => void }) {
  const highRisk = useHighRisk();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setError(null);
  }, [spec]);
  if (!spec) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await highRisk(() => commsApi.transition(item.id, { action: spec.action, note: note.trim() || undefined, expectedVersion: item.version })));
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`${spec.label}?`} description={spec.explain}>
      <form onSubmit={submit}>
        <FormField id="tr-note" label={spec.noteRequired ? (spec.action === 'WITHDRAW' ? 'Reason' : 'What needs to change') : 'Note'} required={spec.noteRequired} hint="Kept in the revision history.">
          <textarea id="tr-note" className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={spec.tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={spec.noteRequired && note.trim().length < 3}>
            {spec.label}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CorrectionDialog({ open, item, onClose, onSaved }: { open: boolean; item: ContentDetail; onClose: () => void; onSaved: (d: ContentDetail) => void }) {
  const highRisk = useHighRisk();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(item.title);
    setBody(item.body);
    setNote('');
    setError(null);
  }, [open, item]);
  const unchanged = title.trim() === item.title && body.trim() === item.body;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await highRisk(() =>
          commsApi.correct(item.id, { ...(title.trim() !== item.title ? { title: title.trim() } : {}), body: body.trim(), correctionNote: note.trim(), expectedVersion: item.version }),
        ),
      );
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      title={`Correct ${item.reference}`}
      description="A correction publishes a new revision with a public correction note. The previous text stays in the history. You cannot correct an item you wrote."
    >
      <form onSubmit={submit}>
        <FormField id="cr-title" label="Title" required>
          <input id="cr-title" className="ngao-input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} />
        </FormField>
        <FormField id="cr-body" label="Corrected text" required>
          <textarea id="cr-body" className={`${textareaClass} min-h-[260px]`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={50000} />
        </FormField>
        <FormField id="cr-note" label="Public correction note" required hint="Shown with the corrected item, e.g. “An earlier version gave the wrong venue.”">
          <textarea id="cr-note" className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={unchanged || note.trim().length < 3 || title.trim().length < 3 || !body.trim()}>
            <FilePen className="h-4 w-4" aria-hidden />
            Publish correction
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
