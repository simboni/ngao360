'use client';

import {
  type AssignTask,
  type CreateTask,
  TASK_ATTACHMENT_KINDS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskAttachmentKind,
  type TaskDetail,
  type TaskPriority,
  type TaskSourceType,
  type TaskStatus,
  type TaskSummary,
  type TeamSummary,
  type UpdateTask,
  type UserRef,
} from '@ngao360/shared';
import { CheckCircle2, Link2, Paperclip, RotateCcw, Save, UserCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { FormField, isoToLocalInput, localInputToIso, textareaClass } from '@/components/office/correspondence/office-common';
import {
  CAMPAIGN_FILE_ACCEPT,
  departmentOptionLabel,
  describeCampaignError,
  TaskStatusBadge,
  uploadCampaignFile,
  useAssignableUsers,
  useDepartmentOptions,
} from '@/components/org/campaign-common';
import { orgApi } from '@/components/org/org-api';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { moveBlockedByDependencies, moveNeedsReason, TASK_MOVE_LABELS } from './task-model';
import { tasksApi } from './tasks-api';

/* --------------------------------- Shared ---------------------------------- */

function FormActions({ busy, disabled, onCancel, children }: { busy: boolean; disabled?: boolean; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" loading={busy} disabled={disabled}>
        {children}
      </Button>
    </div>
  );
}

function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <Notice tone="error" className="mb-4">
      {error}
    </Notice>
  ) : null;
}

/** Teams of one department (GET /org/teams), for task and event forms. */
export function useDepartmentTeams(departmentId: string): TeamSummary[] {
  const { can } = useAuth();
  const allowed = can('org.teams.view');
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  useEffect(() => {
    if (!allowed || !departmentId) {
      setTeams([]);
      return;
    }
    let alive = true;
    orgApi
      .teams({ departmentId, status: 'ACTIVE', pageSize: 200 })
      .then((p) => alive && setTeams(p.items))
      .catch(() => alive && setTeams([]));
    return () => {
      alive = false;
    };
  }, [allowed, departmentId]);
  return teams;
}

function UserOptions({ users, none }: { users: UserRef[]; none?: string }) {
  return (
    <>
      {none !== undefined ? <option value="">{none}</option> : null}
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.displayName}
        </option>
      ))}
    </>
  );
}

/** Multi-select of people as a checkbox list (accessible, no custom widget). */
function PeopleChecklist({ id, users, value, onChange, exclude = [] }: { id: string; users: UserRef[]; value: string[]; onChange: (v: string[]) => void; exclude?: string[] }) {
  const list = users.filter((u) => !exclude.includes(u.id));
  return (
    <fieldset id={id} className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
      <legend className="sr-only">Collaborators</legend>
      {list.length === 0 ? <p className="text-meta text-slate">No one else to add.</p> : null}
      {list.map((u) => (
        <label key={u.id} className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={value.includes(u.id)} onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))} />
          {u.displayName}
        </label>
      ))}
    </fieldset>
  );
}

/* ------------------------------- Create task ------------------------------- */

