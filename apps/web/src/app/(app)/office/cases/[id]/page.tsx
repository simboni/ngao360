import { ReauthProvider } from '@/components/admin/reauth';
import { CaseWorkspace } from '@/components/office/cases/case-workspace';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Case workspace' };

/** S25 Case workspace. API §11. */
export default async function CaseWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['office.cases.view']}>
      <ReauthProvider>
        <CaseWorkspace id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
