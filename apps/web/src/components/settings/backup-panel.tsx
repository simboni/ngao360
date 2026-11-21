'use client';

/**
 * Backup status (S30): record that a restore of a backup was tested (date, which backup, outcome,
 * note). The onboarding step counts a successful test from the last 90 days. NGAO360 does not
 * take or hold backups itself; the operator's database backups are restored elsewhere and the
 * result recorded here.
 */
import { type RecordBackupVerification } from '@ngao360/shared';
import { DatabaseBackup } from 'lucide-react';
import { useState } from 'react';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { describeWorkspaceError } from '@/components/workspace/workspace-model';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { SettingsSection } from './settings-section';

const OUTCOME_LABELS: Record<RecordBackupVerification['outcome'], string> = {
  RESTORED_OK: 'Restored and checked',
  RESTORED_WITH_ISSUES: 'Restored with issues',
  FAILED: 'Restore failed',
};

export function BackupPanel() {
  const { can } = useAuth();
  const data = useAsync(() => workspaceApi.backup(), []);
  const [recording, setRecording] = useState(false);
  const b = data.data;
  return (
    <SettingsSection
      id="backup"
      title="Backup restore test"
      description="A backup only counts once a restore has been tested. Record each test here."
      actions={
        can('workspace.configure') ? (
          <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
            <DatabaseBackup className="h-4 w-4" aria-hidden />
            Record a test
          </Button>
        ) : null
      }
    >
      {data.error ? <Notice tone="error">{describeWorkspaceError(data.error)}</Notice> : null}
      {b ? (
        b.last ? (
          <Notice tone={b.current ? 'success' : 'warning'} title={b.current ? 'Restore verified' : `No successful restore test in the last ${b.maxAgeDays} days`}>
            Last test {b.last.testedOn}: {OUTCOME_LABELS[b.last.outcome]} · {b.last.backupReference}
            <span className="block text-meta text-slate">
              Recorded by {b.last.recordedBy?.displayName ?? 'an administrator'} · {formatDateTime(b.last.recordedAt)} · {b.last.note}
            </span>
          </Notice>
        ) : (
          <Notice tone="warning" title="No restore test recorded">
            Restore the latest backup into a separate environment, check it, then record the result.
          </Notice>
        )
      ) : null}
      {recording ? <RecordDialog onClose={() => setRecording(false)} onSaved={(s) => data.setData(s)} /> : null}
    </SettingsSection>
  );
}

function RecordDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: Awaited<ReturnType<typeof workspaceApi.backup>>) => void }) {
  const [f, setF] = useState<RecordBackupVerification>({ testedOn: new Date().toISOString().slice(0, 10), backupReference: '', outcome: 'RESTORED_OK', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await workspaceApi.recordBackup({ ...f, backupReference: f.backupReference.trim(), note: f.note.trim() }));
      onClose();
    } catch (err) {
      setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Record a restore test" description="No credentials or connection strings: say which backup was restored, where, and what was checked.">
      <form onSubmit={submit}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="bk-date" label="Tested on" required>
            <input id="bk-date" type="date" className="ngao-input" value={f.testedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, testedOn: e.target.value })} />
          </FormField>
          <FormField id="bk-outcome" label="Outcome" required>
            <select id="bk-outcome" className="ngao-input pr-8" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value as RecordBackupVerification['outcome'] })}>
              {Object.entries(OUTCOME_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField id="bk-ref" label="Backup restored" required hint="e.g. “nightly database dump of 20 Nov restored to the staging server”.">
          <input id="bk-ref" className="ngao-input" value={f.backupReference} maxLength={200} onChange={(e) => setF({ ...f, backupReference: e.target.value })} />
        </FormField>
        <FormField id="bk-note" label="What was checked" required>
          <textarea id="bk-note" className={textareaClass} value={f.note} maxLength={2000} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={f.backupReference.trim().length < 3 || f.note.trim().length < 3}>
            Record
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