export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
  source,
  defaults,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: TaskDetail) => void;
  /** Source record (e.g. an event) the task is created from. */
  source?: { type: TaskSourceType; id: string; label: string } | null;
  defaults?: { departmentId?: string | null };
}) {
  const { me, can } = useAuth();
  const canAssign = can('tasks.assign') || can('tasks.manage_all');
  const departments = useDepartmentOptions();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [priority, setPriority] = useState<TaskPriority>('NORMAL');
  const [ready, setReady] = useState(true);
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [checklist, setChecklist] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useAssignableUsers(departmentId ? { departmentId } : {});
  const reviewers = useAssignableUsers({ permission: 'tasks.review' });
  const teams = useDepartmentTeams(departmentId);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setCriteria('');
    setOwnerId(me?.user.id ?? '');
    setReviewerId('');
    setCollaborators([]);
    setPriority('NORMAL');
    setReady(true);
    setStartAt('');
    setDueAt('');
    setDepartmentId(defaults?.departmentId ?? '');
    setTeamId('');
    setChecklist('');
    setError(null);
  }, [open, me, defaults?.departmentId]);

  const sameReviewer = !!reviewerId && reviewerId === ownerId;
  const datesInvalid = !!startAt && !!dueAt && startAt > dueAt;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: CreateTask = {
        title: title.trim(),
        description: description.trim() || null,
        acceptanceCriteria: criteria.trim() || null,
        ownerId,
        collaboratorIds: collaborators.filter((c) => c !== ownerId),
        reviewerId: reviewerId || null,
        priority,
        status: ready ? 'READY' : 'DRAFT',
        startAt: localInputToIso(startAt) ?? null,
        dueAt: localInputToIso(dueAt) ?? null,
        departmentId: departmentId || null,
        teamId: teamId || null,
        dependsOnTaskIds: [],
        checklist: checklist
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 50),
        source: source ? { type: source.type, id: source.id } : null,
      };
      onCreated(await tasksApi.create(body));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title="New task" description={source ? `Created from ${source.label}.` : 'Tasks have one accountable owner. A reviewer, when set, must approve completion.'}>
      <form onSubmit={submit}>
        <FormField id="nt-title" label="Title" required>
          <input id="nt-title" className="ngao-input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
        </FormField>
        <FormField id="nt-desc" label="Description">
          <textarea id="nt-desc" className={textareaClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </FormField>
        <FormField id="nt-criteria" label="Acceptance criteria" hint="What “done” means; the reviewer checks against this.">
          <textarea id="nt-criteria" className={textareaClass} value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={5000} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="nt-owner" label="Owner" required hint={canAssign ? undefined : 'You can create tasks for yourself.'}>
            <select id="nt-owner" className="ngao-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={!canAssign} required>
              <UserOptions users={users} />
            </select>
          </FormField>
          <FormField id="nt-reviewer" label="Reviewer" error={sameReviewer ? 'The reviewer must be someone other than the owner.' : null}>
            <select id="nt-reviewer" className="ngao-input" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} aria-invalid={sameReviewer || undefined}>
              <UserOptions users={reviewers.filter((u) => u.id !== ownerId)} none="No reviewer" />
            </select>
          </FormField>
          <FormField id="nt-priority" label="Priority" required>
            <select id="nt-priority" className="ngao-input" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="nt-ready" label="Initial status" required>
            <select id="nt-ready" className="ngao-input" value={ready ? 'READY' : 'DRAFT'} onChange={(e) => setReady(e.target.value === 'READY')}>
              <option value="READY">Ready to start</option>
              <option value="DRAFT">Draft (still being planned)</option>
            </select>
          </FormField>
          <FormField id="nt-start" label="Start">
            <input id="nt-start" type="datetime-local" className="ngao-input" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </FormField>
          <FormField id="nt-due" label="Due" error={datesInvalid ? 'The due date must be on or after the start.' : null}>
            <input id="nt-due" type="datetime-local" className="ngao-input" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </FormField>
          <FormField id="nt-dept" label="Department">
            <select
              id="nt-dept"
              className="ngao-input"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setTeamId('');
              }}
            >
              <option value="">Organisation-level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="nt-team" label="Team">
            <select id="nt-team" className="ngao-input" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!departmentId}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="nt-collab" label="Collaborators">
          <PeopleChecklist id="nt-collab" users={users} value={collaborators} onChange={setCollaborators} exclude={[ownerId, reviewerId]} />
        </FormField>
        <FormField id="nt-checklist" label="Checklist" hint="One item per line (up to 50).">
          <textarea id="nt-checklist" className={textareaClass} value={checklist} onChange={(e) => setChecklist(e.target.value)} />
        </FormField>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={title.trim().length < 3 || !ownerId || sameReviewer || datesInvalid}>
          <Save className="h-4 w-4" aria-hidden />
          Create task
        </FormActions>
      </form>
    </Dialog>
  );
}

/* -------------------------------- Edit task -------------------------------- */

