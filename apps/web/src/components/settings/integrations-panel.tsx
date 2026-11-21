'use client';

/**
 * Integration status (S30): which provider the organisation selected, whether this server is
 * configured for it (environment variable NAMES only; secrets are never shown or entered here),
 * whether it is available, recent delivery / scan activity (counts only) and background job runs.
 * Choosing a provider needs re-auth; a provider the server is not configured for cannot be
 * switched on.
 */
import {
  INTEGRATION_PROVIDERS,
  type IntegrationActivity,
  type IntegrationKind,
  type IntegrationStatus,
} from '@ngao360/shared';
import { CircleCheck, CircleDashed, CircleOff, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField } from '@/components/office/correspondence/office-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { activityLine, describeWorkspaceError, INTEGRATION_KIND_LABELS, providerLabel } from '@/components/workspace/workspace-model';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { SettingsSection } from './settings-section';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

function availability(i: IntegrationStatus) {
  if (i.available) return { label: 'Available', tone: 'success' as const, icon: CircleCheck };
  if (i.enabled && !i.configured) return { label: 'Not configured on this server', tone: 'danger' as const, icon: CircleOff };
  if (i.provider === INTEGRATION_PROVIDERS[i.kind][0]) return { label: 'Not in use', tone: 'muted' as const, icon: CircleDashed };
  return { label: i.enabled ? 'Unavailable' : 'Selected, switched off', tone: 'pending' as const, icon: CircleDashed };
}

export function IntegrationsPanel() {
  const { can } = useAuth();
  const canConfigure = can('workspace.configure');
  const list = useAsync(() => workspaceApi.integrations(), []);
  const activity = useAsync(() => workspaceApi.integrationActivity().catch(() => ({ activity: [] as IntegrationActivity[] })), []);
  const jobs = useAsync(() => workspaceApi.jobs().catch(() => null), []);
  const [editing, setEditing] = useState<IntegrationStatus | null>(null);

  return (
    <SettingsSection
      id="integrations"
      title="Integrations"
      description="Secrets (SMTP password, SMS API key, VAPID key, captcha secret) live only in the server environment. This page shows provider names, whether the server is configured and the names of missing settings, never a value."
    >
      {list.error ? <Notice tone="error">{describeWorkspaceError(list.error)}</Notice> : null}
      <ul className="divide-y divide-line">
        {(list.data?.integrations ?? []).map((i) => {
          const a = availability(i);
          const act = activity.data?.activity.find((x) => x.kind === i.kind);
          return (
            <li key={i.kind} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{INTEGRATION_KIND_LABELS[i.kind]}</span>
                  <span className="text-body text-slate">{providerLabel(i.provider)}</span>
                  <StatusBadge kind="custom" status={a.label} label={a.label} tone={a.tone} icon={a.icon} size="sm" />
                </div>
                {i.missingEnv.length ? <p className="text-meta text-error">Missing server settings: {i.missingEnv.join(', ')}</p> : null}
                {act ? (
                  <p className="text-meta text-slate">
                    {act.lastAt ? `Last ${i.kind === 'scanner' ? 'scan' : 'message'} ${formatDateTime(act.lastAt)} (${(act.lastStatus ?? '').toLowerCase()}) · ` : ''}
                    {i.kind === 'captcha' ? 'Captcha checks are not logged.' : activityLine(act.last7Days)}
                  </p>
                ) : null}
                {i.updatedAt ? <p className="text-meta text-slate">Changed by {i.updatedBy?.displayName ?? 'an administrator'} · {formatDateTime(i.updatedAt)}</p> : null}
              </div>
              {canConfigure ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(i)}>
                  <Settings2 className="h-4 w-4" aria-hidden />
                  Change
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <h3 className="mb-2 mt-4 text-body font-semibold text-ink">Background jobs</h3>
      {jobs.data ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {jobs.data.jobs.map((j) => (
            <li key={j.jobKey} className="rounded-lg border border-line px-3 py-2 text-meta">
              <span className="font-mono text-ink">{j.jobKey}</span>
              <span className="block text-slate">
                {j.scheduled ? `Every ${j.everyMinutes ?? '?'} min` : 'Not scheduled on this server'}
                {j.lastRun ? ` · last run ${formatDateTime(j.lastRun.startedAt)}: ${j.lastRun.status.toLowerCase()}` : ' · no run recorded'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-slate">Job status is not available.</p>
      )}

      {editing ? <IntegrationDialog current={editing} onClose={() => setEditing(null)} onSaved={() => void list.reload()} /> : null}
    </SettingsSection>
  );
}

const CONFIG_FIELDS: Record<IntegrationKind, Array<{ key: string; label: string; hint: string }>> = {
  email: [
    { key: 'fromAddress', label: 'From address', hint: 'Shown to recipients; the SMTP account itself is set on the server.' },
    { key: 'fromName', label: 'From name', hint: 'e.g. “NGAO360 – Synthetic Campaign”.' },
  ],
  sms: [{ key: 'senderId', label: 'Sender ID', hint: '3–11 letters or digits, as registered with the provider.' }],
  push: [],
  captcha: [{ key: 'siteKey', label: 'Site key (public)', hint: 'The public key shown in the page. The secret stays on the server.' }],
  scanner: [],
};

function IntegrationDialog({ current, onClose, onSaved }: { current: IntegrationStatus; onClose: () => void; onSaved: () => void }) {
  const highRisk = useHighRisk();
  const [provider, setProvider] = useState(current.provider);
  const [enabled, setEnabled] = useState(current.enabled);
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(current.config).map(([k, v]) => [k, typeof v === 'string' ? v : ''])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = current.kind;
  const isDefault = provider === INTEGRATION_PROVIDERS[kind][0];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const cleaned = isDefault ? {} : Object.fromEntries(Object.entries(config).filter(([k, v]) => v.trim() && CONFIG_FIELDS[kind].some((f) => f.key === k)).map(([k, v]) => [k, v.trim()]));
    try {
      await highRisk(() => workspaceApi.updateIntegration(kind, { provider, enabled: isDefault ? true : enabled, config: cleaned }));
      onSaved();
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={INTEGRATION_KIND_LABELS[kind]} description="Select the provider this organisation uses. The server operator configures the provider's credentials in the environment.">
      <form onSubmit={submit}>
        <FormField id="int-provider" label="Provider" required>
          <select id="int-provider" className="ngao-input pr-8" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {INTEGRATION_PROVIDERS[kind].map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </FormField>
        {!isDefault ? (
          <>
            {CONFIG_FIELDS[kind].map((f) => (
              <FormField key={f.key} id={`int-${f.key}`} label={f.label} hint={f.hint}>
                <input id={`int-${f.key}`} className="ngao-input" value={config[f.key] ?? ''} autoComplete="off" onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} />
              </FormField>
            ))}
            <label className="mb-4 flex items-center gap-2 text-body text-ink">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Switch it on for this organisation
            </label>
            {kind === 'captcha' ? (
              <Notice tone="info" className="mb-4">
                With captcha switched on, a public submission is refused whenever the provider cannot confirm it (including when the provider is unreachable).
              </Notice>
            ) : null}
          </>
        ) : (
          <p className="mb-4 text-body text-slate">
            {kind === 'scanner'
              ? 'Without a scanner, uploaded files stay “pending” and cannot be published or used where a clean scan is required.'
              : kind === 'captcha'
                ? 'The public portal relies on the honeypot and rate limits only.'
                : 'Messages are recorded as skipped; nothing leaves the server.'}
          </p>
        )}
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Confirm and save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
