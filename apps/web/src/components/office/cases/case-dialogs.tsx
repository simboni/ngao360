'use client';

import {
  CASE_CATEGORIES,
  CASE_CATEGORY_LABELS,
  CASE_CLOSURE_REASON_LABELS,
  CASE_CLOSURE_REASONS,
  caseClosureAllowed,
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  type CaseCategory,
  type CaseClosureReason,
  type CaseDetail,
  type CaseEventVisibility,
  type CasePriority,
  type CaseReferral,
  type CaseSummary,
  type CaseTransition,
  INSTITUTION_TYPE_LABELS,
  type Institution,
  MAX_OFFICE_FILE_BYTES,
  OFFICE_UPLOAD_MIME_TYPES,
  REFERRAL_STATUS_LABELS,
  type ReferralStatus,
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '@ngao360/shared';
import { Globe2, Lock, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { SENSITIVITY_LABELS } from './case-badges';
import { casesApi } from './case-api';
import { addDays, describeCaseError, FormField, textareaClass, todayNairobi } from './case-form';
import { useAssignableOfficers, useCaseGeography } from './use-case-lookups';

/* --------------------------------- Shared --------------------------------- */

function ActionDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  tone = 'primary',
  onSubmit,
  children,
  size = 'md',
  disabled,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  tone?: 'primary' | 'danger';
  onSubmit: () => Promise<void>;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = `form-${title.replace(/\W+/g, '-').toLowerCase()}`;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(describeCaseError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={disabled}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        {error ? (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        ) : null}
        {children}
      </form>
    </Dialog>
  );
}

/** Text the requester will read on the tracking page: marked loudly. */
function PublicMessageField({ id, value, onChange, label = 'Message to the requester', hint, required }: { id: string; value: string; onChange: (v: string) => void; label?: string; hint?: string; required?: boolean }) {
  return (
    <FormField
      id={id}
      required={required}
      label={
        <span className="inline-flex items-center gap-1.5">
          <Globe2 className="h-3.5 w-3.5 text-teal" aria-hidden />
          {label}
          <span className="rounded border border-teal/40 bg-teal/10 px-1 text-[11px] font-semibold uppercase text-teal">Public</span>
        </span>
      }
      hint={hint ?? 'Shown to the requester on the tracking page. Plain language; no staff names, internal notes or other people’s details.'}
    >
      <textarea id={id} className={`${textareaClass} border-teal/50`} maxLength={2000} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} required={required} />
    </FormField>
  );
}

function InternalField({ id, label, value, onChange, required, hint, min = 3, max = 4000 }: { id: string; label: string; value: string; onChange: (v: string) => void; required?: boolean; hint?: string; min?: number; max?: number }) {
  return (
    <FormField
      id={id}
      required={required}
      label={
        <span className="inline-flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-slate" aria-hidden />
          {label}
          <span className="rounded border border-slate/30 bg-slate/10 px-1 text-[11px] font-semibold uppercase text-slate">Internal</span>
        </span>
      }
      hint={hint ?? 'Staff only. Recorded in the case history and the audit log.'}
    >
      <textarea id={id} className={textareaClass} minLength={required ? min : undefined} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} required={required} />
    </FormField>
  );
}

const opt = (v: string) => (v.trim() ? v.trim() : undefined);

/* ------------------------------- Transitions ------------------------------ */

const TRANSITION_COPY: Record<CaseTransition['to'], { title: string; submit: string; description: string }> = {
  TRIAGE: {
    title: 'Start triage',
    submit: 'Move to triage',
    description: 'Check category, jurisdiction, urgency, completeness and possible duplicates.',
  },
  ASSIGNED: { title: 'Mark as assigned', submit: 'Mark assigned', description: 'The case already has an assignee.' },
  IN_PROGRESS: { title: 'Mark in progress', submit: 'Mark in progress', description: 'Record that work on the case has started or resumed.' },
  CITIZEN_FEEDBACK: {
    title: 'Ask the requester for feedback',
    submit: 'Ask for feedback',
    description: 'The requester can confirm, dispute or add information on the tracking page. The case is still closed by an officer.',
  },
};

