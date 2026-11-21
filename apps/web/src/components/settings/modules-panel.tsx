'use client';

/**
 * Module activation (API §8, existing endpoint). Switching a module needs a reason and a recent
 * confirmation (re-auth) and is audited; data is never deleted when a module is switched off.
 */
import type { TenantModuleState } from '@ngao360/shared';
import { Power, PowerOff } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { describeWorkspaceError } from '@/components/workspace/workspace-model';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { SettingsSection } from './settings-section';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

export function ModulesPanel() {
  const { can, reload } = useAuth();
  const canConfigure = can('workspace.configure');
  const modules = useAsync(() => workspaceApi.modules(), []);
  const [toggling, setToggling] = useState<TenantModuleState | null>(null);

  return (
    <SettingsSection id="modules" title="Modules" description="Switch modules on or off for the whole organisation. Switching off hides screens and refuses requests; no data is deleted.">
      {modules.error ? <Notice tone="error">{describeWorkspaceError(modules.error)}</Notice> : null}
      <ul className="divide-y divide-line">
        {(modules.data ?? []).map((m) => (
          <li key={m.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{m.label}</span>
                <StatusBadge kind="custom" status={m.enabled ? 'ON' : 'OFF'} label={m.enabled ? 'On' : 'Off'} tone={m.enabled ? 'success' : 'muted'} icon={m.enabled ? Power : PowerOff} size="sm" />
              </div>
              <p className="text-meta text-slate">{m.description}</p>
              {m.updatedAt ? <p className="text-meta text-slate">Changed by {m.updatedBy?.displayName ?? 'an administrator'} · {formatDateTime(m.updatedAt)}</p> : null}
            </div>
            {canConfigure ? (
              <Button size="sm" variant={m.enabled ? 'secondary' : 'primary'} onClick={() => setToggling(m)}>
                {m.enabled ? 'Switch off' : 'Switch on'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {toggling ? (
        <ToggleDialog
          module={toggling}
          onClose={() => setToggling(null)}
          onSaved={(list) => {
            modules.setData(list);
            void reload();
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function ToggleDialog({ module: m, onClose, onSaved }: { module: TenantModuleState; onClose: () => void; onSaved: (list: TenantModuleState[]) => void }) {
  const highRisk = useHighRisk();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await highRisk(() => workspaceApi.setModule(m.key, !m.enabled, reason.trim())));
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`${m.enabled ? 'Switch off' : 'Switch on'} ${m.label}`}
      description={m.enabled ? 'Its screens disappear and its requests are refused until it is switched on again. Nothing is deleted.' : 'Its screens appear for people whose roles include them.'}
    >
      <form onSubmit={submit}>
        <FormField id="mod-reason" label="Reason" required hint="Recorded in the audit log.">
          <textarea id="mod-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={reason.trim().length < 3} variant={m.enabled ? 'danger' : 'primary'}>
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
