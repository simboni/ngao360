'use client';

/**
 * Account recovery (CR AR8, API contract §32.3): open, completed, expired and closed requests,
 * request a new one, and decide on one in the detail drawer. The only way to reset a privileged
 * account's sign-in factors; it always takes two administrators.
 *
 * URL: `?status=` filter, `?id=` open request, `?user=` start a request for that person (the entry
 * point from the user directory). In-app notices link to `/admin/users?recovery=<id>`, which
 * forwards here.
 */
import type { AccountRecoverySummary, Paginated, UserDetail } from '@ngao360/shared';
import { LifeBuoy } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Notice, Tabs } from '@/components/admin/primitives';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { RecoveryDetail } from './recovery-detail';
import { parseRecoveryFilter, RECOVERY_FILTERS, type RecoveryFilter, withoutHandoff } from './recovery-model';
import { RecoveryStatusBadge } from './recovery-ui';
import { RequestRecoveryDialog } from './request-recovery-dialog';

const PAGE_SIZE = 25;

export function RecoveryList() {
  const { me, can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const filter = parseRecoveryFilter(params.get('status'));
  const selected = params.get('id');
  const presetUserId = params.get('user');
  const [page, setPage] = useState(1);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(`/admin/recovery${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  const list = useApiQuery<Paginated<AccountRecoverySummary>>(`recoveries:${filter}:${page}`, async (signal) => {
    if (filter === 'OPEN') {
      // Open = pending + approved. One open request per person, so this stays small.
      const [p, a] = await Promise.all(
        (['PENDING', 'APPROVED'] as const).map((status) => api.get<Paginated<AccountRecoverySummary>>('/admin/account-recovery', { query: { status, pageSize: 100 }, signal })),
      );
      const items = [...p!.items, ...a!.items].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      return { items, total: items.length, page: 1, pageSize: items.length || PAGE_SIZE };
    }
    return api.get<Paginated<AccountRecoverySummary>>('/admin/account-recovery', {
      query: { status: filter === 'ALL' ? undefined : filter, page, pageSize: PAGE_SIZE },
      signal,
    });
  });

  const preset = useApiQuery<UserDetail>(presetUserId && can('users.view') ? `recovery-preset:${presetUserId}` : null, (signal) => api.get<UserDetail>(`/admin/users/${presetUserId}`, { signal }));
  const dialogOpen = requesting || (!!presetUserId && !!preset.data);

  const columns: Column<AccountRecoverySummary>[] = [
    {
      key: 'user',
      header: 'Account',
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{r.user.displayName}</p>
          {r.user.id === me?.user.id ? <p className="text-meta text-slate">Your own account</p> : null}
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => <RecoveryStatusBadge status={r.status} size="sm" /> },
    {
      key: 'requestedBy',
      header: 'Requested by',
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.requestedBy.id === me?.user.id ? 'You' : r.requestedBy.displayName}</p>
          <p className="text-meta text-slate">{formatDateTime(r.createdAt)}</p>
        </div>
      ),
    },
    { key: 'approvedBy', header: 'Approved by', cell: (r) => <span className="text-meta text-slate">{r.approvedBy ? (r.approvedBy.id === me?.user.id ? 'You' : r.approvedBy.displayName) : '—'}</span> },
    { key: 'expiresAt', header: 'Expires', cell: (r) => <span className="text-meta text-slate">{r.completedAt ? `Used ${formatDateTime(r.completedAt)}` : formatDateTime(r.expiresAt)}</span> },
  ];

  const filtered = filter !== 'OPEN' && filter !== 'ALL';

  return (
    <>
      <PageHeader
        title="Account recovery"
        description="For people who lost every sign-in factor. One administrator checks identity and asks; a second approves; the person then sets a new password from a single-use link."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users', href: '/admin/users' }, { label: 'Account recovery' }]}
        actions={
          <Button onClick={() => setRequesting(true)}>
            <LifeBuoy className="h-4 w-4" aria-hidden /> Request recovery
          </Button>
        }
      />
      {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
      {preset.error ? <Notice tone="danger" className="mb-4">{describeError(preset.error)}</Notice> : null}
      <Tabs<RecoveryFilter>
        value={filter}
        onChange={(v) => {
          setPage(1);
          setParams({ status: v === 'OPEN' ? null : v });
        }}
        tabs={RECOVERY_FILTERS.map((f) => ({ ...f, ...(f.value === filter && list.data ? { count: list.data.total } : {}) }))}
      />
      {list.error ? <Notice tone="danger" className="mb-4">{describeError(list.error)}</Notice> : null}
      <DataTable
        caption="Account recovery requests"
        columns={columns}
        rows={list.data?.items.map(withoutHandoff) ?? []}
        rowKey={(r) => r.id}
        loading={list.loading && !list.data}
        onRowClick={(r) => setParams({ id: r.id })}
        emptyTitle={filter === 'OPEN' ? 'No open recovery requests' : 'No requests here'}
        emptyDescription={filter === 'OPEN' ? 'Requests waiting for a second administrator, or for the person to use their link, appear here.' : 'Try another filter.'}
        pagination={filtered || filter === 'ALL' ? (list.data ? { page, pageSize: PAGE_SIZE, total: list.data.total, onPageChange: setPage } : undefined) : undefined}
      />
      <RecoveryDetail id={selected} onClose={() => setParams({ id: null })} onChanged={() => void list.reload()} />
      <RequestRecoveryDialog
        open={dialogOpen}
        onClose={() => {
          setRequesting(false);
          if (presetUserId) setParams({ user: null });
        }}
        presetUser={presetUserId && preset.data ? { id: preset.data.id, displayName: preset.data.displayName, email: preset.data.email } : null}
        onRequested={(r) => {
          setRequesting(false);
          setNotice(`Recovery requested for ${r.user.displayName}. Another administrator with the reset permission was notified to approve it.`);
          setParams({ user: null, id: r.id, status: null });
          void list.reload();
        }}
      />
    </>
  );
}
