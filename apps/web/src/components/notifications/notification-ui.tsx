'use client';

import { NOTIFICATION_ACK_ACTIONS, NOTIFICATION_SEVERITY_LABELS, type NotificationAckAction, type NotificationCenterItem, type NotificationSeverity } from '@ngao360/shared';
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { formatDateTime } from '@/lib/format';
import { notificationsApi } from './notifications-api';

const SEVERITY: Record<NotificationSeverity, { tone: Tone; icon: typeof Info }> = {
  INFO: { tone: 'info', icon: Info },
  WARNING: { tone: 'pending', icon: AlertTriangle },
  CRITICAL: { tone: 'danger', icon: AlertOctagon },
};

export function SeverityBadge({ severity, size = 'sm' }: { severity: NotificationSeverity; size?: 'sm' | 'md' }) {
  const s = SEVERITY[severity];
  return <StatusBadge kind="custom" status={severity} label={NOTIFICATION_SEVERITY_LABELS[severity]} tone={s.tone} icon={s.icon} size={size} />;
}

export const ACK_ACTION_LABELS: Record<NotificationAckAction, string> = {
  ACKNOWLEDGED: 'Acknowledge',
  ESCALATED: 'Escalate',
  CLOSED: 'Close',
};

export const ACK_ACTION_PAST: Record<NotificationAckAction, string> = {
  ACKNOWLEDGED: 'Acknowledged',
  ESCALATED: 'Escalated',
  CLOSED: 'Closed',
};

/**
 * Critical-alert acknowledgement (blueprint 10.3): acknowledge, escalate or
 * close with a note; each step is appended to the acknowledgement record.
 */
export function AcknowledgeDialog({ item, onClose, onDone }: { item: NotificationCenterItem; onClose: () => void; onDone: (n: NotificationCenterItem) => void }) {
  const [action, setAction] = useState<NotificationAckAction>('ACKNOWLEDGED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useAsync(() => notificationsApi.acknowledgements(item.id), [item.id]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await notificationsApi.acknowledge(item.id, { action, ...(note.trim() ? { note: note.trim() } : {}) }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Critical alert" description="Your acknowledgement, escalation or closure is recorded with the time and your note.">
      <div className="mb-4 flex items-center gap-2">
        <SeverityBadge severity={item.severity} />
        <span className="font-semibold text-ink">{item.title}</span>
      </div>
      <p className="mb-4 text-body text-ink">{item.body}</p>
      {history.data && history.data.length ? (
        <div className="mb-4">
          <h3 className="mb-1 text-meta font-semibold uppercase tracking-wide text-slate">Record so far</h3>
          <ol className="space-y-1 text-body">
            {history.data.map((h) => (
              <li key={h.id}>
                <span className="font-medium">{ACK_ACTION_PAST[h.action]}</span> by {h.user.displayName} · {formatDateTime(h.createdAt)}
                {h.note ? <span className="text-slate"> — {h.note}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <form onSubmit={submit}>
        <fieldset className="mb-4">
          <legend className="ngao-label">Action</legend>
          <div className="flex flex-wrap gap-4">
            {NOTIFICATION_ACK_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-body">
                <input type="radio" name="ack-action" checked={action === a} onChange={() => setAction(a)} />
                {ACK_ACTION_LABELS[a]}
              </label>
            ))}
          </div>
          {action === 'ESCALATED' ? <p className="mt-1 text-meta text-slate">Escalation goes to people who manage security breaches.</p> : null}
        </fieldset>
        <FormField id="ack-note" label="Note" hint={action === 'ACKNOWLEDGED' ? undefined : 'Say what you did or why you escalate.'}>
          <textarea id="ack-note" className={textareaClass} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Later
          </Button>
          <Button type="submit" loading={busy} disabled={action !== 'ACKNOWLEDGED' && note.trim().length < 3}>
            {ACK_ACTION_LABELS[action]}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