export function EditTaskDialog({ open, onClose, task, onSaved }: { open: boolean; onClose: () => void; task: TaskDetail; onSaved: (t: TaskDetail) => void }) {
  const departments = useDepartmentOptions();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teams = useDepartmentTeams(departmentId);

  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description ?? '');
    setCriteria(task.acceptanceCriteria ?? '');
    setPriority(task.priority);
    setStartAt(isoToLocalInput(task.startAt));
    setDueAt(isoToLocalInput(task.dueAt));
    setDepartmentId(task.department?.id ?? '');
    setTeamId(task.team?.id ?? '');
    setError(null);
  }, [open, task]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: UpdateTask = { expectedVersion: task.version };
      if (title.trim() !== task.title) body.title = title.trim();
      if ((description.trim() || null) !== task.description) body.description = description.trim() || null;
      if ((criteria.trim() || null) !== task.acceptanceCriteria) body.acceptanceCriteria = criteria.trim() || null;
      if (priority !== task.priority) body.priority = priority;
      if (startAt !== isoToLocalInput(task.startAt)) body.startAt = localInputToIso(startAt) ?? null;
      if (dueAt !== isoToLocalInput(task.dueAt)) body.dueAt = localInputToIso(dueAt) ?? null;
      if ((departmentId || null) !== (task.department?.id ?? null)) body.departmentId = departmentId || null;
      if ((teamId || null) !== (task.team?.id ?? null)) body.teamId = teamId || null;
      onSaved(await tasksApi.update(task.id, body));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title={`Edit ${task.reference}`}>
      <form onSubmit={submit}>
        <FormField id="et-title" label="Title" required>
          <input id="et-title" className="ngao-input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
        </FormField>
        <FormField id="et-desc" label="Description">
          <textarea id="et-desc" className={textareaClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </FormField>
        <FormField id="et-criteria" label="Acceptance criteria">
          <textarea id="et-criteria" className={textareaClass} value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={5000} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="et-priority" label="Priority" required>
            <select id="et-priority" className="ngao-input" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          <span />
          <FormField id="et-start" label="Start">
            <input id="et-start" type="datetime-local" className="ngao-input" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </FormField>
          <FormField id="et-due" label="Due">
            <input id="et-due" type="datetime-local" className="ngao-input" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </FormField>
          <FormField id="et-dept" label="Department">
            <select
              id="et-dept"
              className="ngao-input"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setTeamId('');
              }}
            >
              <option value="">Organisation-level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="et-team" label="Team">
            <select id="et-team" className="ngao-input" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!departmentId}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={title.trim().length < 3 || (!!startAt && !!dueAt && startAt > dueAt)}>
          <Save className="h-4 w-4" aria-hidden />
          Save changes
        </FormActions>
      </form>
    </Dialog>
  );
}

/* ------------------------------- Assign task ------------------------------- */

export function AssignTaskDialog({ open, onClose, task, onSaved }: { open: boolean; onClose: () => void; task: TaskDetail; onSaved: (t: TaskDetail) => void }) {
  const users = useAssignableUsers(task.department ? { departmentId: task.department.id } : {}, [task.owner, task.reviewer, ...task.collaborators]);
  const reviewers = useAssignableUsers({ permission: 'tasks.review' }, [task.reviewer]);
  const [ownerId, setOwnerId] = useState(task.owner.id);
  const [reviewerId, setReviewerId] = useState('');
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setOwnerId(task.owner.id);
    setReviewerId(task.reviewer?.id ?? '');
    setCollaborators(task.collaborators.map((c) => c.id));
    setNote('');
    setError(null);
  }, [open, task]);
  const sameReviewer = !!reviewerId && reviewerId === ownerId;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: AssignTask = { expectedVersion: task.version };
      if (ownerId !== task.owner.id) body.ownerId = ownerId;
      if ((reviewerId || null) !== (task.reviewer?.id ?? null)) body.reviewerId = reviewerId || null;
      const before = task.collaborators.map((c) => c.id).sort().join(',');
      const after = collaborators.filter((c) => c !== ownerId).sort();
      if (after.join(',') !== before) body.collaboratorIds = after;
      if (note.trim()) body.note = note.trim();
      onSaved(await tasksApi.assign(task.id, body));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`People on ${task.reference}`} description="The owner is accountable. The reviewer approves completion and must be a different person.">
      <form onSubmit={submit}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="as-owner" label="Owner" required>
            <select id="as-owner" className="ngao-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <UserOptions users={users} />
            </select>
          </FormField>
          <FormField id="as-reviewer" label="Reviewer" error={sameReviewer ? 'The reviewer must be someone other than the owner.' : null}>
            <select id="as-reviewer" className="ngao-input" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
              <UserOptions users={reviewers.filter((u) => u.id !== ownerId)} none="No reviewer" />
            </select>
          </FormField>
        </div>
        <FormField id="as-collab" label="Collaborators">
          <PeopleChecklist id="as-collab" users={users} value={collaborators} onChange={setCollaborators} exclude={[ownerId, reviewerId]} />
        </FormField>
        <FormField id="as-note" label="Note">
          <textarea id="as-note" className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </FormField>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={sameReviewer}>
          <UserCheck className="h-4 w-4" aria-hidden />
          Save assignment
        </FormActions>
      </form>
    </Dialog>
  );
}

