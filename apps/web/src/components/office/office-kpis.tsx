'use client';

/**
 * Office overview widget for the executive dashboard (S04). Shows only the
 * figures the caller is allowed to see, each from the list endpoint's `total`
 * (one small request per figure, scoped server-side). Mounted on /dashboard,
 * both in the command centre and in the Office overview for Office staff.
 * Renders nothing unless the office module is on.
 */
import type { Paginated } from '@ngao360/shared';
import { CalendarClock, ClipboardCheck, Inbox, type LucideIcon, MailWarning, ShieldQuestion } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

export interface OfficeKpiSpec {
  key: string;
  label: string;
  sublabel: string;
  href: string;
  icon: LucideIcon;
  permission: 'office.correspondence.view' | 'office.appointments.view' | 'office.projects.view' | 'office.cases.view';
  path: string;
  query: Record<string, string | number>;
  /** Highlight when the value is above zero (needs attention). */
  attention: boolean;
}

export const OFFICE_KPIS: readonly OfficeKpiSpec[] = [
  {
    key: 'correspondence_overdue',
    label: 'Overdue letters',
    sublabel: 'Response date passed, not yet answered or filed',
    href: '/office/correspondence?view=overdue',
    icon: MailWarning,
    permission: 'office.correspondence.view',
    path: '/office/correspondence',
    query: { view: 'overdue' },
    attention: true,
  },
  {
    key: 'correspondence_unassigned',
    label: 'Unassigned letters',
    sublabel: 'Received but no officer assigned',
    href: '/office/correspondence?view=unassigned',
    icon: Inbox,
    permission: 'office.correspondence.view',
    path: '/office/correspondence',
    query: { view: 'unassigned' },
    attention: true,
  },
  {
    key: 'appointments_pending',
    label: 'Appointment requests',
    sublabel: 'Waiting to be confirmed or declined',
    href: '/office/appointments',
    icon: CalendarClock,
    permission: 'office.appointments.view',
    path: '/office/appointments',
    query: { view: 'pending' },
    attention: true,
  },
  {
    key: 'cases_triage',
    label: 'Cases to triage',
    sublabel: 'New citizen requests not yet reviewed',
    href: '/office/cases?view=triage',
    icon: ShieldQuestion,
    permission: 'office.cases.view',
    path: '/office/cases',
    query: { view: 'triage' },
    attention: true,
  },
  {
    key: 'projects_reported_complete',
    label: 'Awaiting verification',
    sublabel: 'Projects reported complete, not yet independently verified',
    href: '/office/projects?stageKind=REPORTED_COMPLETE',
    icon: ClipboardCheck,
    permission: 'office.projects.view',
    path: '/office/projects',
    query: { stageKind: 'REPORTED_COMPLETE' },
    attention: false,
  },
];

/** The KPIs a caller may see (module on and permission held). */
export function visibleOfficeKpis(moduleOn: boolean, can: (p: OfficeKpiSpec['permission']) => boolean): OfficeKpiSpec[] {
  return moduleOn ? OFFICE_KPIS.filter((k) => can(k.permission)) : [];
}

export function OfficeKpis({ className }: { className?: string }) {
  const { can, moduleEnabled, loading } = useAuth();
  const specs = visibleOfficeKpis(moduleEnabled('office'), can);
  const keys = specs.map((s) => s.key).join(',');
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [asOf, setAsOf] = useState<string | null>(null);

  useEffect(() => {
    if (!keys) return;
    let alive = true;
    Promise.all(
      specs.map((s) =>
        api
          .get<Paginated<unknown>>(s.path, { query: { ...s.query, pageSize: 1 } })
          .then((p) => [s.key, p.total] as const)
          .catch(() => [s.key, null] as const),
      ),
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

  return (
    <section aria-labelledby="office-kpis-title" className={className}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="office-kpis-title" className="text-section font-semibold text-navy">
          Office
        </h2>
        {asOf ? <span className="text-meta text-slate">As of {new Intl.DateTimeFormat('en-KE', { timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(new Date(asOf))}</span> : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {specs.map((s) => {
          const v = values[s.key];
          const hot = s.attention && typeof v === 'number' && v > 0;
          return (
            <li key={s.key}>
              <Link href={s.href} className={cn('ngao-card flex h-full flex-col gap-1 p-4 hover:bg-cloud/60', hot && 'border-gold/60')}>
                <span className="flex items-center justify-between gap-2 text-meta font-medium uppercase tracking-wide text-slate">
                  {s.label}
                  <s.icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="text-[28px] font-semibold leading-8 text-navy">{v === undefined ? '…' : v === null ? '—' : formatNumber(v)}</span>
                <span className="text-meta text-slate">{s.sublabel}</span>
                {hot ? <span className="text-meta font-semibold text-[#7a5a17]">Needs attention</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
