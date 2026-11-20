import { ReauthProvider } from '@/components/admin/reauth';
import { TransactionDetailView } from '@/components/finance/transaction-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Ledger entry' };

/** S10 Ledger entry: documents, timeline, approval prerequisites, limit check and the request / approve / pay workflow. API §27.1. */
export default async function FinanceTransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['finance.view']}>
      <ReauthProvider>
        <TransactionDetailView id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