export function TransitionDialog({ detail, to, onClose, onDone }: { detail: CaseDetail; to: CaseTransition['to']; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const copy = TRANSITION_COPY[to];
  const [reason, setReason] = useState('');
  const [publicMessage, setPublicMessage] = useState(to === 'CITIZEN_FEEDBACK' ? 'We believe your request has been resolved. Please tell us whether you agree.' : '');
  const [nextReviewDate, setNextReviewDate] = useState(detail.nextReviewDate ?? '');
  return (
    <ActionDialog
      open
      onClose={onClose}
      title={copy.title}
      description={`${CASE_STATUS_LABELS[detail.status]} → ${CASE_STATUS_LABELS[to]}. ${copy.description}`}
      submitLabel={copy.submit}
      disabled={reason.trim().length < 3}
      onSubmit={async () =>
        onDone(
          await casesApi.transition(detail.id, {
            to,
            reason: reason.trim(),
            publicMessage: opt(publicMessage),
            nextReviewDate: nextReviewDate && nextReviewDate !== detail.nextReviewDate ? nextReviewDate : undefined,
            expectedVersion: detail.version,
          }),
        )
      }
    >
      <InternalField id="tr-reason" label="Reason" value={reason} onChange={setReason} required max={2000} />
      <PublicMessageField id="tr-public" value={publicMessage} onChange={setPublicMessage} />
      <FormField id="tr-review" label="Next review date">
        <input id="tr-review" type="date" className="ngao-input" min={todayNairobi()} value={nextReviewDate} onChange={(e) => setNextReviewDate(e.target.value)} />
      </FormField>
    </ActionDialog>
  );
}

/* --------------------------------- Assign --------------------------------- */

export function AssignDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const officers = useAssignableOfficers([detail.assignee], detail.id);
  const [assigneeId, setAssigneeId] = useState(detail.assignee?.id ?? '');
  const [nextReviewDate, setNextReviewDate] = useState(detail.nextReviewDate ?? addDays(todayNairobi(), 7));
  const [note, setNote] = useState('');
  const moves = detail.status === 'TRIAGE' || detail.status === 'REOPENED';
  return (
    <ActionDialog
      open
      onClose={onClose}
      title={detail.assignee ? 'Change assignee' : 'Assign the case'}
      description={
        <>
          The officer must handle cases in this location. {moves ? 'The case moves to Assigned. ' : ''}The requester sees “assigned to an officer” without a name.
        </>
      }
      submitLabel="Assign"
      disabled={!assigneeId}
      onSubmit={async () =>
        onDone(
          await casesApi.assign(detail.id, {
            assigneeId,
            nextReviewDate: nextReviewDate || undefined,
            note: opt(note),
            expectedVersion: detail.version,
          }),
        )
      }
    >
      <FormField id="as-officer" label="Officer" required hint="Officers without case permissions for this location are refused by the server.">
        <select id="as-officer" className="ngao-input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required aria-describedby="as-officer-hint">
          <option value="">Choose an officer</option>
          {officers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </FormField>
      <FormField id="as-review" label="Next review date">
        <input id="as-review" type="date" className="ngao-input" min={todayNairobi()} value={nextReviewDate} onChange={(e) => setNextReviewDate(e.target.value)} />
      </FormField>
      <InternalField id="as-note" label="Note for the officer" value={note} onChange={setNote} max={2000} />
    </ActionDialog>
  );
}

/* -------------------------------- Referral -------------------------------- */

export function ReferralDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [institutionId, setInstitutionId] = useState('');
  const [referredAt, setReferredAt] = useState(todayNairobi());
  const [contactPerson, setContactPerson] = useState('');
  const [contactDetail, setContactDetail] = useState('');
  const [institutionReference, setInstitutionReference] = useState('');
  const [followUpDate, setFollowUpDate] = useState(addDays(todayNairobi(), 14));
  const [share, setShare] = useState(false);
  const [note, setNote] = useState('');
  const [publicMessage, setPublicMessage] = useState('');

  useEffect(() => {
    casesApi
      .institutions({ active: 'true' })
      .then((p) => setInstitutions(p.items.filter((i) => i.isActive)))
      .catch((err) => setLoadError(describeCaseError(err)));
  }, []);

  const inst = institutions?.find((i) => i.id === institutionId);
  const canShare = detail.consentToContact && detail.hasContact;

  return (
    <ActionDialog
      open
      onClose={onClose}
      size="lg"
      title="Refer to the responsible institution"
      description="Use this when another public body is responsible for the issue. The office follows up; it does not take over the institution’s responsibility."
      submitLabel="Record referral"
      disabled={!institutionId || note.trim().length < 3}
      onSubmit={async () =>
        onDone(
          await casesApi.refer(detail.id, {
            institutionId,
            referredAt,
            contactPerson: opt(contactPerson),
            contactDetail: opt(contactDetail),
            institutionReference: opt(institutionReference),
            followUpDate: followUpDate || undefined,
            shareRequesterContact: canShare ? share : false,
            note: note.trim(),
            publicMessage: opt(publicMessage),
            expectedVersion: detail.version,
          }),
        )
      }
    >
      {loadError ? (
        <Notice tone="error" className="mb-4" title="Institutions could not be loaded">
          {loadError}
        </Notice>
      ) : null}
      <FormField id="rf-inst" label="Institution" required>
        <select id="rf-inst" className="ngao-input" value={institutionId} onChange={(e) => setInstitutionId(e.target.value)} required disabled={!institutions}>
          <option value="">{institutions ? 'Choose an institution' : 'Loading…'}</option>
          {institutions?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} — {INSTITUTION_TYPE_LABELS[i.type]}
            </option>
          ))}
        </select>
      </FormField>
      {inst?.mandate ? <p className="-mt-2 mb-4 rounded-lg bg-cloud px-3 py-2 text-meta text-slate">Mandate: {inst.mandate}</p> : null}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <FormField id="rf-date" label="Date referred" required>
          <input id="rf-date" type="date" className="ngao-input" max={todayNairobi()} value={referredAt} onChange={(e) => setReferredAt(e.target.value)} required />
        </FormField>
        <FormField id="rf-follow" label="Follow-up date">
          <input id="rf-follow" type="date" className="ngao-input" min={referredAt} value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
        </FormField>
        <FormField id="rf-person" label="Officer or desk at the institution" hint="An office contact, never a private person.">
          <input id="rf-person" className="ngao-input" maxLength={200} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} aria-describedby="rf-person-hint" />
        </FormField>
        <FormField id="rf-detail" label="Office phone or email">
          <input id="rf-detail" className="ngao-input" maxLength={300} value={contactDetail} onChange={(e) => setContactDetail(e.target.value)} />
        </FormField>
        <FormField id="rf-ref" label="Institution’s reference">
          <input id="rf-ref" className="ngao-input" maxLength={100} value={institutionReference} onChange={(e) => setInstitutionReference(e.target.value)} />
        </FormField>
      </div>
      <fieldset className="mb-4 rounded-lg border border-line p-3">
        <legend className="px-1 text-body font-semibold text-ink">Requester contact details</legend>
        <label className={`flex items-start gap-2 text-body ${canShare ? 'text-ink' : 'text-slate'}`}>
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal" checked={share && canShare} disabled={!canShare} onChange={(e) => setShare(e.target.checked)} aria-describedby="rf-share-hint" />
          Share the requester’s contact details with this institution
        </label>
        <p id="rf-share-hint" className="mt-1 text-meta text-slate">
          {canShare
            ? 'Only if needed to resolve the issue. The requester agreed to be contacted.'
            : detail.hasContact
              ? 'Not available: the requester did not agree to be contacted.'
              : 'Not available: no contact details were given.'}
        </p>
      </fieldset>
      <InternalField id="rf-note" label="Referral note" value={note} onChange={setNote} required />
      <PublicMessageField
        id="rf-public"
        value={publicMessage}
        onChange={setPublicMessage}
        hint={`Optional. If empty, the requester sees “Referred to ${inst?.name ?? 'the institution'}”.`}
      />
    </ActionDialog>
  );
}

