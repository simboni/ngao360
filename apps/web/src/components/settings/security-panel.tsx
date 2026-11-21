'use client';

/**
 * Security settings (S30): MFA policy and session lengths (the organisation can only tighten the
 * server limits), plus counts: people who must use MFA but have no authenticator or passkey,
 * passkeys, administrators without recovery codes, open account recoveries, how invitations are
 * delivered and where rate-limit counters live. Counts only; nobody is named.
 */
import { MFA_POLICIES, type MfaPolicy } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { describeWorkspaceError } from '@/components/workspace/workspace-model';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { SettingsSection } from './settings-section';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';
const MFA_LABELS: Record<MfaPolicy, string> = {
  PRIVILEGED_ROLES: 'Roles that require it (results, finance, administration and other sensitive roles)',
  ALL_USERS: 'Everyone in the organisation',
};

export function SecurityPanel() {
  const { can } = useAuth();
  const canConfigure = can('workspace.configure');
  const highRisk = useHighRisk();
  const data = useAsync(() => workspaceApi.security(), []);
  const [mfaPolicy, setMfaPolicy] = useState<MfaPolicy>('PRIVILEGED_ROLES');
  const [sessionHours, setSessionHours] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data.data) return;
    setMfaPolicy(data.data.policy.mfaPolicy);
    setSessionHours(data.data.policy.sessionMaxHours ? String(data.data.policy.sessionMaxHours) : '');
    setIdleMinutes(data.data.policy.idleTimeoutMinutes ? String(data.data.policy.idleTimeoutMinutes) : '');
  }, [data.data]);

  const s = data.data;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      data.setData(
        await highRisk(() =>
          workspaceApi.updateSecurity({
            mfaPolicy,
            sessionMaxHours: sessionHours ? Number(sessionHours) : null,
            idleTimeoutMinutes: idleMinutes ? Number(idleMinutes) : null,
            reason: reason.trim(),
          }),
        ),
      );
      setReason('');
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="security" title="Security" description="Second factor and session rules for this organisation, and the state of accounts. Counts only.">
      {data.error ? <Notice tone="error">{describeWorkspaceError(data.error)}</Notice> : null}
      {s ? (
        <>
          <dl className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Must use MFA but have no authenticator or passkey" value={s.usersWithoutMfa} warn={s.usersWithoutMfa > 0} />
            <Stat label="Administrators without recovery codes" value={s.administratorsWithoutRecoveryCodes} warn={s.administratorsWithoutRecoveryCodes > 0} />
            <Stat label="Passkeys registered" value={s.passkeysRegistered} />
            <Stat label="Account recoveries open" value={s.pendingAccountRecoveries} />
            <Stat label="Invitations" text={s.invitationDelivery === 'OUTBOX' ? 'Sent by e-mail to the person' : 'Link shown once to the inviting administrator'} />
            <Stat label="Rate-limit counters" text={s.rateLimitStore === 'redis' ? 'Shared (Redis)' : 'Per server (memory)'} />
          </dl>
          <p className="mb-4 text-meta text-slate">Roles that always require MFA: {s.mfaRequiredRoleKeys.join(', ') || 'none'}.</p>

          {!s.policyEnforcedAtSignIn ? (
            <Notice tone="warning" className="mb-4" title="Recorded, not yet applied at sign-in">
              Sign-in still applies the server rules (MFA for roles that require it, sessions up to {s.serverSessionMaxHours} hours). The organisation policy below is
              stored and audited; applying it at sign-in is pending.
            </Notice>
          ) : null}

          <form onSubmit={submit} noValidate>
            <FormField id="sec-mfa" label="Who must use a second factor" required>
              <select id="sec-mfa" className="ngao-input pr-8" value={mfaPolicy} disabled={!canConfigure} onChange={(e) => setMfaPolicy(e.target.value as MfaPolicy)}>
                {MFA_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {MFA_LABELS[p]}
                  </option>
                ))}
              </select>
            </FormField>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField id="sec-session" label="Longest sign-in (hours)" hint={`Empty = server limit (${s.serverSessionMaxHours} h). Access tokens last ${s.accessTokenMinutes} minutes.`}>
                <input id="sec-session" type="number" min={1} max={s.serverSessionMaxHours} className="ngao-input w-32 tabular-nums" value={sessionHours} disabled={!canConfigure} onChange={(e) => setSessionHours(e.target.value)} />
              </FormField>
              <FormField id="sec-idle" label="Sign out after inactivity (minutes)" hint="Empty = only the sign-in limit applies.">
                <input id="sec-idle" type="number" min={5} max={1440} className="ngao-input w-32 tabular-nums" value={idleMinutes} disabled={!canConfigure} onChange={(e) => setIdleMinutes(e.target.value)} />
              </FormField>
            </div>
            {canConfigure ? (
              <FormField id="sec-reason" label="Reason" required hint="Recorded in the audit log.">
                <textarea id="sec-reason" className={textareaClass} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
              </FormField>
            ) : null}
            {s.updatedAt ? <p className="mb-3 text-meta text-slate">Last changed by {s.updatedBy?.displayName ?? 'an administrator'} · {formatDateTime(s.updatedAt)}</p> : null}
            {error ? <Notice tone="error" className="mb-3">{error}</Notice> : null}
            {canConfigure ? (
              <div className="flex justify-end">
                <Button type="submit" loading={busy} disabled={reason.trim().length < 3}>
                  Confirm and save
                </Button>
              </div>
            ) : null}
          </form>
        </>
      ) : null}
    </SettingsSection>
  );
}

function Stat({ label, value, text, warn }: { label: string; value?: number; text?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <dt className="text-meta text-slate">{label}</dt>
      <dd className={warn ? 'text-section font-semibold tabular-nums text-error' : 'text-section font-semibold tabular-nums text-ink'}>{text ?? value}</dd>
    </div>
  );
}
