import { ReauthProvider } from '@/components/admin/reauth';
import { FinanceMasterData } from '@/components/settings/finance-master-data';
import { RequireModuleEnabled, RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Finance master data' };

/**
 * Finance accounts, categories, payees and budget lines (API §27.2–27.4). Organisation-level;
 * needs the campaign module. Limit settings stay on /finance/settings. Owner: workspace-admin.
 */
export default function FinanceMasterDataPage() {
  return (
    <RequireModuleEnabled module="campaign">
      <RequirePagePermission anyOf={['finance.view']}>
        <ReauthProvider>
          <FinanceMasterData />
        </ReauthProvider>
      </RequirePagePermission>
    </RequireModuleEnabled>
  );
}
