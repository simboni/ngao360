import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Ledger entry' };

/** S10 Ledger entry. */
export default async function FinanceTransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Ledger entry"
      screen="S10 Ledger entry"
      description={`Entry ${id}: amount in KES, category, account, payee or contributor, reference, supporting documents, approval blockers, compliance findings, request, approval and payment history and any reversing entry.`}
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance', href: '/finance' }, { label: 'Ledger entry' }]}
      anyOf={['finance.view']}
    />
  );
}
