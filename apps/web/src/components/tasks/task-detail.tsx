'use client';

import { TASK_SOURCE_TYPE_LABELS, type TaskAttachment, type TaskDetail, type TaskStatus } from '@ngao360/shared';
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  History,
  Link2,
  ListChecks,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Facts, formatBytes, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError, geoLabel, openSignedFile, PersonChip, TaskPriorityBadge, TaskStatusBadge } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { AddDependencyDialog, AssignTaskDialog, ATTACHMENT_KIND_LABELS, AttachTaskFileDialog, EditTaskDialog, TaskReviewDialog, TaskStatusDialog } from './task-dialogs';
import { checklistPayload, dueInfo, TASK_EVENT_LABELS, TASK_MOVE_LABELS, taskStatusOptions } from './task-model';
import { tasksApi } from './tasks-api';

const SOURCE_HREF: Partial<Record<string, (id: string) => string>> = {
  EVENT: (id) => `/events/${id}`,
  PROJECT: (id) => `/office/projects/${id}`,
  CASE: (id) => `/office/cases/${id}`,
};

/** Full task page (S08 task detail). */
export function TaskDetailPage({ id }: { id: string }) {
  return <TaskDetailPanel id={id} layout="page" />;
}

/**
 * Task detail with every S08 section. Used in the board drawer
 * (`layout="drawer"`) and on /tasks/[id].
 */
