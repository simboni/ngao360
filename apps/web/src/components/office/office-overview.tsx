'use client';

import type { PermissionKey } from '@ngao360/shared';
import { CalendarClock, FolderKanban, LifeBuoy, type LucideIcon, Mail } from 'lucide-react';
import Link from 'next/link';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { OfficeKpis } from './office-kpis';

/** Office view permissions that open the dashboard (S04) for Office roles. */
export const OFFICE_DASHBOARD_PERMISSIONS: PermissionKey[] = [
  'office.correspondence.view',
  'office.appointments.view',
  'office.meetings.view',
  'office.cases.view',
  'office.projects.view',
];

const SCREENS: Array<{ label: string; description: string; href: string; icon: LucideIcon; anyOf: PermissionKey[] }> = [
  { label: 'Correspondence', description: 'Register, assign and answer letters', href: '/office/correspondence', icon: Mail, anyOf: ['office.correspondence.view'] },
  { label: 'Appointments', description: 'Requests, diary and meetings', href: '/office/appointments', icon: CalendarClock, anyOf: ['office.appointments.view', 'office.meetings.view'] },
  { label: 'Citizen cases', description: 'Triage, assign, refer and resolve requests', href: '/office/cases', icon: LifeBuoy, anyOf: ['office.cases.view'] },
  { label: 'Projects', description: 'Track commitments and verify completion', href: '/office/projects', icon: FolderKanban, anyOf: ['office.projects.view'] },
];

/**
 * Dashboard (S04) for Office staff who do not hold `dashboard.view`: the
 * Office figures they may see and links to their screens. Hidden data stays
 * hidden: every figure is scoped server-side.
 */
export function OfficeOverview() {
  const { me, can, moduleEnabled } = useAuth();
  const firstName = me?.user.displayName.split(' ')[0] ?? '';
  const screens = moduleEnabled('office') ? SCREENS.filter((s) => s.anyOf.some((p) => can(p))) : [];
  return (
    <>
      <PageHeader title={`Welcome, ${firstName}`} description="Your Office work at a glance." breadcrumbs={[{ label: 'Overview' }, { label: 'Dashboard' }]} />
      <OfficeKpis className="mb-6" />
      {screens.length ? (
        <Card>
          <CardHeader title="Office screens" />
          <CardBody>
            <ul className="grid gap-2 sm:grid-cols-2">
              {screens.map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-cloud">
                    <s.icon className="mt-0.5 h-4 w-4 text-teal" aria-hidden />
                    <span>
                      <span className="block text-body font-medium text-ink">{s.label}</span>
                      <span className="block text-meta text-slate">{s.description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
