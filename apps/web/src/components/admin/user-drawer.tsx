'use client';

import type { OkResponse, RoleAssignment, UserDetail, UserStatusChange } from '@ngao360/shared';
import type { UserSession } from '@ngao360/shared/dist/admin';
import { KeyRound, PauseCircle, PlayCircle, Plus, ShieldOff, UserX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { GrantRoleDialog, scopeLabel } from './grant-role-dialog';
import { Chip, Drawer, Facts, Field, Notice, Tabs, TextInput } from './primitives';
import { ReasonDialog, useHighRisk } from './reauth';
import { describeError, useApiQuery } from './use-api';

type Pending =
  | { kind: 'status'; status: UserStatusChange['status'] }
  | { kind: 'mfa' }
  | { kind: 'sessions' }
  | { kind: 'revoke'; assignment: RoleAssignment }
  | null;

const STATUS_ACTION: Record<UserStatusChange['status'], { label: string; title: string; description: string }> = {
  SUSPENDED: { label: 'Suspend', title: 'Suspend this user?', description: 'They are signed out everywhere and cannot sign in until reactivated. Their records and audit history are kept.' },
  DEACTIVATED: { label: 'Deactivate', title: 'Deactivate this user?', description: 'Use when someone leaves the organisation. They are signed out everywhere. Records and audit history are kept.' },
  ACTIVE: { label: 'Reactivate', title: 'Reactivate this user?', description: 'They can sign in again with their existing roles.' },
};

function expiryChip(a: RoleAssignment) {
  if (!a.expiresAt) return <Chip>No expiry</Chip>;
  const days = (new Date(a.expiresAt).getTime() - Date.now()) / 86_400_000;
  return <Chip tone={days < 7 ? 'warning' : 'neutral'}>Expires {formatDateTime(a.expiresAt)}</Chip>;
}

/** S06 user profile drawer: status, MFA, roles with scope and expiry, sessions (access review). */
export function UserDrawer({ userId, onClose, onChanged }: { userId: string | null; onClose: () => void; onChanged: () => void }) {
  const { me, can } = useAuth();
  const highRisk = useHighRisk();
  const [tab, setTab] = useState<'access' | 'sessions' | 'profile'>('access');
  const [pending, setPending] = useState<Pending>(null);
  const [granting, setGranting] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const user = useApiQuery<UserDetail>(userId ? `user:${userId}` : null, (signal) => api.get<UserDetail>(`/admin/users/${userId}`, { signal }));
  const sessions = useApiQuery<UserSession[]>(userId && tab === 'sessions' ? `sessions:${userId}` : null, (signal) => api.get<UserSession[]>(`/admin/users/${userId}/sessions`, { signal }));
  const u = user.data;
  const isSelf = u?.id === me?.user.id;

  const after = async (message: string) => {
    setNotice(message);
    setError(null);
    await user.reload();
    if (tab === 'sessions') await sessions.reload();
    onChanged();
  };

  const confirm = async (reason: string) => {
    if (!u || !pending) return;
    if (pending.kind === 'status') {
      await highRisk(() => api.post<UserDetail>(`/admin/users/${u.id}/status`, { status: pending.status, reason }));
      await after(`${u.displayName} is now ${pending.status.toLowerCase()}.`);
    } else if (pending.kind === 'mfa') {
      await highRisk(() => api.post<UserDetail>(`/admin/users/${u.id}/reset-mfa`, { reason }));
      await after(`MFA was reset. ${u.displayName} must enrol a new authenticator at next sign-in.`);
    } else if (pending.kind === 'sessions') {
      await api.post<OkResponse>(`/admin/users/${u.id}/sessions/revoke-all`, { reason });
      await after('All sessions were signed out.');
    } else if (pending.kind === 'revoke') {
      await highRisk(() => api.post<RoleAssignment>(`/admin/role-assignments/${pending.assignment.id}/revoke`, { reason }));
      await after(`Revoked ${pending.assignment.roleName}.`);
    }
  };

  const saveName = async () => {
    if (!u || editName === null) return;
    try {
      await api.patch<UserDetail>(`/admin/users/${u.id}`, { displayName: editName });
      setEditName(null);
      await after('Profile updated.');
    } catch (err) {
      setError(err);
    }
  };

  const dialog = pending
    ? pending.kind === 'status'
      ? { ...STATUS_ACTION[pending.status], tone: pending.status === 'ACTIVE' ? ('primary' as const) : ('danger' as const) }
      : pending.kind === 'mfa'
        ? { label: 'Reset MFA', title: 'Reset two-step verification?', description: 'Their authenticator is revoked and they are signed out. They must enrol a new one at next sign-in. Confirm their identity through a separate channel first.', tone: 'danger' as const }
        : pending.kind === 'sessions'
          ? { label: 'Sign out everywhere', title: 'Sign out all sessions?', description: 'Every device this person is signed in on will be signed out.', tone: 'danger' as const }
          : { label: 'Revoke role', title: `Revoke ${pending.assignment.roleName}?`, description: `${scopeLabel(pending.assignment)}. The grant is kept in history as revoked.`, tone: 'danger' as const }
    : null;

  return (
    <Drawer
      open={userId !== null}
      onClose={onClose}
      title={u?.displayName ?? 'User'}
      subtitle={u ? <span className="flex flex-wrap items-center gap-2">{u.email} <StatusBadge kind="user" status={u.status} size="sm" /></span> : null}
    >
      {user.error ? <Notice tone="danger">{describeError(user.error)}</Notice> : null}
      {!u ? (
        <div className="h-40 animate-pulse rounded-card bg-cloud" />
      ) : (
        <>
          {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
          {error ? <Notice tone="danger" className="mb-4">{describeError(error)}</Notice> : null}
          {isSelf ? <Notice tone="info" className="mb-4">This is your own account. Status, MFA and role changes must be made by another administrator.</Notice> : null}

          <div className="mb-4 flex flex-wrap gap-2">
            {can('users.suspend') && !isSelf ? (
              <>
                {u.status === 'ACTIVE' ? (
                  <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'status', status: 'SUSPENDED' })}>
                    <PauseCircle className="h-4 w-4" aria-hidden /> Suspend
                  </Button>
                ) : null}
                {u.status === 'SUSPENDED' || u.status === 'DEACTIVATED' ? (
                  <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'status', status: 'ACTIVE' })}>
                    <PlayCircle className="h-4 w-4" aria-hidden /> Reactivate
                  </Button>
                ) : null}
                {u.status !== 'DEACTIVATED' ? (
                  <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'status', status: 'DEACTIVATED' })}>
                    <UserX className="h-4 w-4" aria-hidden /> Deactivate
                  </Button>
                ) : null}
              </>
            ) : null}
            {can('users.reset_mfa') && !isSelf && u.mfaEnabled ? (
              <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'mfa' })}>
                <KeyRound className="h-4 w-4" aria-hidden /> Reset MFA
              </Button>
            ) : null}
            {can('audit.view') ? (
              <Link href={`/admin/audit?actorId=${u.id}`} className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-meta hover:bg-cloud">
                Activity by this user
              </Link>
            ) : null}
          </div>

          <Facts
            items={[
              { label: 'Two-step verification', value: u.mfaEnabled ? 'Enrolled' : 'Not enrolled' },
              { label: 'Last sign-in', value: formatDateTime(u.lastLoginAt) },
              { label: 'Phone', value: u.phone ?? '—' },
              { label: 'Created', value: formatDateTime(u.createdAt) },
              { label: 'Privacy notice', value: u.privacyNoticeVersion ? `${u.privacyNoticeVersion} accepted ${formatDateTime(u.privacyNoticeAcceptedAt)}` : 'Not accepted yet' },
            ]}
          />

          <div className="mt-6">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'access', label: 'Access', count: u.assignments.length },
                { value: 'sessions', label: 'Sessions' },
                ...(can('users.edit') ? [{ value: 'profile' as const, label: 'Profile' }] : []),
              ]}
            />
            {tab === 'access' ? (
              <section aria-label="Role assignments">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-meta text-slate">Active roles. Expired and revoked grants stay in the audit log.</p>
                  {can('roles.assign') && !isSelf ? (
                    <Button size="sm" onClick={() => setGranting(true)}>
                      <Plus className="h-4 w-4" aria-hidden /> Grant role
                    </Button>
                  ) : null}
                </div>
                {u.assignments.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-body text-slate">No active roles. This person can sign in but sees nothing.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {u.assignments.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-ink">{a.roleName}</p>
                          <p className="text-meta text-slate">
                            {scopeLabel(a)} · granted {formatDateTime(a.createdAt)}
                            {a.grantedBy ? ` by ${a.grantedBy.displayName}` : ''}
                          </p>
                        </div>
                        {expiryChip(a)}
                        {can('roles.assign') && !isSelf ? (
                          <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', assignment: a })}>
                            <ShieldOff className="h-4 w-4" aria-hidden /> Revoke
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
            {tab === 'sessions' ? (
              <section aria-label="Sessions">
                {sessions.error ? <Notice tone="danger">{describeError(sessions.error)}</Notice> : null}
                {(sessions.data ?? []).length === 0 ? (
                  <p className="text-body text-slate">{sessions.loading ? 'Loading…' : 'No active sessions.'}</p>
                ) : (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {(sessions.data ?? []).map((s) => (
                      <li key={s.id} className="px-3 py-2 text-body">
                        <p className="text-ink">{s.userAgent ?? 'Unknown device'}</p>
                        <p className="text-meta text-slate">
                          {s.ipAddress ?? 'unknown IP'} · signed in {formatDateTime(s.createdAt)} · last used {formatDateTime(s.lastUsedAt)} · {s.mfaVerified ? 'MFA verified' : 'password only'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {can('users.suspend') && !isSelf && (sessions.data ?? []).length > 0 ? (
                  <Button className="mt-3" size="sm" variant="secondary" onClick={() => setPending({ kind: 'sessions' })}>
                    Sign out everywhere
                  </Button>
                ) : null}
              </section>
            ) : null}
            {tab === 'profile' ? (
              <section aria-label="Profile">
                <Field label="Full name" htmlFor="profile-name">
                  <TextInput id="profile-name" value={editName ?? u.displayName} onChange={(e) => setEditName(e.target.value)} />
                </Field>
                <Button size="sm" disabled={editName === null || editName.trim().length < 2 || editName === u.displayName} onClick={() => void saveName()}>
                  Save
                </Button>
              </section>
            ) : null}
          </div>
        </>
      )}

      {dialog ? (
        <ReasonDialog open onClose={() => setPending(null)} title={dialog.title} description={dialog.description} confirmLabel={dialog.label} tone={dialog.tone} onConfirm={confirm} />
      ) : null}
      {u ? <GrantRoleDialog open={granting} onClose={() => setGranting(false)} user={u} onGranted={(a) => void after(`Granted ${a.roleName}.`)} /> : null}
    </Drawer>
  );
}