/* ------------------------------ Status change ------------------------------ */

export function TaskStatusDialog({ to, onClose, task, onSaved }: { to: TaskStatus | null; onClose: () => void; task: TaskDetail; onSaved: (t: TaskDetail) => void }) {
  const { can } = useAuth();
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setOverride(false);
    setError(null);
  }, [to]);
  if (!to) return null;
  const blocked = moveBlockedByDependencies(to, task.openDependencyCount);
  const canOverride = blocked && can('tasks.manage_all');
  const overriding = canOverride && override;
  const needsReason = moveNeedsReason(to) || overriding;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await tasksApi.status(task.id, {
          toStatus: to,
          reason: reason.trim() || undefined,
          expectedVersion: task.version,
          ...(overriding ? { overrideOpenDependencies: true } : {}),
        }),
      );
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`${TASK_MOVE_LABELS[to]}?`} description={<span className="inline-flex flex-wrap items-center gap-2">From <TaskStatusBadge status={task.status} size="sm" /> to <TaskStatusBadge status={to} size="sm" /></span>}>
      <form onSubmit={submit}>
        {blocked ? (
          <Notice tone="warning" className="mb-4" title="Open dependencies">
            {task.openDependencyCount} {task.openDependencyCount === 1 ? 'task this depends on is' : 'tasks this depends on are'} not completed yet. {canOverride ? 'The move is refused until they are, unless you override it with a reason.' : 'The move will be refused until they are.'}
          </Notice>
        ) : null}
        {canOverride ? (
          <label className="mb-4 flex items-start gap-2 text-body text-ink">
            <input type="checkbox" className="mt-1" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            <span>Override the open dependencies (task manager). The reason is recorded on the timeline and in the audit log.</span>
          </label>
        ) : null}
        {to === 'SUBMITTED_FOR_REVIEW' && task.reviewer ? <p className="mb-4 text-body text-slate">{task.reviewer.displayName} will be asked to review it.</p> : null}
        <FormField id="ts-reason" label={needsReason ? 'Reason' : 'Note'} required={needsReason} hint="Recorded on the task timeline and in the audit log.">
          <textarea id="ts-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </FormField>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={needsReason && reason.trim().length < 3}>
          {TASK_MOVE_LABELS[to]}
        </FormActions>
      </form>
    </Dialog>
  );
}

/* ---------------------------------- Review --------------------------------- */

export function TaskReviewDialog({
  decision,
  onClose,
  task,
  onSaved,
}: {
  decision: 'APPROVE' | 'RETURN' | null;
  onClose: () => void;
  task: TaskDetail;
  onSaved: (t: TaskDetail) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setError(null);
  }, [decision]);
  if (!decision) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await tasksApi.review(task.id, { decision, note: note.trim() || undefined, expectedVersion: task.version }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  const evidence = task.attachments.filter((a) => a.kind === 'COMPLETION_EVIDENCE').length;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={decision === 'APPROVE' ? 'Approve completion' : 'Return for more work'}
      description={decision === 'APPROVE' ? 'The task moves to Completed and can no longer be changed.' : 'The task goes back to In progress and the owner is notified.'}
    >
      <form onSubmit={submit}>
        {task.acceptanceCriteria ? (
          <div className="mb-4 rounded-lg border border-line bg-cloud px-3 py-2 text-body">
            <p className="text-meta font-semibold text-slate">Acceptance criteria</p>
            <p className="whitespace-pre-wrap">{task.acceptanceCriteria}</p>
          </div>
        ) : null}
        <p className="mb-4 text-meta text-slate">
          Checklist {task.checklist.done}/{task.checklist.total} done · {evidence} completion {evidence === 1 ? 'evidence file' : 'evidence files'}
        </p>
        <FormField id="tr-note" label={decision === 'RETURN' ? 'What needs to change' : 'Note'} required={decision === 'RETURN'}>
          <textarea id="tr-note" className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={decision === 'RETURN' && note.trim().length < 3}>
          {decision === 'APPROVE' ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
          {decision === 'APPROVE' ? 'Approve' : 'Return to owner'}
        </FormActions>
      </form>
    </Dialog>
  );
}

