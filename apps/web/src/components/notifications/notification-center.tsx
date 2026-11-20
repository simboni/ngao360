'use client';

/**
 * Notification centre (blueprint 10.3; API §7, §29): the caller's own
 * notifications with read / unread state, safe in-app deep links, critical
 * alerts that stay pinned until acknowledged, per-channel preferences and the
 * delivery log. No bulk or public outreach exists here.
 */
import { NOTIFICATION_SEVERITIES, NOTIFICATION_SEVERITY_LABELS, type NotificationCenterItem, type NotificationDelivery } from '@ngao360/shared';
import { AlertOctagon, BellOff, CheckCheck, ExternalLink, MailOpen, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FilterSelect, ViewTabs } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { awaitingAck, CHANNEL_LABELS, relativeTime, safeDeepLink, typeLabel } from './notification-model';
import { NotificationPreferencesPanel } from './notification-preferences';
import { AcknowledgeDialog, SeverityBadge } from './notification-ui';
import { notificationsApi } from './notifications-api';

type Tab = 'all' | 'unread' | 'critical' | 'preferences' | 'deliveries';

const MODULE_OPTIONS = [
  { value: 'tasks', label: 'Tasks' },
  { value: 'events', label: 'Events' },
  { value: 'comms', label: 'Communications' },
  { value: 'finance', label: 'Finance' },
  { value: 'notifications', label: 'Reports and system' },
  { value: 'security', label: 'Security' },
  { value: 'tally', label: 'Tally' },
  { value: 'field', label: 'Field' },
  { value: 'office', label: 'Office' },
];

