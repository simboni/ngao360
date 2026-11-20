'use client';

import { DashboardView } from '@/components/admin/dashboard-view';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** S04 Executive / Tally Command Centre. API §7 GET /dashboard/summary. */
export default function DashboardPage() {
  return (
    <RequirePagePermission anyOf={['dashboard.view']}>
      <DashboardView />
    </RequirePagePermission>
  );
}
