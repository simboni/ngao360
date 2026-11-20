'use client';

import { type AgentSummary, DEPLOYMENT_ROLE_LABELS, DEPLOYMENT_SHIFT_LABELS, DEPLOYMENT_STATUS_LABELS, type DeploymentDetail } from '@ngao360/shared';
import { Ban, MapPin, Replace } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useTallyActions } from '@/components/tally/action-provider';
import { Dialog } from '@/components/tally/dialog';
import { MetaRow } from '@/components/tally/fields';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { DeploymentStatusBadge } from '../common/field-badges';
import { fieldApi } from '../common/field-api';
import { describeFieldError } from '../common/field-errors';
import { conflictsFromError, serverStateFromError, stationLabel } from '../common/field-model';
import { AgentPicker } from './agent-picker';
import { ConflictList } from './conflict-list';

/**
 * Deployment detail drawer (API §17 `GET /field/deployments/:id`): slot,
 * status, append-only events, non-blocking warnings, and the planner actions
 * replace and cancel. Replacing keeps the original row (REPLACED) linked to
 * its successor; nothing is deleted.
 */
export function DeploymentDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { run, askReason } = useTallyActions();
  const d = useAsync(() => fieldApi.deployment(id), [id]);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<DeploymentDetail | null>(null);
  const dep = d.data;

  const cancel = async () => {
    if (!dep) return;
    const reason = await askReason({
      title: 'Cancel this assignment',
      description: 'The station shows as not assigned again for this slot. The assignment stays in the history.',
      confirmLabel: 'Cancel assignment',
      danger: true,
    });
    if (!reason) return;
    setError(null);
    try {
      await run(() => fieldApi.cancelDeployment(dep.id, { expectedVersion: dep.version, reason }));
      onChanged();
      void d.reload();
    } catch (err) {
      setStale(serverStateFromError<DeploymentDetail>(err));
      setError(describeFieldError(err));
    }
  };

  return (
    <Dialog open onClose={onClose} variant="drawer" title={dep ? `${DEPLOYMENT_ROLE_LABELS[dep.role]} · ${dep.location.station?.code ?? ''}` : 'Assignment'} description={dep ? stationLabel(dep.location) : undefined}>
      {d.error ? <Notice tone="error">{describeFieldError(d.error)}</Notice> : null}
      {!dep ? (
        <p className="text-meta text-slate">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <DeploymentStatusBadge status={dep.status} />
            {dep.location.station && !dep.location.station.inApprovedRegistry ? (
              <span className="text-meta text-error">Station code no longer in the approved registry</span>
            ) : null}
          </div>
          <dl>
            <MetaRow label="Agent">
              <Link href={`/field/agents/${dep.agent.id}`} className="text-teal hover:underline">
                {dep.agent.displayName}
              </Link>{' '}
              <span className="text-meta text-slate">{dep.agent.reference}</span>
            </MetaRow>
            <MetaRow label="Shift">{DEPLOYMENT_SHIFT_LABELS[dep.shift]}</MetaRow>
            <MetaRow label="Supervisor">{dep.supervisor?.displayName ?? 'None'}</MetaRow>
            <MetaRow label="Confirmed">{formatDateTime(dep.confirmedAt)}</MetaRow>
            <MetaRow label="Checked in">{formatDateTime(dep.checkedInAt)}</MetaRow>
            <MetaRow label="Checked out">{formatDateTime(dep.checkedOutAt)}</MetaRow>
            <MetaRow label="Check-in location">
              {dep.checkInLocation ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" aria-hidden /> Recorded once with the check-in ({dep.checkInLocation.latitude.toFixed(4)}, {dep.checkInLocation.longitude.toFixed(4)})
                </span>
              ) : (
                'Not recorded'
              )}
            </MetaRow>
            {dep.instructions ? <MetaRow label="Instructions">{dep.instructions}</MetaRow> : null}
            {dep.cancelledReason ? <MetaRow label="Cancelled because">{dep.cancelledReason}</MetaRow> : null}
            {dep.replacesDeploymentId ? <MetaRow label="Replaces">An earlier assignment on this slot</MetaRow> : null}
            {dep.replacedByDeploymentId ? <MetaRow label="Replaced by">A successor assignment on this slot</MetaRow> : null}
          </dl>

          {dep.warnings.length ? <ConflictList conflicts={dep.warnings} title="Warnings" /> : null}
          {error ? (
            <Notice tone="error" title="Not changed">
              {error}
              {stale ? <span className="block">Current status: {DEPLOYMENT_STATUS_LABELS[stale.status]} (version {stale.version}).</span> : null}
            </Notice>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {dep.allowedActions.includes('replace') ? (
              <Button variant="secondary" onClick={() => setReplacing(true)}>
                <Replace className="h-4 w-4" aria-hidden /> Replace agent
              </Button>
            ) : null}
            {dep.allowedActions.includes('cancel') ? (
              <Button variant="secondary" onClick={() => void cancel()}>
                <Ban className="h-4 w-4" aria-hidden /> Cancel assignment
              </Button>
            ) : null}
          </div>

          <section aria-labelledby="dep-events">
            <h3 id="dep-events" className="mb-2 text-card font-semibold text-ink">
              History
            </h3>
            <ol className="space-y-2 border-l-2 border-line pl-4">
              {dep.events.map((e) => (
                <li key={e.id}>
                  <p className="text-body text-ink">
                    {e.type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}
                    {e.toStatus ? ` → ${DEPLOYMENT_STATUS_LABELS[e.toStatus]}` : ''}
                  </p>
                  <p className="text-meta text-slate">
                    {formatDateTime(e.createdAt)} · {e.actor.displayName}
                    {e.submittedOffline ? ' · sent from the offline queue' : ''}
                    {e.hasLocation ? ' · location attached' : ''}
                    {e.note ? ` · ${e.note}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
      {replacing && dep ? (
        <ReplaceDialog
          deployment={dep}
          onClose={() => setReplacing(false)}
          onDone={() => {
            setReplacing(false);
            onChanged();
            void d.reload();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function ReplaceDialog({ deployment, onClose, onDone }: { deployment: DeploymentDetail; onClose: () => void; onDone: () => void }) {
  const { run } = useTallyActions();
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = !!agent && reason.trim().length >= 3;
  const submit = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await run(() => fieldApi.replaceDeployment(deployment.id, { expectedVersion: deployment.version, successorAgentId: agent.id, reason: reason.trim() }));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const conflicts = conflictsFromError(error);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Replace agent on this slot"
      description={`${deployment.agent.displayName} is recorded as replaced; the successor takes the same station, role and shift.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
            Replace
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <AgentPicker selected={agent ? [agent] : []} onToggle={(a) => setAgent((cur) => (cur?.id === a.id ? null : a))} single wardId={deployment.location.ward?.id} />
        <div>
          <label htmlFor="replace-reason" className="ngao-label">
            Reason (recorded in the audit log)
          </label>
          <textarea id="replace-reason" rows={2} className="ngao-input h-auto py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </div>
        {conflicts.length ? <ConflictList conflicts={conflicts} title="The server refused the replacement" /> : null}
        {error && !conflicts.length ? <Notice tone="error">{describeFieldError(error)}</Notice> : null}
      </div>
    </Dialog>
  );
}
