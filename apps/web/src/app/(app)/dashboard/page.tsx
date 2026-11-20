'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { DashboardView } from '@/components/admin/dashboard-view';
import { MOBILE_PERMISSIONS } from '@/components/field/mobile/mobile-nav';
import { OFFICE_DASHBOARD_PERMISSIONS, OfficeOverview } from '@/components/office/office-overview';
import { RequirePagePermission } from '@/components/ui/permission-gate';
import { useAuth } from '@/lib/auth-context';

/**
 * S04 dashboard. API §7 GET /dashboard/summary for the executive / tally
 * command centre, which also shows the Office KPIs when the office module is
 * on. An office without NGAO TALLY (and Office staff without `dashboard.view`)
 * gets the Office overview instead: the office KPIs the caller may see and
 * their screens, with no tally or campaign figures (blueprint 15.2).
 */
export default function DashboardPage() {
  const { can, moduleEnabled } = useAuth();
  const router = useRouter();
  // Field agents (mobile-only, no dashboard) land on the field app.
  const fieldAgentOnly = moduleEnabled('field') && !can('dashboard.view') && MOBILE_PERMISSIONS.some((p) => can(p));
  useEffect(() => {
    if (fieldAgentOnly) router.replace('/m');
  }, [fieldAgentOnly, router]);
  const officeStaff = moduleEnabled('office') && OFFICE_DASHBOARD_PERMISSIONS.some((p) => can(p));
  const officeOnly = officeStaff && (!can('dashboard.view') || !moduleEnabled('tally'));
  return (
    <RequirePagePermission anyOf={['dashboard.view', ...OFFICE_DASHBOARD_PERMISSIONS]}>
      {officeOnly ? <OfficeOverview /> : <DashboardView />}
    </RequirePagePermission>
  );
}
