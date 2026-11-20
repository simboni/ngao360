'use client';

import {
  MAX_OFFICE_FILE_BYTES,
  MILESTONE_STATUS_LABELS,
  MILESTONE_STATUSES,
  type MilestoneStatus,
  OFFICE_UPLOAD_MIME_TYPES,
  PROJECT_EVIDENCE_TYPE_LABELS,
  PROJECT_EVIDENCE_TYPES,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_TRANSITIONS,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectEvidenceType,
  type ProjectMilestone,
  type ProjectStatus,
} from '@ngao360/shared';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { dateInNairobi, describeOfficeError, FormField, formatBytes, formatDate, textareaClass } from '../correspondence/office-common';
import { citableCompletionEvidence, isPhoto } from './project-model';
import { projectsApi } from './projects-api';

function useSubmit<T>(fn: () => Promise<T>, onOk: (v: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onOk(await fn());
    } catch (err) {
      setError(describeOfficeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Shell({
  title,
  description,
  form,
  busy,
  disabled,
  submitLabel,
  onClose,
  children,
  error,
  size,
}: {
  title: string;
  description?: ReactNode;
  form: string;
  busy: boolean;
  disabled?: boolean;
  submitLabel: string;
  onClose: () => void;
  children: ReactNode;
  error: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      size={size}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={form} loading={busy} disabled={disabled}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      ) : null}
    </Dialog>
  );
}

/** Transitions offered in the status dialog: VERIFIED_COMPLETED only through verify-completion. */
export function projectTransitionTargets(status: ProjectStatus): ProjectStatus[] {
  return PROJECT_STATUS_TRANSITIONS[status].filter((s) => s !== 'VERIFIED_COMPLETED');
}

export function TransitionDialog({ project, onClose, onSaved }: { project: ProjectDetail; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const targets = projectTransitionTargets(project.status);
  const [to, setTo] = useState<ProjectStatus>(targets[0] ?? project.status);
  const [reason, setReason] = useState('');
  const [delayReason, setDelayReason] = useState('');
  const [completionDate, setCompletionDate] = useState(dateInNairobi());
  const s = useSubmit(
    () =>
      projectsApi.transition(project.id, {
        to: to as Exclude<ProjectStatus, 'VERIFIED_COMPLETED'>,
        reason: reason.trim(),
        delayReason: to === 'DELAYED' ? delayReason.trim() : undefined,
        actualCompletionDate: to === 'COMPLETED' ? completionDate : undefined,
        expectedVersion: project.version,
      }),
    onSaved,
  );
  const invalid = reason.trim().length < 3 || (to === 'DELAYED' && delayReason.trim().length < 3) || (to === 'COMPLETED' && !completionDate);
  return (
    <Shell title={`Change status of ${project.reference}`} description="Every change is recorded with your reason." form="prj-transition" busy={s.busy} disabled={invalid} submitLabel="Change status" onClose={onClose} error={s.error}>
      <form id="prj-transition" onSubmit={s.run}>
        <FormField id="pt-to" label="New status" required>
          <select id="pt-to" className="ngao-input pr-8" value={to} onChange={(e) => setTo(e.target.value as ProjectStatus)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {PROJECT_STATUS_LABELS[t]}
              </option>
            ))}
          </select>
        </FormField>
        {to === 'COMPLETED' ? (
          <>
            <Notice tone="warning" className="mb-3" title="This records a report of completion, not a verification">
              The project will show as &ldquo;Reported complete — awaiting independent verification&rdquo; until a different person verifies it against an inspection report, completion
              certificate or handover document. You will not be able to verify it yourself.
            </Notice>
            <FormField id="pt-date" label="Actual completion date" required>
              <input id="pt-date" type="date" className="ngao-input" value={completionDate} max={dateInNairobi()} onChange={(e) => setCompletionDate(e.target.value)} />
            </FormField>
          </>
        ) : null}
        {project.status === 'VERIFIED_COMPLETED' ? (
          <Notice tone="warning" className="mb-3">
            Moving back to Ongoing withdraws the completion verification and clears the completion fields.
          </Notice>
        ) : null}
        {to === 'DELAYED' ? (
          <FormField id="pt-delay" label="Delay reason" required hint="Shown on the record (and publicly if the schedule is published).">
            <textarea id="pt-delay" className={textareaClass} value={delayReason} maxLength={2000} onChange={(e) => setDelayReason(e.target.value)} />
          </FormField>
        ) : null}
        <FormField id="pt-reason" label="Reason for the change" required hint="Cite the source, e.g. the responsible body's letter or report.">
          <textarea id="pt-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </form>
    </Shell>
  );
}

