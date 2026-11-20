'use client';

import {
  INCIDENT_CATEGORIES,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_ESCALATION_TARGET_LABELS,
  INCIDENT_ESCALATION_TARGETS,
  INCIDENT_OUTCOME_LABELS,
  INCIDENT_OUTCOMES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  type IncidentDetail,
  SENSITIVITY_LEVELS,
} from '@ngao360/shared';
import { type ReactNode, useId, useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { assigneeCandidates, SENSITIVITY_LABELS } from './incident-model';

export type IncidentDialogKind =
  | 'triage'
  | 'assign'
  | 'escalate'
  | 'note'
  | 'correction'
  | 'refer'
  | 'hold'
  | 'release'
  | 'resolve'
  | 'close'
  | 'reopen'
  | 'subject';

/** One dialog per incident action (API §20). Each sends `expectedVersion` and surfaces 409 conflicts. */
export function IncidentActionDialog({ kind, incident, onClose, onDone }: { kind: IncidentDialogKind; incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  switch (kind) {
    case 'triage':
      return <TriageDialog incident={incident} onClose={onClose} onDone={onDone} />;
    case 'assign':
      return <AssignDialog incident={incident} onClose={onClose} onDone={onDone} />;
    case 'escalate':
      return <EscalateDialog incident={incident} onClose={onClose} onDone={onDone} />;
    case 'resolve':
      return <ResolveDialog incident={incident} onClose={onClose} onDone={onDone} />;
    case 'subject':
      return <SubjectDialog incident={incident} onClose={onClose} onDone={onDone} />;
    default:
      return <TextActionDialog kind={kind} incident={incident} onClose={onClose} onDone={onDone} />;
  }
}

function useAction(onDone: () => void) {
  const { run } = useTallyActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run(fn);
      onDone();
    } catch (err) {
      setError(describeFieldError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}

function Shell({ title, description, busy, disabled, confirm, danger, onClose, onConfirm, error, children }: {
  title: string;
  description?: ReactNode;
  busy: boolean;
  disabled: boolean;
  confirm: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={disabled} variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}

function TextArea({ label, value, onChange, min = 3, max = 4000, hint }: { label: string; value: string; onChange: (v: string) => void; min?: number; max?: number; hint?: string }) {
  const id = useId();
  const short = value.trim().length < min;
  return (
    <div>
      <label htmlFor={id} className="ngao-label">
        {label}
      </label>
      <textarea id={id} rows={4} className="ngao-input h-auto py-2" value={value} onChange={(e) => onChange(e.target.value)} maxLength={max} aria-invalid={value.length > 0 && short} />
      <p className="mt-1 text-meta text-slate">{hint ?? `At least ${min} characters.`} {value.trim().length}/{max}</p>
    </div>
  );
}

const NEUTRAL_HINT = 'Describe what was done or observed in neutral, factual terms. Do not name individuals here; use the restricted subject record if referral requires it.';

function TriageDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const [severity, setSeverity] = useState(incident.severity);
  const [category, setCategory] = useState(incident.category);
  const [sensitivity, setSensitivity] = useState(incident.sensitivity);
  const [note, setNote] = useState('');
  const { busy, error, go } = useAction(onDone);
  return (
    <Shell
      title={incident.status === 'REPORTED' ? 'Acknowledge and triage' : 'Re-triage'}
      description="Set the working severity and category. The category the reporter chose stays on the original report."
      busy={busy}
      disabled={note.trim().length < 3}
      confirm="Save triage"
      onClose={onClose}
      error={error}
      onConfirm={() =>
        void go(() =>
          fieldApi.triageIncident(incident.id, {
            expectedVersion: incident.version,
            severity,
            category: category !== incident.category ? category : undefined,
            sensitivity: sensitivity !== incident.sensitivity ? sensitivity : undefined,
            note: note.trim(),
          }),
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: INCIDENT_SEVERITY_LABELS[s] }))} />
        <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value as typeof category)} options={INCIDENT_CATEGORIES.map((c) => ({ value: c, label: INCIDENT_CATEGORY_LABELS[c] }))} />
        <SelectField label="Sensitivity" value={sensitivity} onChange={(e) => setSensitivity(e.target.value as typeof sensitivity)} options={SENSITIVITY_LEVELS.map((s) => ({ value: s, label: SENSITIVITY_LABELS[s] }))} />
      </div>
      <TextArea label="Triage note" value={note} onChange={setNote} max={2000} hint={NEUTRAL_HINT} />
    </Shell>
  );
}

