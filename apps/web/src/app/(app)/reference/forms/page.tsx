'use client';

import { Suspense } from 'react';
import { ReauthProvider } from '@/components/admin/reauth';
import { FormTemplateRegistry } from '@/components/reference/form-template-registry';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** Form-template registry. API §4.7. */
export default function FormTemplatesPage() {
  return (
    <RequirePagePermission anyOf={['forms.view']}>
      <ReauthProvider>
        <Suspense>
          <FormTemplateRegistry />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
