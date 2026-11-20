import { Suspense } from 'react';
import { CorrespondenceInbox } from '@/components/office/correspondence/correspondence-inbox';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Correspondence' };

/** S23 Correspondence inbox. API §9. */
export default function CorrespondencePage() {
  return (
    <RequirePagePermission anyOf={['office.correspondence.view']}>
      <Suspense>
        <CorrespondenceInbox />
      </Suspense>
    </RequirePagePermission>
  );
}
