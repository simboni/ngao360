import { ReauthProvider } from '@/components/admin/reauth';
import { FinanceSettings } from '@/components/finance/finance-settings';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Finance settings' };

/** Finance limit settings with effective dates, legal source and verification (blueprint 15.3). API §27.6. */
export default function FinanceSettingsPage() {
  return (
    <RequirePagePermission anyOf={['finance.settings.manage', 'finance.view']}>
      <ReauthProvider>
        <FinanceSettings />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
