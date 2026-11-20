'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { queueHeadline } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, MobileCard } from './mobile-ui';

/** Queue counts (blueprint 11.3 "sync status"): local saves are shown apart from server-confirmed uploads. */
export function QueueStatusCard() {
  const s = useMobileSession();
  const c = s.counts;
  const tiles = [
    { label: 'Waiting', value: c.pending, hint: c.retrying > 0 ? `${c.retrying} retrying` : 'on this phone', cls: c.pending > 0 ? 'text-deep-blue' : 'text-slate' },
    { label: 'Sent', value: c.sent, hint: 'received today', cls: 'text-success' },
    { label: 'Not accepted', value: c.failed, hint: 'read why', cls: c.failed > 0 ? 'text-error' : 'text-slate' },
    { label: 'Your decision', value: c.conflict, hint: 'conflicts', cls: c.conflict > 0 ? 'text-gold' : 'text-slate' },
  ];
  return (
    <MobileCard
      title="Upload queue"
      action={
        <Link href="/m/queue" className="flex min-h-[44px] items-center px-2 text-body font-semibold text-teal">
          Open
        </Link>
      }
    >
      <p className="mb-3 text-body text-ink" role="status" aria-live="polite">
        {queueHeadline(c, s.online)}
      </p>
      <dl className="grid grid-cols-4 gap-2 text-center">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-cloud px-1 py-2">
            <dd className={cn('text-[22px] font-semibold leading-7', t.cls)}>{t.value}</dd>
            <dt className="text-meta font-medium text-ink">{t.label}</dt>
            <p className="text-[11px] leading-4 text-slate">{t.hint}</p>
          </div>
        ))}
      </dl>
      {c.pending > 0 ? (
        <BigButton
          className="mt-3"
          tone="secondary"
          loading={s.syncing}
          disabled={!s.online}
          onClick={async () => {
            await s.queue?.retryNow();
            await s.syncNow(true);
          }}
        >
          <RefreshCw className="h-5 w-5" aria-hidden /> {s.online ? 'Upload now' : 'Will upload when online'}
        </BigButton>
      ) : null}
      {s.lastSyncAt ? (
        <p className="mt-2 text-meta text-slate">Last upload attempt {formatDateTime(s.lastSyncAt)}</p>
      ) : null}
    </MobileCard>
  );
}
