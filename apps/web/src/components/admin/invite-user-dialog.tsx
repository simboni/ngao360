'use client';

import type { CreateUser, Paginated, Role, UserDetail } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { Dialog, Field, Notice, SelectInput, TextInput } from './primitives';
import { useHighRisk } from './reauth';
import { describeError, fieldErrors, useApiQuery } from './use-api';

/**
 * Invite a user (S06). The account starts INVITED unless an initial password is
 * set. An organisation-wide role can be granted at the same time (needs
 * roles.assign); geography-limited grants are made from the user's profile.
 */
export function InviteUserDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (u: UserDetail) => void }) {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const canAssign = can('roles.assign') && can('roles.view');
  const roles = useApiQuery<Role[]>(open && canAssign ? 'invite-roles' : null, async (signal) => (await api.get<Paginated<Role>>('/admin/roles', { query: { pageSize: 200 }, signal })).items);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [setPassword, setSetPassword] = useState(false);
  const [password, setPasswordValue] = useState('');
  const [roleId, setRoleId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setDisplayName('');
    setPhone('');
    setSetPassword(false);
    setPasswordValue('');
    setRoleId('');
    setExpiresAt('');
    setError(null);
  }, [open]);

  const errors = fieldErrors(error);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Partial<CreateUser> & Pick<CreateUser, 'email' | 'displayName'> = {
      email,
      displayName,
      phone: phone || null,
      ...(setPassword && password ? { initialPassword: password } : {}),
      roleAssignments: roleId
        ? [{ roleId, scopeType: 'ORGANISATION', geographicUnitId: null, pollingStationId: null, electionCycleId: null, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }]
        : [],
    };
    try {
      const created = await highRisk(() => api.post<UserDetail>('/admin/users', body));
      onInvited(created);
      onClose();
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Invite a user" description="Only invite people who need access. Every invitation is recorded in the audit log.">
      <form onSubmit={submit} noValidate>
        <Field label="Full name" htmlFor="inv-name" required error={errors.displayName}>
          <TextInput id="inv-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" required minLength={2} />
        </Field>
        <Field label="Email" htmlFor="inv-email" required error={errors.email}>
          <TextInput id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
        </Field>
        <Field label="Phone (optional)" htmlFor="inv-phone" error={errors.phone}>
          <TextInput id="inv-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
        </Field>
        <label className="mb-2 flex items-center gap-2 text-body">
          <input type="checkbox" className="h-4 w-4 accent-teal" checked={setPassword} onChange={(e) => setSetPassword(e.target.checked)} />
          Set an initial password now
        </label>
        {setPassword ? (
          <Field label="Initial password" htmlFor="inv-pass" hint="At least 12 characters with upper and lower case letters and a number. Share it through a separate, secure channel." error={errors.initialPassword}>
            <TextInput id="inv-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPasswordValue(e.target.value)} />
          </Field>
        ) : (
          <p className="mb-4 text-meta text-slate">Without a password the account stays “Invited” and cannot sign in yet.</p>
        )}
        {canAssign ? (
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Field label="Organisation-wide role (optional)" htmlFor="inv-role" hint="For a county, ward or station-limited role, grant it from the user's profile.">
              <SelectInput id="inv-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">No role yet</option>
                {(roles.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Role expires (optional)" htmlFor="inv-exp">
              <TextInput id="inv-exp" type="datetime-local" value={expiresAt} disabled={!roleId} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!email || displayName.trim().length < 2}>
            Send invitation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
