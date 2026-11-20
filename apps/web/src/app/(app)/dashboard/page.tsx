'use client';

import { DashboardView } from '@/components/admin/dashboard-view';
import { OFFICE_DASHBOARD_PERMISSIONS, OfficeOverview } from '@/components/office/office-overview';
import { RequirePagePermission } from '@/components/ui/permission-gate';
import { useAuth } from '@/lib/auth-context';

/**
 * S04 Executive / Tally Command Centre. API §7 GET /dashboard/summary.
 * Office staff without `dashboard.view` get the Office overview (office KPIs
 * and their screens); `dashboard.view` holders see the office KPIs on top of
 * the command centre when the module is on.
 */
export default function DashboardPage() {
  const { can } = useAuth();
  return (
    <RequirePagePermission anyOf={['dashboard.view', ...OFFICE_DASHBOARD_PERMISSIONS]}>
      {can('dashboard.view') ? <DashboardView /> : <OfficeOverview />}
    </RequirePagePermission>
  );
}
