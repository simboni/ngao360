'use client';

import { CheckCircle2, ClipboardList, FileInput, MapPin } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiCard } from '@/components/ui/kpi-card';
import { PageHeader } from '@/components/ui/page-header';
import { RequirePagePermission } from '@/components/ui/permission-gate';
import { useAuth } from '@/lib/auth-context';

/** S04 Executive dashboard (placeholder KPIs until GET /dashboard/summary is implemented). */
export default function DashboardPage() {
  const { me } = useAuth();
  return (
    <RequirePagePermission anyOf={['dashboard.view']}>
      <PageHeader
        title={`Welcome, ${me?.user.displayName.split(' ')[0] ?? ''}`}
        description="Overview of your workspace. Figures appear here as modules come online."
        breadcrumbs={[{ label: 'Overview' }, { label: 'Dashboard' }]}
      />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Expected stations" value={null} sublabel="Approved registry" icon={MapPin} />
        <KpiCard label="Forms received" value={null} icon={FileInput} />
        <KpiCard label="Verified" value={null} sublabel="Two-person verified" icon={CheckCircle2} />
        <KpiCard label="Awaiting review" value={null} icon={ClipboardList} />
      </div>
      <Card>
        <CardHeader title="Recent activity" description="Latest audited actions in your workspace" />
        <CardBody>
          <EmptyState title="No recent activity" description="Actions such as uploads, verifications and role changes will be listed here." />
        </CardBody>
      </Card>
    </RequirePagePermission>
  );
}
