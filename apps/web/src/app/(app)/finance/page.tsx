import { ReauthProvider } from '@/components/admin/reauth';
import { FinanceLedger } from '@/components/finance/finance-ledger';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Finance ledger' };

/** S10 Finance ledger: balances, ledger, contribution register, budget vs actual. API §27. */
export default function FinancePage() {
  return (
    <RequirePagePermission anyOf={['finance.view']}>
      <ReauthProvider>
        <FinanceLedger />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
