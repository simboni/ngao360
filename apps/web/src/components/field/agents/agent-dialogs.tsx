'use client';

import {
  ACCREDITATION_STATUS_LABELS,
  ACCREDITATION_STATUSES,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TRANSITIONS,
  type AgentDetail,
  RecordTrainingSchema,
  ReasonSchema,
  SetAccreditationSchema,
  TRAINING_STATUS_LABELS,
  TRAINING_STATUSES,
} from '@ngao360/shared';
import { useId, useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { SelectField } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';

function useSubmit() {
  const { run } = useTallyActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await run(fn);
      done();
    } catch (err) {
      setError(describeFieldError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, go };
}

/** Agent status change with a reason (API §16 `POST /field/agents/:id/status`). */
export function AgentStatusDialog({ agent, onClose, onDone }: { agent: AgentDetail; onClose: () => void; onDone: () => void }) {
  const targets = AGENT_STATUS_TRANSITIONS[agent.status];
  const [to, setTo] = useState<string>(targets[0] ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, go } = useSubmit();
  const rid = useId();
  const valid = !!to && ReasonSchema.safeParse(reason.trim()).success;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Change agent status"
      description={`Current status: ${AGENT_STATUS_LABELS[agent.status]}. Withdrawn is final; inactive or withdrawn agents must have no active deployments.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!valid}
            variant={to === 'WITHDRAWN' ? 'danger' : 'primary'}
            onClick={() => void go(() => fieldApi.agentStatus(agent.id, { expectedVersion: agent.version, to: to as never, reason: reason.trim() }), onDone)}
          >
            Change status
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <SelectField label="New status" value={to} onChange={(e) => setTo(e.target.value)} options={targets.map((s) => ({ value: s, label: AGENT_STATUS_LABELS[s] }))} />
        <div>
          <label htmlFor={rid} className="ngao-label">
            Reason (recorded in the audit log)
          </label>
          <textarea id={rid} rows={3} className="ngao-input h-auto py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}

/** Record a training session (API §16 `POST /field/agents/:id/trainings`). */
export function TrainingDialog({ agent, electionCycleId, onClose, onDone }: { agent: AgentDetail; electionCycleId: string | null; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ title: '', status: 'SCHEDULED', scheduledOn: '', materialsIssued: false, assessmentScore: '', notes: '' });
  const { busy, error, setError, go } = useSubmit();
  const ids = { title: useId(), date: useId(), score: useId(), notes: useId() };
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const submit = () => {
    const now = new Date().toISOString();
    const parsed = RecordTrainingSchema.safeParse({
      electionCycleId,
      title: form.title,
      status: form.status,
      scheduledOn: form.scheduledOn || null,
      materialsIssued: form.materialsIssued,
      assessmentScore: form.assessmentScore === '' ? null : Number(form.assessmentScore),
      attendedAt: form.status === 'ATTENDED' || form.status === 'COMPLETED' || form.status === 'NOT_PASSED' ? now : null,
      completedAt: form.status === 'COMPLETED' ? now : null,
      notes: form.notes.trim() || null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    void go(() => fieldApi.recordTraining(agent.id, parsed.data), onDone);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record training"
      description="Materials issued, attendance, assessment and completion (blueprint 6.3)."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={submit}>
            Record training
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={ids.title} className="ngao-label">
            Module or session
          </label>
          <input id={ids.title} className="ngao-input" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Polling-day procedures" />
        </div>
        <SelectField label="Status" value={form.status} onChange={(e) => set({ status: e.target.value })} options={TRAINING_STATUSES.map((s) => ({ value: s, label: TRAINING_STATUS_LABELS[s] }))} />
        <div>
          <label htmlFor={ids.date} className="ngao-label">
            Scheduled on
          </label>
          <input id={ids.date} type="date" className="ngao-input" value={form.scheduledOn} onChange={(e) => set({ scheduledOn: e.target.value })} />
        </div>
        <div>
          <label htmlFor={ids.score} className="ngao-label">
            Assessment score (0–100, optional)
          </label>
          <input id={ids.score} type="number" min={0} max={100} className="ngao-input" value={form.assessmentScore} onChange={(e) => set({ assessmentScore: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-body text-ink">
          <input type="checkbox" className="h-4 w-4" checked={form.materialsIssued} onChange={(e) => set({ materialsIssued: e.target.checked })} />
          Training materials issued
        </label>
        <div className="sm:col-span-2">
          <label htmlFor={ids.notes} className="ngao-label">
            Notes (optional)
          </label>
          <textarea id={ids.notes} rows={2} className="ngao-input h-auto py-2" value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} />
        </div>
        {error ? (
          <Notice tone="error" className="sm:col-span-2">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Record the accreditation status for the field cycle (API §16 `PUT /field/agents/:id/accreditation`). */
export function AccreditationDialog({ agent, electionCycleId, onClose, onDone }: { agent: AgentDetail; electionCycleId: string; onClose: () => void; onDone: () => void }) {
  const current = agent.accreditations.find((a) => a.electionCycleId === electionCycleId);
  const [form, setForm] = useState({ status: current?.status ?? 'SUBMITTED', reference: current?.accreditationReference ?? '', expiresOn: current?.expiresOn ?? '', notes: '', reason: '' });
  const { busy, error, setError, go } = useSubmit();
  const ids = { ref: useId(), exp: useId(), notes: useId(), reason: useId() };
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const submit = () => {
    const now = new Date().toISOString();
    const parsed = SetAccreditationSchema.safeParse({
      electionCycleId,
      status: form.status,
      accreditationReference: form.reference.trim() || null,
      submittedAt: current?.submittedAt ?? (form.status === 'NOT_SUBMITTED' ? null : now),
      decidedAt: form.status === 'APPROVED' || form.status === 'REJECTED' ? (current?.decidedAt ?? now) : null,
      expiresOn: form.expiresOn || null,
      notes: form.notes.trim() || null,
      reason: form.reason.trim(),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    void go(() => fieldApi.setAccreditation(agent.id, parsed.data), onDone);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record accreditation status"
      description="NGAO360 records the status reported by the accrediting body. It never grants accreditation or polling-station access."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={submit}>
            Save status
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Status" value={form.status} onChange={(e) => set({ status: e.target.value as typeof form.status })} options={ACCREDITATION_STATUSES.map((s) => ({ value: s, label: ACCREDITATION_STATUS_LABELS[s] }))} />
        <div>
          <label htmlFor={ids.ref} className="ngao-label">
            Accreditation reference (optional)
          </label>
          <input id={ids.ref} className="ngao-input" value={form.reference} onChange={(e) => set({ reference: e.target.value })} />
        </div>
        <div>
          <label htmlFor={ids.exp} className="ngao-label">
            Expires on (optional)
          </label>
          <input id={ids.exp} type="date" className="ngao-input" value={form.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={ids.notes} className="ngao-label">
            Notes (optional)
          </label>
          <textarea id={ids.notes} rows={2} className="ngao-input h-auto py-2" value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={ids.reason} className="ngao-label">
            Reason (recorded in the audit log)
          </label>
          <textarea id={ids.reason} rows={2} className="ngao-input h-auto py-2" value={form.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={2000} />
        </div>
        <p className="text-meta text-slate sm:col-span-2">Accreditation letters may be attached as evidence; never attach a copy of an ID card.</p>
        {error ? (
          <Notice tone="error" className="sm:col-span-2">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}
