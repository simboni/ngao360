import { OrgTree } from '@/components/org/org-tree';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Organisation' };

/** S05 Organisation tree. API §23. */
export default function OrgPage() {
  return (
    <RequirePagePermission anyOf={['org.departments.view', 'org.teams.view']}>
      <OrgTree />
    </RequirePagePermission>
  );
}