export function NotificationCenter() {
  const { can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [severity, setSeverity] = useState('');
  const [module, setModule] = useState('');
  const [page, setPage] = useState(1);
  const [acking, setAcking] = useState<NotificationCenterItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listTab = tab === 'all' || tab === 'unread' || tab === 'critical';

  const counts = useAsync(() => notificationsApi.counts(), []);
  const list = useAsync(
    () =>
      notificationsApi.list({
        page,
        pageSize: 25,
        ...(tab === 'unread' ? { unreadOnly: true } : {}),
        ...(tab === 'critical' ? { awaitingAck: true } : {}),
        ...(severity ? { severity: severity as NotificationCenterItem['severity'] } : {}),
        ...(module ? { module } : {}),
      }),
    [tab, page, severity, module],
    listTab,
  );

  const refresh = async () => {
    await Promise.all([list.reload(), counts.reload()]);
  };
  const markRead = async (n: NotificationCenterItem) => {
    setError(null);
    try {
      await notificationsApi.markRead(n.id);
      await refresh();
    } catch (err) {
      setError(describeCampaignError(err));
    }
  };
  const open = async (n: NotificationCenterItem) => {
    const link = safeDeepLink(n.link);
    if (!n.readAt && !awaitingAck(n)) await notificationsApi.markRead(n.id).catch(() => undefined);
    if (link) router.push(link);
    else void refresh();
  };
  const markAll = async () => {
    setError(null);
    try {
      await notificationsApi.markAllRead();
      await refresh();
    } catch (err) {
      setError(describeCampaignError(err));
    }
  };

  const c = counts.data;

  return (
    <>
      <PageHeader
        title="Notifications"
        breadcrumbs={[{ label: 'Notifications' }]}
        description="Updates about your own work. Critical alerts stay at the top until you acknowledge them."
        actions={
          listTab ? (
            <Button variant="secondary" onClick={() => void markAll()} disabled={!c?.unread}>
              <CheckCheck className="h-4 w-4" aria-hidden />
              Mark all as read
            </Button>
          ) : null
        }
      />
      {c && c.awaitingAck > 0 && tab !== 'critical' ? (
        <Notice
          tone="error"
          className="mb-4"
          title={`${c.awaitingAck} critical alert${c.awaitingAck === 1 ? '' : 's'} awaiting your acknowledgement`}
          action={
            <Button size="sm" variant="danger" onClick={() => setTab('critical')}>
              Review
            </Button>
          }
        >
          Critical alerts cannot be dismissed by reading them; acknowledge, escalate or close each one.
        </Notice>
      ) : null}
      <ViewTabs
        label="Notification views"
        value={tab}
        onChange={(t) => {
          setTab(t);
          setPage(1);
        }}
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'unread', label: 'Unread', count: c?.unread ?? null },
          { key: 'critical', label: 'Awaiting acknowledgement', count: c?.awaitingAck ?? null },
          ...(can('notifications.preferences') ? [{ key: 'preferences' as const, label: 'Preferences' }] : []),
          { key: 'deliveries', label: 'Delivery log' },
        ]}
      />
      {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}

      {listTab ? (
        <>
          <div className="mb-4 grid max-w-xl gap-3 sm:grid-cols-2">
            <FilterSelect
              id="nf-sev"
              label="Severity"
              value={severity}
              onChange={(v) => {
                setSeverity(v);
                setPage(1);
              }}
              options={NOTIFICATION_SEVERITIES.map((s) => ({ value: s, label: NOTIFICATION_SEVERITY_LABELS[s] }))}
            />
            <FilterSelect
              id="nf-mod"
              label="Area"
              value={module}
              onChange={(v) => {
                setModule(v);
                setPage(1);
              }}
              options={MODULE_OPTIONS}
            />
          </div>
          {list.error ? <Notice tone="error" className="mb-4">{describeCampaignError(list.error)}</Notice> : null}
          {list.loading && !list.data ? <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" /> : null}
          {list.data && list.data.items.length === 0 ? (
            <div className="ngao-card">
              <EmptyState icon={BellOff} title={tab === 'critical' ? 'No critical alerts awaiting you' : tab === 'unread' ? 'You are all caught up' : 'No notifications yet'} />
            </div>
          ) : null}
          {list.data && list.data.items.length ? (
            <ul className="ngao-card divide-y divide-line" aria-label="Notifications">
              {list.data.items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={() => void open(n)} onRead={() => void markRead(n)} onAck={() => setAcking(n)} />
              ))}
            </ul>
          ) : null}
          {list.data && list.data.total > list.data.pageSize ? (
            <div className="mt-3 flex items-center justify-between text-meta text-slate">
              <span>
                Page {list.data.page} of {Math.ceil(list.data.total / list.data.pageSize)}
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {tab === 'preferences' ? <NotificationPreferencesPanel /> : null}
      {tab === 'deliveries' ? <DeliveryLog /> : null}
      {acking ? (
        <AcknowledgeDialog
          item={acking}
          onClose={() => setAcking(null)}
          onDone={() => {
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

function NotificationRow({ n, onOpen, onRead, onAck }: { n: NotificationCenterItem; onOpen: () => void; onRead: () => void; onAck: () => void }) {
  const unread = !n.readAt;
  const pending = awaitingAck(n);
  const link = safeDeepLink(n.link);
  return (
    <li className={cn('flex flex-wrap items-start gap-3 px-4 py-3', pending ? 'bg-error/5' : unread ? 'bg-deep-blue/5' : '')}>
      <span className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', unread ? 'bg-deep-blue' : 'bg-transparent')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {n.severity !== 'INFO' ? <SeverityBadge severity={n.severity} /> : null}
          <span className={cn('text-body', unread ? 'font-semibold text-ink' : 'text-ink')}>{n.title}</span>
          <span className="sr-only">{unread ? '(unread)' : '(read)'}</span>
          {pending ? (
            <span className="inline-flex items-center gap-1 text-meta font-semibold text-error">
              <AlertOctagon className="h-3.5 w-3.5" aria-hidden />
              Acknowledgement required
            </span>
          ) : n.requiresAck && n.acknowledgedAt ? (
            <span className="inline-flex items-center gap-1 text-meta text-success">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Acknowledged {formatDateTime(n.acknowledgedAt)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-body text-slate">{n.body}</p>
        <p className="mt-0.5 text-meta text-slate">
          {typeLabel(n.type)} · <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</time>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {pending ? (
          <Button size="sm" variant="danger" onClick={onAck}>
            Acknowledge
          </Button>
        ) : null}
        {link ? (
          <Button size="sm" variant="secondary" onClick={onOpen}>
            <ExternalLink className="h-4 w-4" aria-hidden />
            Open
          </Button>
        ) : null}
        {unread && !pending ? (
          <Button size="sm" variant="ghost" onClick={onRead} aria-label={`Mark “${n.title}” as read`}>
            <MailOpen className="h-4 w-4" aria-hidden />
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function DeliveryLog() {
  const [page, setPage] = useState(1);
  const { data, error, loading } = useAsync(() => notificationsApi.deliveries({ page, pageSize: 25 }), [page]);
  const columns: Column<NotificationDelivery>[] = [
    { key: 'when', header: 'Time', cell: (d) => formatDateTime(d.createdAt) },
    { key: 'channel', header: 'Channel', cell: (d) => CHANNEL_LABELS[d.channel] },
    { key: 'provider', header: 'Provider', cell: (d) => <span className="font-mono text-meta">{d.provider}</span> },
    { key: 'status', header: 'Status', cell: (d) => (d.status === 'SKIPPED' ? 'Skipped (not sent)' : d.status.charAt(0) + d.status.slice(1).toLowerCase()) },
    { key: 'attempt', header: 'Attempt', align: 'right', cell: (d) => d.attempt },
    { key: 'error', header: 'Detail', cell: (d) => d.error ?? '—' },
  ];
  return (
    <>
      <p className="mb-3 text-meta text-slate">
        Each attempt to deliver your notifications by e-mail, SMS or push. Without a configured provider the log provider records the attempt as skipped and
        sends nothing. See <Link href="/notifications" className="underline">your notifications</Link> for the in-app copies.
      </p>
      {error ? <Notice tone="error" className="mb-3">{describeCampaignError(error)}</Notice> : null}
      <DataTable
        caption="Delivery log"
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(d) => d.id}
        loading={loading && !data}
        emptyTitle="No external deliveries"
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
      />
    </>
  );
}