/** COMPLETED → VERIFIED_COMPLETED (reauth). Only citable evidence is offered. */
export function VerifyCompletionDialog({ project, meId, onClose, onSaved }: { project: ProjectDetail; meId: string | undefined; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const highRisk = useHighRisk();
  const citable = citableCompletionEvidence(project, meId);
  const [ids, setIds] = useState<string[]>(citable.map((e) => e.id));
  const [note, setNote] = useState('');
  const s = useSubmit(() => highRisk(() => projectsApi.verifyCompletion(project.id, { evidenceIds: ids, note: note.trim(), expectedVersion: project.version })), onSaved);
  return (
    <Shell
      title={`Verify completion of ${project.reference}`}
      description="You confirm that the cited documents show the project was completed. You will be asked for your password."
      form="prj-verify-completion"
      busy={s.busy}
      disabled={!ids.length || note.trim().length < 10}
      submitLabel="Verify completion"
      onClose={onClose}
      error={s.error}
    >
      <form id="prj-verify-completion" onSubmit={s.run}>
        <fieldset className="mb-4">
          <legend className="ngao-label">Evidence relied on</legend>
          <p className="mb-2 text-meta text-slate">Only verified inspection reports, completion certificates and handover documents that you did not upload can be cited. Photographs cannot.</p>
          <ul className="space-y-1">
            {citable.map((e) => (
              <li key={e.id}>
                <label className="flex items-start gap-2 text-body">
                  <input type="checkbox" className="mt-1" checked={ids.includes(e.id)} onChange={(ev) => setIds((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))} />
                  <span>
                    {PROJECT_EVIDENCE_TYPE_LABELS[e.type]}: {e.description}
                    <span className="block text-meta text-slate">
                      {e.sourceDescription ?? 'Source not stated'} · {formatDate(e.capturedOn)} · uploaded by {e.uploadedBy.displayName}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <FormField id="vc-note" label="Verification note" required hint="At least 10 characters: what you checked and where.">
          <textarea id="vc-note" className={textareaClass} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </form>
    </Shell>
  );
}

export function VerifyRecordDialog({
  title,
  description,
  onClose,
  submit,
  allowDispute = true,
}: {
  title: string;
  description: ReactNode;
  onClose: () => void;
  submit: (body: { status: 'VERIFIED' | 'DISPUTED'; note: string }) => Promise<void>;
  allowDispute?: boolean;
}) {
  const [status, setStatus] = useState<'VERIFIED' | 'DISPUTED'>('VERIFIED');
  const [note, setNote] = useState('');
  const s = useSubmit(() => submit({ status, note: note.trim() }), () => undefined);
  return (
    <Shell title={title} description={description} form="prj-verify" busy={s.busy} disabled={note.trim().length < 3} submitLabel={status === 'VERIFIED' ? 'Record as verified' : 'Record as disputed'} onClose={onClose} error={s.error}>
      <form id="prj-verify" onSubmit={s.run}>
        {allowDispute ? (
          <fieldset className="mb-4">
            <legend className="ngao-label">Your finding</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-body">
                <input type="radio" name="vr" checked={status === 'VERIFIED'} onChange={() => setStatus('VERIFIED')} />
                <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
                Verified
              </label>
              <label className="flex items-center gap-2 text-body">
                <input type="radio" name="vr" checked={status === 'DISPUTED'} onChange={() => setStatus('DISPUTED')} />
                <AlertTriangle className="h-4 w-4 text-error" aria-hidden />
                Disputed
              </label>
            </div>
          </fieldset>
        ) : null}
        <FormField id="vr-note" label="Note" required hint="What you checked (document, site visit, ledger) and the outcome.">
          <textarea id="vr-note" className={textareaClass} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </form>
    </Shell>
  );
}

export function MilestoneDialog({ project, milestone, onClose, onSaved }: { project: ProjectDetail; milestone?: ProjectMilestone; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(milestone?.title ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [plannedDate, setPlannedDate] = useState(milestone?.plannedDate ?? '');
  const [status, setStatus] = useState<MilestoneStatus>(milestone?.status ?? 'PLANNED');
  const [actualDate, setActualDate] = useState(milestone?.actualDate ?? '');
  const s = useSubmit(async () => {
    if (milestone) {
      await projectsApi.updateMilestone(project.id, milestone.id, {
        ...(title.trim() !== milestone.title ? { title: title.trim() } : {}),
        ...(description.trim() !== (milestone.description ?? '') && description.trim() ? { description: description.trim() } : {}),
        ...(plannedDate !== (milestone.plannedDate ?? '') && plannedDate ? { plannedDate } : {}),
        ...(status !== milestone.status ? { status } : {}),
        ...(actualDate !== (milestone.actualDate ?? '') ? { actualDate: actualDate || null } : {}),
      });
    } else {
      await projectsApi.addMilestone(project.id, { title: title.trim(), description: description.trim() || undefined, plannedDate: plannedDate || undefined });
    }
  }, onSaved);
  const resetsVerification = !!milestone && milestone.verificationStatus !== 'UNVERIFIED' && (status !== milestone.status || actualDate !== (milestone.actualDate ?? ''));
  return (
    <Shell
      title={milestone ? `Update milestone ${milestone.sequence}` : 'Add a milestone'}
      description="Milestones are never deleted; cancel one instead."
      form="prj-milestone"
      busy={s.busy}
      disabled={title.trim().length < 2}
      submitLabel="Save milestone"
      onClose={onClose}
      error={s.error}
    >
      <form id="prj-milestone" onSubmit={s.run}>
        <FormField id="ms-title" label="Title" required>
          <input id="ms-title" className="ngao-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField id="ms-desc" label="Description">
          <textarea id="ms-desc" className={textareaClass} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ms-planned" label="Planned date">
            <input id="ms-planned" type="date" className="ngao-input" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
          </FormField>
          {milestone ? (
            <>
              <FormField id="ms-status" label="Status" required>
                <select id="ms-status" className="ngao-input pr-8" value={status} onChange={(e) => setStatus(e.target.value as MilestoneStatus)}>
                  {MILESTONE_STATUSES.map((m) => (
                    <option key={m} value={m}>
                      {MILESTONE_STATUS_LABELS[m]}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField id="ms-actual" label="Actual date">
                <input id="ms-actual" type="date" className="ngao-input" value={actualDate} max={dateInNairobi()} onChange={(e) => setActualDate(e.target.value)} />
              </FormField>
            </>
          ) : null}
        </div>
        {resetsVerification ? (
          <Notice tone="warning">Changing the status or actual date resets this milestone&rsquo;s verification to &ldquo;Not verified&rdquo;.</Notice>
        ) : null}
      </form>
    </Shell>
  );
}

export function AddEvidenceDialog({ project, defaultType, onClose, onSaved }: { project: ProjectDetail; defaultType?: ProjectEvidenceType; onClose: () => void; onSaved: (e: ProjectEvidence) => void }) {
  const [type, setType] = useState<ProjectEvidenceType>(defaultType ?? 'INSPECTION_REPORT');
  const [milestoneId, setMilestoneId] = useState('');
  const [description, setDescription] = useState('');
  const [capturedOn, setCapturedOn] = useState('');
  const [source, setSource] = useState('');
  const [withLocation, setWithLocation] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileError =
    file && !(OFFICE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)
      ? 'Use an image (JPEG, PNG, WebP, HEIC) or a PDF.'
      : file && file.size > MAX_OFFICE_FILE_BYTES
        ? `The file is larger than ${formatBytes(MAX_OFFICE_FILE_BYTES)}.`
        : null;
  const coordsBad = withLocation && (lat.trim() === '' || lng.trim() === '' || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng)));
  const s = useSubmit(
    () =>
      projectsApi.addEvidence(project.id, file as File, {
        type,
        milestoneId: milestoneId || undefined,
        description: description.trim(),
        capturedOn: capturedOn || undefined,
        sourceDescription: source.trim() || undefined,
        ...(withLocation ? { latitude: Number(lat), longitude: Number(lng) } : {}),
      }),
    onSaved,
  );
  return (
    <Shell
      title={`Add evidence to ${project.reference}`}
      description="Files are stored unchanged with their SHA-256 hash. Someone other than you must verify them."
      form="prj-evidence"
      busy={s.busy}
      disabled={!file || !!fileError || description.trim().length < 3 || coordsBad}
      submitLabel="Upload evidence"
      onClose={onClose}
      error={s.error}
      size="lg"
    >
      <form id="prj-evidence" onSubmit={s.run}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ev-type" label="Type" required>
            <select id="ev-type" className="ngao-input pr-8" value={type} onChange={(e) => setType(e.target.value as ProjectEvidenceType)}>
              {PROJECT_EVIDENCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROJECT_EVIDENCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ev-ms" label="Milestone">
            <select id="ev-ms" className="ngao-input pr-8" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              <option value="">Whole project</option>
              {project.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.sequence}. {m.title}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {isPhoto(type) ? (
          <Notice tone="info" className="mb-4">
            Photographs show progress. A photograph alone is never accepted as proof of completion.
          </Notice>
        ) : null}
        <FormField id="ev-desc" label="Description" required>
          <textarea id="ev-desc" className={textareaClass} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ev-date" label={isPhoto(type) ? 'Date taken' : 'Date issued'}>
            <input id="ev-date" type="date" className="ngao-input" value={capturedOn} max={dateInNairobi()} onChange={(e) => setCapturedOn(e.target.value)} />
          </FormField>
          <FormField id="ev-source" label="Issued by / taken by" hint='e.g. "County Public Works inspectorate".'>
            <input id="ev-source" className="ngao-input" value={source} maxLength={300} onChange={(e) => setSource(e.target.value)} />
          </FormField>
        </div>
        <label className="mb-2 flex items-start gap-2 text-body">
          <input type="checkbox" className="mt-1" checked={withLocation} onChange={(e) => setWithLocation(e.target.checked)} />
          <span>
            Record where this was taken
            <span className="block text-meta text-slate">Only when appropriate (a public site). Location is never read from the file automatically.</span>
          </span>
        </label>
        {withLocation ? (
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="ev-lat" label="Latitude" required>
              <input id="ev-lat" inputMode="decimal" className="ngao-input" value={lat} onChange={(e) => setLat(e.target.value)} />
            </FormField>
            <FormField id="ev-lng" label="Longitude" required>
              <input id="ev-lng" inputMode="decimal" className="ngao-input" value={lng} onChange={(e) => setLng(e.target.value)} />
            </FormField>
          </div>
        ) : null}
        <FormField id="ev-file" label="File" required error={fileError} hint="Image or PDF up to 25 MB.">
          <input id="ev-file" type="file" accept={OFFICE_UPLOAD_MIME_TYPES.join(',')} className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
      </form>
    </Shell>
  );
}
