'use client';

/**
 * Top-bar notification bell (blueprint 10.3; API §29 GET /notifications/counts).
 * Shows the unread count and a distinct "critical" marker while alerts await
 * acknowledgement; the panel lists the latest notifications with safe deep
 * links. Polls every minute while the tab is visible. Mount it in the app
 * shell's top bar in place of the static bell button (docs/CHANGE_REQUESTS.md).
 */
import type { NotificationCenterItem, NotificationCounts } from '@ngao360/shared';
import { AlertOctagon, Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { awaitingAck, bellLabel, relativeTime, safeDeepLink } from './notification-model';
import { SeverityBadge } from './notification-ui';
import { notificationsApi } from './notifications-api';

const POLL_MS = 60_000;

/** Badge text: exact up to 99, then "99+". */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function NotificationBell({ className }: { className?: string }) {
  const router = useRouter();
  const [counts, setCounts] = useState<NotificationCounts>({ unread: 0, awaitingAck: 0 });
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationCenterItem[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const loadCounts = useCallback(async () => {
    try {
      setCounts(await notificationsApi.counts());
    } catch {
      // Counts are a convenience; a failure leaves the last known value.
    }
  }, []);

  useEffect(() => {
    void loadCounts();
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void loadCounts();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadCounts]);

  useEffect(() => {
    if (!open) return;
    notificationsApi
      .list({ page: 1, pageSize: 8 })
      .then((p) => setItems(p.items))
      .catch(() => setItems([]));
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const follow = async (n: NotificationCenterItem) => {
    const link = safeDeepLink(n.link);
    if (!n.readAt && !awaitingAck(n)) await notificationsApi.markRead(n.id).catch(() => undefined);
    setOpen(false);
    void loadCounts();
    router.push(awaitingAck(n) || !link ? '/notifications' : link);
  };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        className="relative rounded-lg p-2 text-slate hover:bg-cloud hover:text-ink"
        aria-label={bellLabel(counts.unread, counts.awaitingAck)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-5 w-5" aria-hidden />
        {counts.unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-deep-blue px-1 text-center text-[10px] font-semibold leading-[18px] text-white" aria-hidden>
            {badgeText(counts.unread)}
          </span>
        ) : null}
        {counts.awaitingAck > 0 ? <AlertOctagon className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-surface text-error" aria-hidden /> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Recent notifications" className="ngao-card absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden">
          {counts.awaitingAck > 0 ? (
            <Link href="/notifications" onClick={() => setOpen(false)} className="flex items-center gap-2 border-b border-error/30 bg-error/5 px-3 py-2 text-body font-medium text-error">
              <AlertOctagon className="h-4 w-4" aria-hidden />
              {counts.awaitingAck} critical alert{counts.awaitingAck === 1 ? '' : 's'} need acknowledgement
            </Link>
          ) : null}
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {items === null ? (
              <li className="px-3 py-4 text-body text-slate">Loading…</li>
            ) : items.length === 0 ? (
              <li className="px-3 py-4 text-body text-slate">No notifications.</li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => void follow(n)} className={cn('block w-full px-3 py-2 text-left hover:bg-cloud', !n.readAt && 'bg-deep-blue/5')}>
                    <span className="flex items-center gap-2">
                      {n.severity !== 'INFO' ? <SeverityBadge severity={n.severity} /> : null}
                      <span className={cn('truncate text-body', !n.readAt ? 'font-semibold text-ink' : 'text-ink')}>{n.title}</span>
                      <span className="sr-only">{!n.readAt ? '(unread)' : ''}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-meta text-slate">{n.body}</span>
                    <span className="block text-[11px] text-slate">{relativeTime(n.createdAt)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-3 py-2 text-center text-body font-medium text-deep-blue hover:bg-cloud">
            Open notification centre
          </Link>
        </div>
      ) : null}
    </div>
  );
}