/** Assignee choice: the people allowed to handle this incident (from the API), plus the caller and recent assignees as a fallback. */
function AssigneeSelect({ incidentId, value, onChange, label = 'Assign to', optional = false }: { incidentId: string; value: string; onChange: (id: string) => void; label?: string; optional?: boolean }) {
  const { me, can } = useAuth();
  const eligible = useAsync(() => fieldApi.incidentAssignableUsers(incidentId), [incidentId], can('field.incidents.assign'));
  const recent = useAsync(() => fieldApi.incidents({ view: 'open', pageSize: 100 }), [], !can('field.incidents.assign'));
  const people = assigneeCandidates(me ? { id: me.user.id, displayName: `${me.user.displayName} (me)` } : null, [
    ...(eligible.data ?? []),
    ...(eligible.data ? [] : (recent.data?.items ?? []).map((i) => i.assignee)),
  ]);
  return (
    <SelectField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={optional ? 'No change' : 'Choose a person'}
      options={people.map((p) => ({ value: p.id, label: p.displayName }))}
      hint="The assignee must be active and allowed to triage incidents in this area; the server checks this."
    />
  );
}

function AssignDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const [assigneeId, setAssigneeId] = useState(incident.assignee?.id ?? '');
  const [note, setNote] = useState('');
  const { busy, error, go } = useAction(onDone);
  return (
    <Shell
      title={incident.status === 'RESOLVED' ? 'Send the resolution back' : 'Assign incident'}
      description={incident.status === 'RESOLVED' ? 'The proposed resolution is not accepted; the incident goes back to an assignee.' : undefined}
      busy={busy}
      disabled={!assigneeId}
      confirm="Assign"
      onClose={onClose}
      error={error}
      onConfirm={() => void go(() => fieldApi.assignIncident(incident.id, { expectedVersion: incident.version, assigneeId, note: note.trim() || null }))}
    >
      <AssigneeSelect incidentId={incident.id} value={assigneeId} onChange={setAssigneeId} />
      <TextArea label="Note (optional)" value={note} onChange={setNote} min={0} max={2000} hint={NEUTRAL_HINT} />
    </Shell>
  );
}

function EscalateDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<(typeof INCIDENT_ESCALATION_TARGETS)[number]>('WAR_ROOM_COMMAND');
  const [assigneeId, setAssigneeId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, go } = useAction(onDone);
  return (
    <Shell
      title="Escalate incident"
      description="Escalation notifies War Room command in scope. The War Room coordinates internally and never instructs IEBC officers."
      busy={busy}
      disabled={reason.trim().length < 3}
      confirm="Escalate"
      onClose={onClose}
      error={error}
      onConfirm={() => void go(() => fieldApi.escalateIncident(incident.id, { expectedVersion: incident.version, target, assigneeId: assigneeId || null, reason: reason.trim() }))}
    >
      <SelectField label="Escalate to" value={target} onChange={(e) => setTarget(e.target.value as typeof target)} options={INCIDENT_ESCALATION_TARGETS.map((t) => ({ value: t, label: INCIDENT_ESCALATION_TARGET_LABELS[t] }))} />
      <AssigneeSelect incidentId={incident.id} value={assigneeId} onChange={setAssigneeId} label="Reviewer (optional)" optional />
      <TextArea label="Reason (recorded in the audit log)" value={reason} onChange={setReason} max={2000} />
    </Shell>
  );
}

function ResolveDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<(typeof INCIDENT_OUTCOMES)[number]>('RESOLVED');
  const [note, setNote] = useState('');
  const [dupRef, setDupRef] = useState('');
  const dupSearch = useAsync(() => fieldApi.incidents({ q: dupRef.trim(), pageSize: 10 }), [dupRef], outcome === 'DUPLICATE' && dupRef.trim().length >= 3);
  const duplicateOf = (dupSearch.data?.items ?? []).find((i) => i.reference.toLowerCase() === dupRef.trim().toLowerCase() && i.id !== incident.id) ?? null;
  const { busy, error, go } = useAction(onDone);
  const disabled = note.trim().length < 10 || (outcome === 'DUPLICATE' && !duplicateOf);
  return (
    <Shell
      title="Propose a resolution"
      description="A different authorised reviewer closes the incident. Disputed matters use the outcome “Unresolved”; they never read as resolved."
      busy={busy}
      disabled={disabled}
      confirm="Record resolution"
      onClose={onClose}
      error={error}
      onConfirm={() =>
        void go(() => fieldApi.resolveIncident(incident.id, { expectedVersion: incident.version, outcome, resolutionNote: note.trim(), duplicateOfId: duplicateOf?.id ?? null }))
      }
    >
      <SelectField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} options={INCIDENT_OUTCOMES.map((o) => ({ value: o, label: INCIDENT_OUTCOME_LABELS[o] }))} />
      {outcome === 'DUPLICATE' ? (
        <div>
          <label htmlFor="dup-ref" className="ngao-label">
            Reference of the incident this duplicates
          </label>
          <input id="dup-ref" className="ngao-input" value={dupRef} onChange={(e) => setDupRef(e.target.value)} placeholder="INC-2027-000123" />
          <p className="mt-1 text-meta text-slate">{duplicateOf ? `Found ${duplicateOf.reference}.` : dupRef.trim().length >= 3 ? 'No visible incident with that exact reference.' : 'Enter the full reference.'}</p>
        </div>
      ) : null}
      <TextArea label="Resolution note" value={note} onChange={setNote} min={10} hint={NEUTRAL_HINT} />
    </Shell>
  );
}

function SubjectDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, go } = useAction(onDone);
  return (
    <Shell
      title="Add a restricted subject record"
      description="Only when a referral needs it. Record who or what the report concerns as an allegation reported by a source, never as a finding. Visible only to holders of the restricted-subject permission; every view is audited. You will be asked to confirm your password."
      busy={busy}
      disabled={description.trim().length < 3 || reason.trim().length < 3}
      confirm="Add restricted record"
      onClose={onClose}
      error={error}
      onConfirm={() => void go(() => fieldApi.recordIncidentSubject(incident.id, { description: description.trim(), reason: reason.trim() }))}
    >
      <TextArea label="Subject (as reported, not a finding)" value={description} onChange={setDescription} max={1000} />
      <TextArea label="Reason this is necessary (recorded in the audit log)" value={reason} onChange={setReason} max={2000} />
    </Shell>
  );
}

const TEXT_ACTIONS: Record<Exclude<IncidentDialogKind, 'triage' | 'assign' | 'escalate' | 'resolve' | 'subject'>, { title: string; label: string; confirm: string; min: number; description?: string; danger?: boolean }> = {
  note: { title: 'Add a note', label: 'Note', confirm: 'Add note', min: 3, description: 'Notes are append-only and cannot be edited later.' },
  correction: {
    title: 'Add a correction',
    label: 'What is corrected and why',
    confirm: 'Add correction',
    min: 3,
    description: 'The original report is never edited. The correction is shown beside it and in the timeline.',
  },
  refer: { title: 'Refer to a competent authority', label: 'Referral note', confirm: 'Record referral', min: 3 },
  hold: { title: 'Place an evidence hold', label: 'Reason for the hold', confirm: 'Place hold', min: 3, description: 'Evidence on hold must be preserved and not released.' },
  release: { title: 'Release the evidence hold', label: 'Reason for release', confirm: 'Release hold', min: 3 },
  close: {
    title: 'Close incident',
    label: 'Closure note',
    confirm: 'Close incident',
    min: 10,
    description: 'Closure needs a reviewer other than the reporter and the person who proposed the resolution.',
  },
  reopen: { title: 'Reopen incident', label: 'Reason (recorded in the audit log)', confirm: 'Reopen', min: 3, description: 'The incident returns to triage. Earlier resolution and closure remain in the history.' },
};

