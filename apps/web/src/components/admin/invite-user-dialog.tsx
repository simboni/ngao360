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
 * Invite a user (S06). The account starts INVITED. Administrators never choose
 * another person's password (blueprint 3.2): the API returns a single-use
 * invitation link once, which the administrator relays through a separate
 * channel, and the invited person sets their own password. An
 * organisation-wide role can be granted at the same time (needs roles.assign);
 * geography-limited grants are made from the user's profile.
 */
export function InviteUserDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (u: UserDetail) => void }) {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const canAssign = can('roles.assign') && can('roles.view');
  const roles = useApiQuery<Role[]>(open && canAssign ? 'invite-roles' : null, async (signal) => (await api.get<Paginated<Role>>('/admin/roles', { query: { pageSize: 200 }, signal })).items);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [created, setCreated] = useState<UserDetail | null>(null);
  const [roleId, setRoleId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setDisplayName('');
    setPhone('');
    setCreated(null);
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
      roleAssignments: roleId
        ? [{ roleId, scopeType: 'ORGANISATION', geographicUnitId: null, pollingStationId: null, electionCycleId: null, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }]
        : [],
    };
    try {
      const user = await highRisk(() => api.post<UserDetail>('/admin/users', body));
      onInvited(user);
      setCreated(user);
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const link = created.invitation && typeof window !== 'undefined' ? `${window.location.origin}${created.invitation.acceptPath}` : null;
    return (
      <Dialog open={open} onClose={onClose} title="Invitation created" description="This link is shown only once. Send it to the person through a separate, secure channel.">
        {link ? (
          <Field label={`Invitation link for ${created.displayName}`} htmlFor="inv-link" hint={`Single use. Expires ${new Date(created.invitation!.expiresAt).toLocaleString()}.`}>
            <TextInput id="inv-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </Field>
        ) : (
          <Notice tone="warning" className="mb-4">No invitation link was returned. Issue a new invitation from the user's profile.</Notice>
        )}
        <div className="flex justify-end gap-2">
          {link ? (
            <Button type="button" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link)}>
              Copy link
            </Button>
          ) : null}
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </Dialog>
    );
  }

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
        <p className="mb-4 text-meta text-slate">
          The account stays “Invited” until the person opens their single-use invitation link and sets their own password.
        </p>
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
            Create invitation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