/* ------------------------------- Dependencies ------------------------------ */

export function AddDependencyDialog({ open, onClose, task, onSaved }: { open: boolean; onClose: () => void; task: TaskDetail; onSaved: (t: TaskDetail) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TaskSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    let alive = true;
    const t = setTimeout(() => {
      tasksApi
        .list({ q: q.trim() || undefined, pageSize: 20, status: ['DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED'] })
        .then((p) => alive && setResults(p.items))
        .catch((err) => alive && setError(describeCampaignError(err)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, q]);
  const existing = new Set([task.id, ...task.dependencies.map((d) => d.id)]);
  const add = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      onSaved(await tasksApi.addDependency(task.id, { dependsOnTaskId: id }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a dependency" description={`${task.reference} cannot start or complete until the chosen task is completed. Circular dependencies are refused.`}>
      <label htmlFor="dep-q" className="ngao-label">
        Find a task
      </label>
      <input id="dep-q" className="ngao-input mb-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference or title" />
      <ErrorNotice error={error} />
      <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {results.filter((r) => !existing.has(r.id)).length === 0 ? <li className="px-3 py-4 text-body text-slate">No matching tasks.</li> : null}
        {results
          .filter((r) => !existing.has(r.id))
          .map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-ink">{r.title}</p>
                <p className="flex items-center gap-2 text-meta text-slate">
                  {r.reference} <TaskStatusBadge status={r.status} size="sm" />
                </p>
              </div>
              <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => void add(r.id)}>
                <Link2 className="h-4 w-4" aria-hidden />
                Depends on this
              </Button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}

/* ------------------------------- Attachments ------------------------------- */

const ATTACHMENT_KIND_LABELS: Record<TaskAttachmentKind, string> = { ATTACHMENT: 'Attachment', COMPLETION_EVIDENCE: 'Completion evidence' };

export function AttachTaskFileDialog({
  open,
  onClose,
  task,
  kinds,
  defaultKind,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  task: TaskDetail;
  kinds: TaskAttachmentKind[];
  defaultKind: TaskAttachmentKind;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<TaskAttachmentKind>(defaultKind);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setKind(defaultKind);
    setNote('');
    setError(null);
  }, [open, defaultKind]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await uploadCampaignFile('/tasks/files', file);
      await tasksApi.attach(task.id, { fileId: stored.id, kind, note: note.trim() || undefined });
      onSaved();
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  const tooBig = !!file && file.size > 25 * 1024 * 1024;
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Add a file" description="Images or PDF up to 25 MB. Files are stored unchanged with their fingerprint and cannot be removed.">
      <form onSubmit={submit}>
        <FormField id="ta-file" label="File" required error={tooBig ? 'The file is larger than 25 MB.' : null}>
          <input id="ta-file" type="file" accept={CAMPAIGN_FILE_ACCEPT} className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </FormField>
        {kinds.length > 1 ? (
          <FormField id="ta-kind" label="Kind" required>
            <select id="ta-kind" className="ngao-input" value={kind} onChange={(e) => setKind(e.target.value as TaskAttachmentKind)}>
              {TASK_ATTACHMENT_KINDS.filter((k) => kinds.includes(k)).map((k) => (
                <option key={k} value={k}>
                  {ATTACHMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        <FormField id="ta-note" label="Note">
          <input id="ta-note" className="ngao-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </FormField>
        <ErrorNotice error={error} />
        <FormActions busy={busy} onCancel={onClose} disabled={!file || tooBig}>
          <Paperclip className="h-4 w-4" aria-hidden />
          Upload
        </FormActions>
      </form>
    </Dialog>
  );
}

export { ATTACHMENT_KIND_LABELS };
