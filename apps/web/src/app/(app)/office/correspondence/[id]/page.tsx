import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Correspondence item' };

/** S23 Correspondence detail with document preview. API §9. */
export default async function CorrespondenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Correspondence item"
      screen="S23 Correspondence detail"
      description={`Item ${id}: summary, attachments, assignment, deadline and status history.`}
      breadcrumbs={[{ label: 'Office' }, { label: 'Correspondence', href: '/office/correspondence' }, { label: 'Item' }]}
      anyOf={['office.correspondence.view']}
    />
  );
}
