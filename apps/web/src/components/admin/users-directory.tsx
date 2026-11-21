'use client';

import { type Paginated, type Role, USER_STATUS_LABELS, USER_STATUSES, type UserStatus, type UserSummary } from '@ngao360/shared';
import { CheckCircle2, CircleSlash, UserPlus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, type SortState } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { recoveryNoticeTarget } from '@/components/recovery/recovery-model';
import { InviteUserDialog } from './invite-user-dialog';
import { Chip, Notice, SelectInput, TextInput } from './primitives';
import { describeError, useApiQuery } from './use-api';
import { UserDrawer } from './user-drawer';

const PAGE_SIZE = 25;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** S06 User directory. */
export function UsersDirectory() {
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<UserStatus | ''>((params.get('status') as UserStatus) ?? '');
  const [roleKey, setRoleKey] = useState(params.get('roleKey') ?? '');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get('user'));
  const [inviting, setInviting] = useState(params.get('invite') === '1');
  const [notice, setNotice] = useState<string | null>(null);
  const debouncedQ = useDebounced(q);

  useEffect(() => setPage(1), [debouncedQ, status, roleKey]);

  // In-app recovery notices link to `/admin/users?recovery=<id>` (API): open that request.
  const recoveryTarget = recoveryNoticeTarget(params.get('recovery'));
  useEffect(() => {
    if (recoveryTarget) router.replace(recoveryTarget);
  }, [recoveryTarget, router]);

  const roles = useApiQuery<Role[]>(can('roles.view') ? 'dir-roles' : null, async (signal) => (await api.get<Paginated<Role>>('/admin/roles', { query: { pageSize: 200 }, signal })).items);
  const list = useApiQuery<Paginated<UserSummary>>(`users:${debouncedQ}:${status}:${roleKey}:${page}:${sort?.key}:${sort?.order}`, (signal) =>
    api.get<Paginated<UserSummary>>('/admin/users', {
      query: { q: debouncedQ || undefined, status: status || undefined, roleKey: roleKey || undefined, page, pageSize: PAGE_SIZE, sort: sort?.key, order: sort?.order },
      signal,
    }),
  );

  const columns: Column<UserSummary>[] = [
    {
      key: 'displayName',
      header: 'Name',
      sortValue: (u) => u.displayName,
      cell: (u) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{u.displayName}</p>
          <p className="truncate text-meta text-slate">{u.email}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (u) => u.status, cell: (u) => <StatusBadge kind="user" status={u.status} size="sm" /> },
    {
      key: 'roles',
      header: 'Roles',
      cell: (u) =>
        u.roles.length === 0 ? (
          <span className="text-meta text-slate">No role</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {u.roles.map((r, i) => (
              <Chip key={`${r.key}-${i}`} tone={r.scopeType === 'ORGANISATION' ? 'neutral' : 'info'} title={r.scopeType === 'ORGANISATION' ? 'Organisation-wide' : `Limited to one ${r.scopeType.toLowerCase().replace('_', ' ')}`}>
                {r.name}
                {r.scopeType !== 'ORGANISATION' ? ` · ${r.scopeType.toLowerCase().replace('_', ' ')}` : ''}
              </Chip>
            ))}
          </div>
        ),
    },
    {
      key: 'mfa',
      header: 'MFA',
      cell: (u) =>
        u.mfaEnabled ? (
          <span className="inline-flex items-center gap-1 text-meta text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Enrolled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-meta text-slate">
            <CircleSlash className="h-3.5 w-3.5" aria-hidden /> Not enrolled
          </span>
        ),
    },
    { key: 'lastLoginAt', header: 'Last sign-in', sortValue: (u) => u.lastLoginAt, cell: (u) => <span className="text-meta text-slate">{formatDateTime(u.lastLoginAt)}</span> },
  ];

  const openUser = (id: string | null) => {
    setSelected(id);
    const next = new URLSearchParams(params.toString());
    if (id) next.set('user', id);
    else next.delete('user');
    next.delete('invite');
    router.replace(`/admin/users${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  const filtersActive = !!(q || status || roleKey);

  return (
    <>
      <PageHeader
        title="Users"
        description="People with access to this workspace. Grant the least access each person needs, limited by geography and time."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users' }]}
        actions={
          can('users.create') ? (
            <Button onClick={() => setInviting(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Invite user
            </Button>
          ) : null
        }
      />
      {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_200px_240px_auto]">
        <div>
          <label htmlFor="user-search" className="sr-only">
            Search users
          </label>
          <TextInput id="user-search" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label htmlFor="user-status" className="sr-only">
            Status
          </label>
          <SelectInput id="user-status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus | '')}>
            <option value="">All statuses</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {USER_STATUS_LABELS[s]}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label htmlFor="user-role" className="sr-only">
            Role
          </label>
          <SelectInput id="user-role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} disabled={!roles.data}>
            <option value="">All roles</option>
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.key}>
                {r.name}
              </option>
            ))}
          </SelectInput>
        </div>
        {filtersActive ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQ('');
              setStatus('');
              setRoleKey('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {list.error ? <Notice tone="danger" className="mb-4">{describeError(list.error)}</Notice> : null}
      <DataTable
        caption="Users"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(u) => u.id}
        loading={list.loading && !list.data}
        onRowClick={(u) => openUser(u.id)}
        sort={sort}
        onSortChange={setSort}
        emptyTitle={filtersActive ? 'No users match these filters' : 'No users yet'}
        emptyDescription={filtersActive ? 'Try a different search or clear the filters.' : can('users.create') ? 'Invite the first member of your team.' : undefined}
        pagination={list.data ? { page, pageSize: PAGE_SIZE, total: list.data.total, onPageChange: setPage } : undefined}
      />
      <UserDrawer userId={selected} onClose={() => openUser(null)} onChanged={() => void list.reload()} />
      <InviteUserDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onInvited={(u) => {
          setNotice(`${u.displayName} was invited. They can sign in once they set a password from their invitation link.`);
          void list.reload();
        }}
      />
    </>
  );
}
