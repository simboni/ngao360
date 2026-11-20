import { Suspense } from 'react';
import { CorrespondenceDetail } from '@/components/office/correspondence/correspondence-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Correspondence item' };

/** S23 Correspondence detail with document preview. API §9. */
export default async function CorrespondenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['office.correspondence.view']}>
      <Suspense>
        <CorrespondenceDetail id={id} />
      </Suspense>
    </RequirePagePermission>
  );
}