export function TaskDetailPanel({ id, layout, onChanged }: { id: string; layout: 'page' | 'drawer'; onChanged?: (t: TaskDetail) => void }) {
  const { data: task, error, loading, reload, setData } = useAsync(() => tasksApi.get(id), [id]);
  const [dialog, setDialog] = useState<'edit' | 'assign' | 'dependency' | 'attach' | 'evidence' | null>(null);
  const [move, setMove] = useState<TaskStatus | null>(null);
  const [review, setReview] = useState<'APPROVE' | 'RETURN' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !task) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" aria-live="polite" />;
  if (error && !task) {
    const body = <EmptyState icon={ShieldOff} title="This task could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
    return layout === 'page' ? (
      <>
        <PageHeader title="Task" breadcrumbs={[{ label: 'Campaign' }, { label: 'Tasks', href: '/tasks' }, { label: 'Task' }]} />
        <Card>{body}</Card>
      </>
    ) : (
      body
    );
  }
  if (!task) return null;

  const done = (t: TaskDetail) => {
    setData(t);
    setActionError(null);
    onChanged?.(t);
  };
  const refresh = async () => {
    await reload();
  };
  const allowed = (a: TaskDetail['allowedActions'][number]) => task.allowedActions.includes(a);
  const moves = taskStatusOptions(task);
  const due = dueInfo(task);
  const canReview = allowed('REVIEW') && task.status === 'SUBMITTED_FOR_REVIEW';
  const evidence = task.attachments.filter((a) => a.kind === 'COMPLETION_EVIDENCE');
  const attachments = task.attachments.filter((a) => a.kind === 'ATTACHMENT');

  const removeDependency = async (depId: string) => {
    try {
      done(await tasksApi.removeDependency(task.id, depId));
    } catch (err) {
      setActionError(describeCampaignError(err));
    }
  };

  const actionBar = (
    <div className="flex flex-wrap gap-2">
      {canReview ? (
        <>
          <Button size="sm" onClick={() => setReview('APPROVE')}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Approve completion
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setReview('RETURN')}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Return
          </Button>
        </>
      ) : null}
      {moves.map((to) => (
        <Button key={to} size="sm" variant={to === 'CANCELLED' || to === 'BLOCKED' ? 'ghost' : 'secondary'} onClick={() => setMove(to)}>
          {TASK_MOVE_LABELS[to]}
        </Button>
      ))}
      {allowed('ASSIGN') ? (
        <Button size="sm" variant="ghost" onClick={() => setDialog('assign')}>
          <UserCheck className="h-4 w-4" aria-hidden />
          People
        </Button>
      ) : null}
      {allowed('EDIT') ? (
        <Button size="sm" variant="ghost" onClick={() => setDialog('edit')}>
          <Pencil className="h-4 w-4" aria-hidden />
          Edit
        </Button>
      ) : null}
    </div>
  );

  const sections = (
    <div className="space-y-6">
      {task.status === 'SUBMITTED_FOR_REVIEW' ? (
        <Notice tone="sod" title="Awaiting review">
          {task.reviewer ? `${task.reviewer.displayName} reviews this task.` : 'A reviewer must approve completion.'} The owner cannot approve their own work.
        </Notice>
      ) : null}
      {task.status === 'COMPLETED' || task.status === 'CANCELLED' ? (
        <Notice tone="info" title="Closed task">
          Completed and cancelled tasks are kept unchanged. Create a new linked task to reopen the work.
        </Notice>
      ) : null}
      {actionError ? <Notice tone="error">{actionError}</Notice> : null}

      <section aria-labelledby="task-about">
        <h2 id="task-about" className="sr-only">
          About this task
        </h2>
        <Facts
          items={[
            { label: 'Owner', value: <PersonChip user={task.owner} /> },
            { label: 'Reviewer', value: task.reviewer ? <PersonChip user={task.reviewer} /> : 'No reviewer' },
            { label: 'Collaborators', value: task.collaborators.length ? task.collaborators.map((c) => c.displayName).join(', ') : 'None' },
            { label: 'Created by', value: task.createdBy.displayName, hint: formatDateTime(task.createdAt) },
            { label: 'Department', value: task.department ? `${task.department.name} (${task.department.code})` : 'Organisation-level' },
            { label: 'Team', value: task.team?.name ?? '—' },
            { label: 'Area', value: geoLabel(task.geography) },
            { label: 'Start', value: formatDateTime(task.startAt) },
            { label: 'Due', value: formatDateTime(task.dueAt), hint: due?.text },
            { label: 'Completed', value: formatDateTime(task.completedAt) },
            {
              label: 'Source',
              value: task.source ? (
                task.source.id && SOURCE_HREF[task.source.type] ? (
                  <Link className="text-deep-blue underline" href={SOURCE_HREF[task.source.type]!(task.source.id)}>
                    {TASK_SOURCE_TYPE_LABELS[task.source.type]} {task.source.label ?? ''}
                  </Link>
                ) : (
                  `${TASK_SOURCE_TYPE_LABELS[task.source.type]} ${task.source.label ?? ''}`
                )
              ) : (
                '—'
              ),
            },
          ]}
        />
      </section>

      {task.description || task.acceptanceCriteria ? (
        <section className="space-y-3">
          {task.description ? (
            <div>
              <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">Description</h3>
              <p className="whitespace-pre-wrap text-body text-ink">{task.description}</p>
            </div>
          ) : null}
          {task.acceptanceCriteria ? (
            <div>
              <h3 className="text-meta font-semibold uppercase tracking-wide text-slate">Acceptance criteria</h3>
              <p className="whitespace-pre-wrap text-body text-ink">{task.acceptanceCriteria}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <Section
        icon={Link2}
        title={`Dependencies (${task.dependencies.length})`}
        action={
          allowed('MANAGE_DEPENDENCIES') ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('dependency')}>
              <Plus className="h-4 w-4" aria-hidden />
              Add
            </Button>
          ) : null
        }
      >
        {task.openDependencyCount > 0 ? (
          <p className="mb-2 text-meta text-[#7a5a17]">
            {task.openDependencyCount} open {task.openDependencyCount === 1 ? 'dependency blocks' : 'dependencies block'} starting or completing this task.
          </p>
        ) : null}
        {task.dependencies.length === 0 ? <p className="text-body text-slate">This task does not depend on other tasks.</p> : null}
        <ul className="space-y-1">
          {task.dependencies.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2">
              <Link href={`/tasks/${d.id}`} className="flex min-w-0 items-center gap-2 text-body hover:underline">
                <span className="text-meta text-slate">{d.reference}</span>
                <span className="truncate">{d.title}</span>
                <TaskStatusBadge status={d.status} size="sm" />
              </Link>
              {allowed('MANAGE_DEPENDENCIES') ? (
                <button type="button" className="rounded p-1 text-slate hover:bg-cloud hover:text-error" onClick={() => void removeDependency(d.id)} aria-label={`Remove dependency on ${d.reference}`}>
                  <X className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {task.dependents.length ? (
          <div className="mt-3">
            <p className="text-meta text-slate">Waiting on this task:</p>
            <ul className="mt-1 space-y-1">
              {task.dependents.map((d) => (
                <li key={d.id}>
                  <Link href={`/tasks/${d.id}`} className="flex items-center gap-2 text-body hover:underline">
                    <span className="text-meta text-slate">{d.reference}</span>
                    <span className="truncate">{d.title}</span>
                    <TaskStatusBadge status={d.status} size="sm" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <ChecklistSection task={task} onSaved={done} />

      <Section
        icon={ShieldCheck}
        title={`Completion evidence (${evidence.length})`}
        action={
          allowed('ADD_EVIDENCE') ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('evidence')}>
              <Plus className="h-4 w-4" aria-hidden />
              Add evidence
            </Button>
          ) : null
        }
      >
        <AttachmentList task={task} items={evidence} empty="No completion evidence yet." />
      </Section>

      <Section
        icon={Paperclip}
        title={`Attachments (${attachments.length})`}
        action={
          allowed('ATTACH') ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('attach')}>
              <Plus className="h-4 w-4" aria-hidden />
              Attach
            </Button>
          ) : null
        }
      >
        <AttachmentList task={task} items={attachments} empty="No attachments." />
      </Section>

      <CommentsSection task={task} onAdded={refresh} />

      <Section icon={History} title="Activity">
        <ol className="relative space-y-3 border-l border-line pl-5">
          {task.timeline.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-deep-blue" aria-hidden />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-ink">{TASK_EVENT_LABELS[e.type]}</span>
                {e.fromStatus && e.toStatus ? (
                  <span className="inline-flex items-center gap-1">
                    <TaskStatusBadge status={e.fromStatus} size="sm" />→<TaskStatusBadge status={e.toStatus} size="sm" />
                  </span>
                ) : null}
                <span className="text-meta text-slate">
                  {e.actor.displayName} · <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
                </span>
              </div>
              {e.note ? <p className="mt-0.5 whitespace-pre-wrap text-body text-ink">{e.note}</p> : null}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );

  const dialogs = (
    <>
      <EditTaskDialog open={dialog === 'edit'} onClose={() => setDialog(null)} task={task} onSaved={done} />
      <AssignTaskDialog open={dialog === 'assign'} onClose={() => setDialog(null)} task={task} onSaved={done} />
      <AddDependencyDialog open={dialog === 'dependency'} onClose={() => setDialog(null)} task={task} onSaved={done} />
      <AttachTaskFileDialog open={dialog === 'attach'} onClose={() => setDialog(null)} task={task} kinds={['ATTACHMENT']} defaultKind="ATTACHMENT" onSaved={() => void refresh()} />
      <AttachTaskFileDialog open={dialog === 'evidence'} onClose={() => setDialog(null)} task={task} kinds={['COMPLETION_EVIDENCE']} defaultKind="COMPLETION_EVIDENCE" onSaved={() => void refresh()} />
      <TaskStatusDialog to={move} onClose={() => setMove(null)} task={task} onSaved={done} />
      <TaskReviewDialog decision={review} onClose={() => setReview(null)} task={task} onSaved={done} />
    </>
  );

  const badges = (
    <span className="flex flex-wrap items-center gap-2">
      <TaskStatusBadge status={task.status} />
      <TaskPriorityBadge priority={task.priority} />
      {due ? <StatusBadge kind="custom" status="due" label={due.text} tone={due.tone} icon={History} /> : null}
    </span>
  );

  if (layout === 'drawer') {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-meta text-slate">{task.reference}</p>
          <h3 className="text-section font-semibold text-navy">{task.title}</h3>
          {badges}
          <Link href={`/tasks/${task.id}`} className="inline-flex items-center gap-1 text-meta text-deep-blue underline">
            Open full page <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        </div>
        {actionBar}
        {sections}
        {dialogs}
      </div>
    );
  }
  return (
    <>
      <PageHeader title={task.title} breadcrumbs={[{ label: 'Campaign' }, { label: 'Tasks', href: '/tasks' }, { label: task.reference }]} status={badges} actions={actionBar} />
      <Card>
        <CardBody>{sections}</CardBody>
      </Card>
      {dialogs}
    </>
  );
}

function Section({ icon: Icon, title, action, children }: { icon: typeof FileText; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const id = `sec-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={id} className="flex items-center gap-2 text-card font-semibold text-ink">
          <Icon className="h-4 w-4 text-slate" aria-hidden />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AttachmentList({ task, items, empty }: { task: TaskDetail; items: TaskAttachment[]; empty: string }) {
  const [error, setError] = useState<string | null>(null);
  if (!items.length) return <p className="text-body text-slate">{empty}</p>;
  return (
    <>
      {error ? <Notice tone="error" className="mb-2">{error}</Notice> : null}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-body text-ink">
                <FileText className="h-4 w-4 shrink-0 text-slate" aria-hidden />
                <span className="truncate">{a.file.originalFilename}</span>
              </p>
              <p className="text-meta text-slate">
                {ATTACHMENT_KIND_LABELS[a.kind]} · {formatBytes(a.file.sizeBytes)} · {a.addedBy.displayName} · {formatDateTime(a.createdAt)}
                {a.note ? ` · ${a.note}` : ''}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openSignedFile(`/tasks/${task.id}/attachments/${a.id}/url`).catch((err) => setError(describeCampaignError(err)))}
              aria-label={`Open ${a.file.originalFilename}`}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

interface EditItem {
  key: string;
  id?: string;
  label: string;
  isDone: boolean;
}

function ChecklistSection({ task, onSaved }: { task: TaskDetail; onSaved: (t: TaskDetail) => void }) {
  const editable = task.allowedActions.includes('MANAGE_CHECKLIST');
  const fromTask = (): EditItem[] => task.checklistItems.map((i) => ({ key: i.id, id: i.id, label: i.label, isDone: i.isDone }));
  const [items, setItems] = useState<EditItem[]>(fromTask);
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reset when the server copy changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setItems(fromTask()), [task.version, task.id]);

  const dirty = JSON.stringify(checklistPayload(items)) !== JSON.stringify(checklistPayload(fromTask()));
  const save = async (next: EditItem[] = items) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await tasksApi.saveChecklist(task.id, { items: checklistPayload(next), expectedVersion: task.version }));
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  const doneCount = items.filter((i) => i.isDone).length;
  return (
    <Section icon={ListChecks} title={`Checklist (${doneCount}/${items.length})`}>
      {items.length ? (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-cloud" role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={doneCount}>
          <div className="h-full bg-teal" style={{ width: `${(doneCount / items.length) * 100}%` }} />
        </div>
      ) : (
        <p className="text-body text-slate">No checklist items.</p>
      )}
      <ul className="space-y-1">
        {items.map((it, idx) => {
          const doneBy = task.checklistItems.find((c) => c.id === it.id);
          return (
            <li key={it.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`chk-${it.key}`}
                checked={it.isDone}
                disabled={!editable || busy}
                onChange={(e) => setItems((s) => s.map((x, i) => (i === idx ? { ...x, isDone: e.target.checked } : x)))}
              />
              <label htmlFor={`chk-${it.key}`} className={cn('flex-1 text-body', it.isDone && 'text-slate line-through')}>
                {it.label}
                {doneBy?.isDone && doneBy.doneBy ? <span className="ml-2 text-meta text-slate no-underline">({doneBy.doneBy.displayName})</span> : null}
              </label>
              {editable ? (
                <button type="button" className="rounded p-1 text-slate hover:text-error" aria-label={`Remove “${it.label}”`} onClick={() => setItems((s) => s.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {editable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="chk-new" className="sr-only">
            New checklist item
          </label>
          <input
            id="chk-new"
            className="ngao-input h-8 max-w-sm flex-1"
            placeholder="Add an item"
            value={newLabel}
            maxLength={300}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newLabel.trim()) {
                e.preventDefault();
                setItems((s) => [...s, { key: `new-${Date.now()}`, label: newLabel.trim(), isDone: false }]);
                setNewLabel('');
              }
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!newLabel.trim()}
            onClick={() => {
              setItems((s) => [...s, { key: `new-${Date.now()}`, label: newLabel.trim(), isDone: false }]);
              setNewLabel('');
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </Button>
          {dirty ? (
            <Button size="sm" loading={busy} onClick={() => void save()}>
              <Save className="h-4 w-4" aria-hidden />
              Save checklist
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <Notice tone="error" className="mt-2">{error}</Notice> : null}
    </Section>
  );
}

function CommentsSection({ task, onAdded }: { task: TaskDetail; onAdded: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canComment = task.allowedActions.includes('COMMENT');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await tasksApi.comment(task.id, { body: body.trim() });
      setBody('');
      await onAdded();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section icon={MessageSquare} title={`Comments (${task.comments.length})`}>
      {task.comments.length === 0 ? <p className="text-body text-slate">No comments yet.</p> : null}
      <ul className="space-y-3">
        {task.comments.map((c) => (
          <li key={c.id} className="rounded-lg bg-cloud px-3 py-2">
            <p className="text-meta text-slate">
              <span className="font-medium text-ink">{c.author.displayName}</span> · <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
            </p>
            <p className="whitespace-pre-wrap text-body text-ink">{c.body}</p>
          </li>
        ))}
      </ul>
      {canComment ? (
        <form onSubmit={submit} className="mt-3">
          <label htmlFor={`cmt-${task.id}`} className="ngao-label">
            Add a comment
          </label>
          <textarea id={`cmt-${task.id}`} className={textareaClass} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
          <p className="mt-1 text-meta text-slate">Comments cannot be edited or deleted once posted.</p>
          {error ? <Notice tone="error" className="mt-2">{error}</Notice> : null}
          <div className="mt-2 flex justify-end">
            <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
              <MessageSquare className="h-4 w-4" aria-hidden />
              Post comment
            </Button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