function TextActionDialog({ kind, incident, onClose, onDone }: { kind: keyof typeof TEXT_ACTIONS; incident: IncidentDetail; onClose: () => void; onDone: () => void }) {
  const spec = TEXT_ACTIONS[kind];
  const [text, setText] = useState('');
  const [referredTo, setReferredTo] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [station, setStation] = useState('');
  const [place, setPlace] = useState('');
  const { busy, error, go } = useAction(onDone);
  const send = (): Promise<unknown> => {
    const note = text.trim();
    switch (kind) {
      case 'note':
        return fieldApi.addIncidentEvent(incident.id, { type: 'NOTE', note });
      case 'correction': {
        const correction = {
          ...(occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : {}),
          ...(station.trim() ? { pollingStationCode: station.trim() } : {}),
          ...(place.trim() ? { locationDescription: place.trim() } : {}),
        };
        return fieldApi.addIncidentEvent(incident.id, { type: 'CORRECTION', note, ...(Object.keys(correction).length ? { correction } : {}) });
      }
      case 'refer':
        return fieldApi.addIncidentEvent(incident.id, { type: 'REFERRED', note, referredTo: referredTo.trim() || undefined });
      case 'hold':
        return fieldApi.addIncidentEvent(incident.id, { type: 'EVIDENCE_HOLD_PLACED', note });
      case 'release':
        return fieldApi.addIncidentEvent(incident.id, { type: 'EVIDENCE_HOLD_RELEASED', note });
      case 'close':
        return fieldApi.closeIncident(incident.id, { expectedVersion: incident.version, closureNote: note });
      case 'reopen':
        return fieldApi.reopenIncident(incident.id, { expectedVersion: incident.version, reason: note });
    }
  };
  return (
    <Shell
      title={spec.title}
      description={spec.description}
      busy={busy}
      disabled={text.trim().length < spec.min || (kind === 'refer' && referredTo.trim().length < 2)}
      confirm={spec.confirm}
      danger={spec.danger}
      onClose={onClose}
      error={error}
      onConfirm={() => void go(send)}
    >
      {kind === 'refer' ? (
        <div>
          <label htmlFor="referred-to" className="ngao-label">
            Referred to (institution, never a person)
          </label>
          <input id="referred-to" className="ngao-input" value={referredTo} onChange={(e) => setReferredTo(e.target.value)} maxLength={200} />
        </div>
      ) : null}
      {kind === 'correction' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="corr-time" className="ngao-label">
              Corrected time (optional)
            </label>
            <input id="corr-time" type="datetime-local" className="ngao-input" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </div>
          <div>
            <label htmlFor="corr-station" className="ngao-label">
              Corrected station code (optional)
            </label>
            <input id="corr-station" className="ngao-input" value={station} onChange={(e) => setStation(e.target.value)} maxLength={32} />
          </div>
          <div>
            <label htmlFor="corr-place" className="ngao-label">
              Corrected place (optional)
            </label>
            <input id="corr-place" className="ngao-input" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={300} />
          </div>
        </div>
      ) : null}
      <TextArea label={spec.label} value={text} onChange={setText} min={spec.min} max={kind === 'reopen' ? 2000 : 4000} hint={kind === 'reopen' ? undefined : NEUTRAL_HINT} />
    </Shell>
  );
}
