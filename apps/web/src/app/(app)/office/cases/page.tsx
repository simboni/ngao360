import { Suspense } from 'react';
import { CaseList } from '@/components/office/cases/case-list';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Citizen cases' };

/** Citizen case list (S25 entry point). API §11. */
export default function CasesPage() {
  return (
    <RequirePagePermission anyOf={['office.cases.view']}>
      <Suspense>
        <CaseList />
      </Suspense>
    </RequirePagePermission>
  );
}