export const REFERRAL_TRANSITIONS: Record<ReferralStatus, readonly ReferralStatus[]> = {
  SENT: ['ACKNOWLEDGED', 'RESPONDED', 'NO_RESPONSE', 'CLOSED'],
  ACKNOWLEDGED: ['RESPONDED', 'NO_RESPONSE', 'CLOSED'],
  RESPONDED: ['CLOSED'],
  NO_RESPONSE: ['CLOSED'],
  CLOSED: [],
};

export function ReferralUpdateDialog({ caseId, referral, onClose, onDone }: { caseId: string; referral: CaseReferral; onClose: () => void; onDone: () => void }) {
  const next = REFERRAL_TRANSITIONS[referral.status];
  const [status, setStatus] = useState<ReferralStatus | ''>('');
  const [followUpDate, setFollowUpDate] = useState(referral.followUpDate ?? '');
  const [institutionReference, setInstitutionReference] = useState(referral.institutionReference ?? '');
  const [responseSummary, setResponseSummary] = useState(referral.responseSummary ?? '');
  const [note, setNote] = useState('');
  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Update referral to ${referral.institution.name}`}
      description={`Current status: ${REFERRAL_STATUS_LABELS[referral.status]}. Updates are internal.`}
      submitLabel="Save update"
      disabled={note.trim().length < 3}
      onSubmit={async () => {
        await casesApi.updateReferral(caseId, referral.id, {
          status: status || undefined,
          followUpDate: followUpDate !== (referral.followUpDate ?? '') ? followUpDate || null : undefined,
          institutionReference: institutionReference !== (referral.institutionReference ?? '') ? institutionReference.trim() : undefined,
          responseSummary: responseSummary !== (referral.responseSummary ?? '') ? responseSummary.trim() : undefined,
          note: note.trim(),
        });
        onDone();
      }}
    >
      <FormField id="ru-status" label="New status">
        <select id="ru-status" className="ngao-input" value={status} onChange={(e) => setStatus(e.target.value as ReferralStatus | '')}>
          <option value="">Keep {REFERRAL_STATUS_LABELS[referral.status]}</option>
          {next.map((s) => (
            <option key={s} value={s}>
              {REFERRAL_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </FormField>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <FormField id="ru-follow" label="Follow-up date">
          <input id="ru-follow" type="date" className="ngao-input" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
        </FormField>
        <FormField id="ru-ref" label="Institution’s reference">
          <input id="ru-ref" className="ngao-input" maxLength={100} value={institutionReference} onChange={(e) => setInstitutionReference(e.target.value)} />
        </FormField>
      </div>
      <InternalField id="ru-summary" label="Institution’s response" value={responseSummary} onChange={setResponseSummary} hint="What the institution said or did." />
      <InternalField id="ru-note" label="Note" value={note} onChange={setNote} required />
    </ActionDialog>
  );
}

/* --------------------------- Resolution and closure ------------------------ */

export function ProposeResolutionDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const [summary, setSummary] = useState('');
  const [internalNote, setInternalNote] = useState('');
  return (
    <ActionDialog
      open
      onClose={onClose}
      size="lg"
      title="Propose a resolution"
      description={
        detail.closeRequiresSecondPerson
          ? 'Describe the action taken and the evidence for it. A different officer must close the case after you propose the resolution.'
          : 'Describe the action taken and the evidence for it.'
      }
      submitLabel="Propose resolution"
      disabled={summary.trim().length < 10}
      onSubmit={async () => onDone(await casesApi.proposeResolution(detail.id, { summary: summary.trim(), internalNote: opt(internalNote), expectedVersion: detail.version }))}
    >
      <PublicMessageField
        id="pr-summary"
        label="Resolution summary"
        value={summary}
        onChange={setSummary}
        required
        hint="At least 10 characters. The requester sees this and may confirm or dispute it. Say what was done and by which institution; do not claim work the office did not do."
      />
      <InternalField id="pr-note" label="Internal note" value={internalNote} onChange={setInternalNote} />
    </ActionDialog>
  );
}

export function CloseDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const { me } = useAuth();
  const triage = detail.status === 'SUBMITTED' || detail.status === 'TRIAGE';
  // "Resolved" only after a resolution was proposed; other reasons from any open stage.
  const reasons = CASE_CLOSURE_REASONS.filter((r) => caseClosureAllowed(detail.status, r));
  const [closureReason, setClosureReason] = useState<CaseClosureReason | ''>(reasons.includes('RESOLVED') ? 'RESOLVED' : '');
  const [note, setNote] = useState('');
  const [publicMessage, setPublicMessage] = useState('');
  const [dupQuery, setDupQuery] = useState('');
  const [dupResults, setDupResults] = useState<CaseSummary[]>([]);
  const [duplicateOfId, setDuplicateOfId] = useState(detail.duplicateOf?.id ?? '');
  const sodBlocked = detail.closeRequiresSecondPerson && !!detail.resolution && detail.resolution.proposedBy.id === me?.user.id;

  const searchDuplicates = async () => {
    if (dupQuery.trim().length < 2) return;
    const page = await casesApi.list({ q: dupQuery.trim(), pageSize: 10 });
    setDupResults(page.items.filter((c) => c.id !== detail.id));
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      size="lg"
      tone="danger"
      title={triage ? 'Close at triage' : 'Close the case'}
      description="The closure reason and your name are recorded. Closing never deletes the case; it can be reopened with a reason."
      submitLabel="Close case"
      disabled={sodBlocked || !closureReason || note.trim().length < 3 || (closureReason === 'DUPLICATE' && !duplicateOfId)}
      onSubmit={async () =>
        onDone(
          await casesApi.close(detail.id, {
            closureReason: closureReason as CaseClosureReason,
            note: note.trim(),
            publicMessage: opt(publicMessage),
            duplicateOfId: closureReason === 'DUPLICATE' ? duplicateOfId : undefined,
            expectedVersion: detail.version,
          }),
        )
      }
    >
      {sodBlocked ? (
        <Notice tone="sod" className="mb-4" title="A second officer must close this case">
          You proposed the resolution. Your office requires a different authorised officer to close it.
        </Notice>
      ) : null}
      <FormField id="cl-reason" label="Closure reason" required>
        <select id="cl-reason" className="ngao-input" value={closureReason} onChange={(e) => setClosureReason(e.target.value as CaseClosureReason)} required>
          <option value="">Choose a reason</option>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {CASE_CLOSURE_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </FormField>
      {closureReason === 'DUPLICATE' ? (
        <fieldset className="mb-4 rounded-lg border border-line p-3">
          <legend className="px-1 text-body font-semibold text-ink">Duplicate of</legend>
          <div className="flex gap-2">
            <label htmlFor="cl-dup-q" className="sr-only">
              Search by reference or title
            </label>
            <input id="cl-dup-q" className="ngao-input" placeholder="Search by reference or title" value={dupQuery} onChange={(e) => setDupQuery(e.target.value)} />
            <Button type="button" variant="secondary" onClick={() => void searchDuplicates().catch(() => setDupResults([]))}>
              Search
            </Button>
          </div>
          {dupResults.length ? (
            <ul className="mt-2 space-y-1">
              {dupResults.map((c) => (
                <li key={c.id}>
                  <label className="flex items-start gap-2 text-body">
                    <input type="radio" name="dup" className="mt-1 accent-teal" checked={duplicateOfId === c.id} onChange={() => setDuplicateOfId(c.id)} />
                    <span>
                      <span className="font-medium">{c.reference}</span> — {c.title}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {detail.duplicateOf && duplicateOfId === detail.duplicateOf.id ? <p className="mt-2 text-meta text-slate">Already marked as a duplicate of {detail.duplicateOf.reference}.</p> : null}
        </fieldset>
      ) : null}
      <InternalField id="cl-note" label="Closure note" value={note} onChange={setNote} required />
      <PublicMessageField id="cl-public" value={publicMessage} onChange={setPublicMessage} hint="Optional. If empty, the requester sees a standard closure message." />
    </ActionDialog>
  );
}

export function ReopenDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const [reason, setReason] = useState('');
  const [publicMessage, setPublicMessage] = useState('');
  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Reopen the case"
      description="Reopening adds a new event. The earlier closure stays in the timeline."
      submitLabel="Reopen"
      disabled={reason.trim().length < 3}
      onSubmit={async () => onDone(await casesApi.reopen(detail.id, { reason: reason.trim(), publicMessage: opt(publicMessage), expectedVersion: detail.version }))}
    >
      <InternalField id="ro-reason" label="Reason" value={reason} onChange={setReason} required max={2000} />
      <PublicMessageField id="ro-public" value={publicMessage} onChange={setPublicMessage} />
    </ActionDialog>
  );
}

/* ---------------------------------- Edit ---------------------------------- */

export function EditCaseDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: (d: CaseDetail) => void }) {
  const geo = useCaseGeography();
  const [title, setTitle] = useState(detail.title);
  const [category, setCategory] = useState<CaseCategory>(detail.category);
  const [priority, setPriority] = useState<CasePriority>(detail.priority);
  const [sensitivity, setSensitivity] = useState<SensitivityLevel>(detail.sensitivity);
  const [nextReviewDate, setNextReviewDate] = useState(detail.nextReviewDate ?? '');
  const [constituencyId, setConstituencyId] = useState(detail.location.constituency?.id ?? '');
  const [wardId, setWardId] = useState(detail.location.ward?.id ?? '');
  const [landmark, setLandmark] = useState(detail.location.description ?? '');
  const [reason, setReason] = useState('');
  const unitBefore = detail.location.ward?.id ?? detail.location.constituency?.id ?? '';
  const unitAfter = wardId || constituencyId;
  const wards = geo?.wards.filter((w) => w.constituencyId === constituencyId) ?? [];

  return (
    <ActionDialog
      open
      onClose={onClose}
      size="lg"
      title="Edit case details"
      description="The requester’s original description cannot be changed. Only changed fields are saved and audited."
      submitLabel="Save changes"
      disabled={reason.trim().length < 3}
      onSubmit={async () =>
        onDone(
          await casesApi.update(detail.id, {
            title: title.trim() !== detail.title ? title.trim() : undefined,
            category: category !== detail.category ? category : undefined,
            priority: priority !== detail.priority ? priority : undefined,
            sensitivity: sensitivity !== detail.sensitivity ? sensitivity : undefined,
            nextReviewDate: nextReviewDate !== (detail.nextReviewDate ?? '') ? nextReviewDate || null : undefined,
            geographicUnitId: unitAfter && unitAfter !== unitBefore ? unitAfter : undefined,
            locationDescription: landmark.trim() !== (detail.location.description ?? '') ? landmark.trim() : undefined,
            reason: reason.trim(),
            expectedVersion: detail.version,
          }),
        )
      }
    >
      <FormField id="ed-title" label="Title" required>
        <input id="ed-title" className="ngao-input" maxLength={160} minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} required />
      </FormField>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <FormField id="ed-category" label="Category" required>
          <select id="ed-category" className="ngao-input" value={category} onChange={(e) => setCategory(e.target.value as CaseCategory)}>
            {CASE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CASE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="ed-priority" label="Priority" required>
          <select id="ed-priority" className="ngao-input" value={priority} onChange={(e) => setPriority(e.target.value as CasePriority)}>
            {CASE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {CASE_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="ed-sensitivity" label="Sensitivity" required>
          <select id="ed-sensitivity" className="ngao-input" value={sensitivity} onChange={(e) => setSensitivity(e.target.value as SensitivityLevel)}>
            {SENSITIVITY_LEVELS.map((s) => (
              <option key={s} value={s}>
                {SENSITIVITY_LABELS[s]}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField id="ed-review" label="Next review date" hint="Leave empty to clear it.">
        <input id="ed-review" type="date" className="ngao-input" value={nextReviewDate} onChange={(e) => setNextReviewDate(e.target.value)} aria-describedby="ed-review-hint" />
      </FormField>
      {geo ? (
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ed-const" label="Constituency">
            <select
              id="ed-const"
              className="ngao-input"
              value={constituencyId}
              onChange={(e) => {
                setConstituencyId(e.target.value);
                setWardId('');
              }}
            >
              <option value="">Not set</option>
              {geo.constituencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ed-ward" label="Ward">
            <select id="ed-ward" className="ngao-input" value={wardId} disabled={!constituencyId} onChange={(e) => setWardId(e.target.value)}>
              <option value="">Not set</option>
              {wards.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      ) : null}
      <FormField id="ed-landmark" label="Landmark">
        <input id="ed-landmark" className="ngao-input" maxLength={300} value={landmark} onChange={(e) => setLandmark(e.target.value)} />
      </FormField>
      <InternalField id="ed-reason" label="Reason for the change" value={reason} onChange={setReason} required max={2000} />
    </ActionDialog>
  );
}

/* -------------------------------- Evidence -------------------------------- */

export function EvidenceDialog({ detail, onClose, onDone }: { detail: CaseDetail; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<CaseEventVisibility>('INTERNAL');

  const pick = (f: File | undefined) => {
    setFileError(null);
    setFile(null);
    if (!f) return;
    if (!(OFFICE_UPLOAD_MIME_TYPES as readonly string[]).includes(f.type)) {
      setFileError('Choose an image (JPEG, PNG, WebP, HEIC) or a PDF.');
      return;
    }
    if (f.size > MAX_OFFICE_FILE_BYTES) {
      setFileError('The file is larger than 25 MB.');
      return;
    }
    setFile(f);
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Add evidence"
      description="Files are stored unchanged with a fingerprint (SHA-256) and cannot be edited or deleted."
      submitLabel="Upload evidence"
      disabled={!file || description.trim().length < 2}
      onSubmit={async () => {
        await casesApi.addEvidence(detail.id, file!, { description: description.trim(), visibility });
        onDone();
      }}
    >
      <FormField id="ev-file" label="File" required hint="Image or PDF, up to 25 MB.">
        <input id="ev-file" type="file" accept={OFFICE_UPLOAD_MIME_TYPES.join(',')} className="block w-full text-body" onChange={(e) => pick(e.target.files?.[0])} aria-describedby="ev-file-hint" />
      </FormField>
      {fileError ? (
        <Notice tone="error" className="-mt-2 mb-4">
          {fileError}
        </Notice>
      ) : null}
      <FormField id="ev-desc" label="Description" required>
        <input id="ev-desc" className="ngao-input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} required />
      </FormField>
      <fieldset className="mb-2">
        <legend className="ngao-label">Who can see this evidence?</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2 rounded-lg border border-line p-2 text-body">
            <input type="radio" name="ev-vis" className="mt-1 accent-teal" checked={visibility === 'INTERNAL'} onChange={() => setVisibility('INTERNAL')} />
            <span>
              <span className="inline-flex items-center gap-1 font-medium">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                Internal — staff only
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-teal/40 p-2 text-body">
            <input type="radio" name="ev-vis" className="mt-1 accent-teal" checked={visibility === 'PUBLIC'} onChange={() => setVisibility('PUBLIC')} />
            <span>
              <span className="inline-flex items-center gap-1 font-medium text-teal">
                <Globe2 className="h-3.5 w-3.5" aria-hidden />
                Public — the requester sees the description
              </span>
              <span className="block text-meta text-slate">The file itself is never shown on the tracking page.</span>
            </span>
          </label>
        </div>
      </fieldset>
      {visibility === 'PUBLIC' ? (
        <p className="flex items-center gap-1 text-meta text-[#7a5a17]">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
          Write the description so it is safe for the requester to read.
        </p>
      ) : null}
    </ActionDialog>
  );
}
