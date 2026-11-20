'use client';

import { ReauthProvider } from '@/components/admin/reauth';
import { RoleEditor } from '@/components/admin/role-editor';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** S07 Role editor. API §6.2–6.3. */
export default function RolesPage() {
  return (
    <RequirePagePermission anyOf={['roles.view']}>
      <ReauthProvider>
        <RoleEditor />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
