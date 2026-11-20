import { ReauthProvider } from '@/components/admin/reauth';
import { ReportsHome } from '@/components/reports/reports-home';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Reports' };

/** S28 Report builder, standard-report catalogue, saved templates and export log. API §28. */
export default function ReportsPage() {
  return (
    <RequirePagePermission anyOf={['reports.view', 'reports.build']}>
      <ReauthProvider>
        <ReportsHome />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
