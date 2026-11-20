'use client';

/**
 * Campaign and finance figures for the S04 dashboard (blueprint 4). Each tile
 * shows only when the campaign module is on and the caller holds the tile's
 * permission; finance tiles need `finance.view`, which operations roles never
 * hold. Counts come from the list endpoints' `total` (scoped server-side) and
 * the finance ledger summary; nothing is computed from data the caller cannot
 * see. Alerts awaiting acknowledgement come from the notification centre.
 */
import { formatMoney, type FinanceLedgerSummary, type NotificationCounts, type Paginated, type PermissionKey } from '@ngao360/shared';
import {
  AlertOctagon,
  BadgeCheck,
  CalendarDays,
  ClipboardList,
  Clock,
  FileCheck2,
  type LucideIcon,
  Megaphone,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

type Source =
  | { kind: 'list'; path: string; query: (now: Date) => Record<string, string | number | boolean | string[]> }
  | { kind: 'ledger'; pick: (s: FinanceLedgerSummary) => number; money?: boolean }
  | { kind: 'counts'; pick: (c: NotificationCounts) => number };

export interface CampaignKpiSpec {
  key: string;
  label: string;
  sublabel: string;
  href: string;
  icon: LucideIcon;
  /** Any one of these permissions shows the tile. */
  anyOf: readonly PermissionKey[];
  /** Needs the campaign module (the notification tile does not). */
  campaign: boolean;
  group: 'campaign' | 'finance';
  source: Source;
  attention: boolean;
}

const DAY = 86_400_000;

export const CAMPAIGN_KPIS: readonly CampaignKpiSpec[] = [
  {
    key: 'tasks_mine',
    label: 'My open tasks',
    sublabel: 'Owned by you or shared with you, not completed',
    href: '/tasks',
    icon: ClipboardList,
    anyOf: ['tasks.view'],
    campaign: true,
    group: 'campaign',
    source: { kind: 'list', path: '/tasks', query: () => ({ view: 'mine', status: ['READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW'] }) },
    attention: false,
  },
  {
    key: 'tasks_overdue',
    label: 'Overdue tasks',
    sublabel: 'Past the due date and still open, in your departments',
    href: '/tasks',
    icon: Clock,
    anyOf: ['tasks.view'],
    campaign: true,
    group: 'campaign',
    source: { kind: 'list', path: '/tasks', query: () => ({ view: 'overdue' }) },
    attention: true,
  },
  {
    key: 'tasks_review',
    label: 'Tasks to review',
    sublabel: 'Submitted for your review',
    href: '/tasks',
    icon: BadgeCheck,
    anyOf: ['tasks.review', 'tasks.manage_all'],
    campaign: true,
    group: 'campaign',
    source: { kind: 'list', path: '/tasks', query: () => ({ view: 'review' }) },
    attention: true,
  },
  {
    key: 'events_upcoming',
    label: 'Events in the next 14 days',
    sublabel: 'Planned or confirmed, in your departments',
    href: '/events',
    icon: CalendarDays,
    anyOf: ['events.view'],
    campaign: true,
    group: 'campaign',
    source: {
      kind: 'list',
      path: '/events',
      query: (now) => ({ from: now.toISOString(), to: new Date(now.getTime() + 14 * DAY).toISOString() }),
    },
    attention: false,
  },
  {
    key: 'comms_awaiting_me',
    label: 'Content awaiting you',
    sublabel: 'Items at a review or approval step you can act on',
    href: '/comms',
    icon: Megaphone,
    anyOf: ['comms.content.edit', 'comms.content.approve'],
    campaign: true,
    group: 'campaign',
    source: { kind: 'list', path: '/comms', query: () => ({ view: 'awaiting_me' }) },
    attention: true,
  },
  {
    key: 'alerts_awaiting_ack',
    label: 'Alerts to acknowledge',
    sublabel: 'Critical notifications waiting for your acknowledgement',
    href: '/notifications',
    icon: AlertOctagon,
    anyOf: ['notifications.view'],
    campaign: false,
    group: 'campaign',
    source: { kind: 'counts', pick: (c) => c.awaitingAck },
    attention: true,
  },
  {
    key: 'finance_awaiting_approval',
    label: 'Entries awaiting approval',
    sublabel: 'Requested ledger entries not yet approved or rejected',
    href: '/finance',
    icon: FileCheck2,
    anyOf: ['finance.view'],
    campaign: true,
    group: 'finance',
    source: { kind: 'ledger', pick: (s) => s.pending.awaitingApproval },
    attention: true,
  },
  {
    key: 'finance_awaiting_payment',
    label: 'Approved, not yet paid',
    sublabel: 'Approved entries waiting for a payer',
    href: '/finance',
    icon: Wallet,
    anyOf: ['finance.view'],
    campaign: true,
    group: 'finance',
    source: { kind: 'ledger', pick: (s) => s.pending.awaitingPayment },
    attention: false,
  },
  {
    key: 'finance_limit_findings',
    label: 'Limit findings',
    sublabel: 'Warnings and blocks from the configured limit settings',
    href: '/finance',
    icon: ShieldAlert,
    anyOf: ['finance.view'],
    campaign: true,
    group: 'finance',
    source: { kind: 'ledger', pick: (s) => s.compliance.length + s.pending.flagged },
    attention: true,
  },
  {
    key: 'finance_expenses_posted',
    label: 'Expenses posted',
    sublabel: 'Approved and paid expenses, net of reversals',
    href: '/finance',
    icon: Wallet,
    anyOf: ['finance.view'],
    campaign: true,
    group: 'finance',
    source: { kind: 'ledger', pick: (s) => s.totals.expensesMinor, money: true },
    attention: false,
  },
];

/** The tiles a caller may see: module on (where needed) and one of the tile's permissions held. */
export function visibleCampaignKpis(campaignOn: boolean, can: (p: PermissionKey) => boolean): CampaignKpiSpec[] {
  return CAMPAIGN_KPIS.filter((k) => (!k.campaign || campaignOn) && k.anyOf.some((p) => can(p)));
}

type Value = { n: number | null; text?: string };

export function CampaignKpis({ className }: { className?: string }) {
  const { can, moduleEnabled, loading } = useAuth();
  const campaignOn = moduleEnabled('campaign');
  // Without the campaign module the alert tile belongs to the notification bell only.
  const specs = campaignOn ? visibleCampaignKpis(campaignOn, can) : [];
  const keys = specs.map((s) => s.key).join(',');
  const [values, setValues] = useState<Record<string, Value>>({});
  const [asOf, setAsOf] = useState<string | null>(null);

  useEffect(() => {
    if (!keys) return;
    let alive = true;
    const now = new Date();
    const needsLedger = specs.some((s) => s.source.kind === 'ledger');
    const needsCounts = specs.some((s) => s.source.kind === 'counts');
    const ledger = needsLedger ? api.get<FinanceLedgerSummary>('/finance/ledger').catch(() => null) : Promise.resolve(null);
    const counts = needsCounts ? api.get<NotificationCounts>('/notifications/counts').catch(() => null) : Promise.resolve(null);
    Promise.all(
      specs.map(async (s): Promise<readonly [string, Value]> => {
        const src = s.source;
        if (src.kind === 'list') {
          const p = await api.get<Paginated<unknown>>(src.path, { query: { ...src.query(now), pageSize: 1 } }).catch(() => null);
          return [s.key, { n: p ? p.total : null }];
        }
        if (src.kind === 'ledger') {
          const l = await ledger;
          if (!l) return [s.key, { n: null }];
          const n = src.pick(l);
          return [s.key, { n, text: src.money ? formatMoney(n, l.currency) : undefined }];
        }
        const c = await counts;
        return [s.key, { n: c ? src.pick(c) : null }];
      }),
    ).then((rows) => {
      if (!alive) return;
      setValues(Object.fromEntries(rows));
      setAsOf(new Date().toISOString());
    });
    return () => {
      alive = false;
    };
    // `specs` is derived from `keys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  if (loading || !specs.length) return null;
  const groups: Array<{ id: 'campaign' | 'finance'; title: string }> = [
    { id: 'campaign', title: 'Campaign operations' },
    { id: 'finance', title: 'Finance' },
  ];

  return (
    <div className={cn('space-y-4', className)}>
      {groups.map((g) => {
        const tiles = specs.filter((s) => s.group === g.id);
        if (!tiles.length) return null;
        return (
          <section key={g.id} aria-labelledby={`campaign-kpis-${g.id}`}>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id={`campaign-kpis-${g.id}`} className="text-section font-semibold text-navy">
                {g.title}
              </h2>
              {asOf ? (
                <span className="text-meta text-slate">
                  As of {new Intl.DateTimeFormat('en-KE', { timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(new Date(asOf))}
                </span>
              ) : null}
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
              {tiles.map((s) => {
                const v = values[s.key];
                const hot = s.attention && typeof v?.n === 'number' && v.n > 0;
                return (
                  <li key={s.key}>
                    <Link href={s.href} className={cn('ngao-card flex h-full flex-col gap-1 p-4 hover:bg-cloud/60', hot && 'border-gold/60')}>
                      <span className="flex items-center justify-between gap-2 text-meta font-medium uppercase tracking-wide text-slate">
                        {s.label}
                        <s.icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="text-[28px] font-semibold leading-8 text-navy">
                        {v === undefined ? '…' : v.n === null ? '—' : (v.text ?? formatNumber(v.n))}
                      </span>
                      <span className="text-meta text-slate">{s.sublabel}</span>
                      {hot ? <span className="text-meta font-semibold text-[#7a5a17]">Needs attention</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
