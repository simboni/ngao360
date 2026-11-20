import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Finance ledger' };

/** S10 Finance ledger. */
export default function FinancePage() {
  return (
    <ModulePlaceholder
      title="Finance ledger"
      screen="S10 Finance ledger"
      description="Accounts and balances, transactions with category, date, amount, payee or contributor, reference and documents, and the request, approve and pay states. Limit findings use the organisation's configured settings. API §27."
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance' }]}
      anyOf={['finance.view']}
    />
  );
}
