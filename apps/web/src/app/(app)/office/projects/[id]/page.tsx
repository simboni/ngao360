import { Suspense } from 'react';
import { ReauthProvider } from '@/components/admin/reauth';
import { ProjectDetailView } from '@/components/office/projects/project-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Project detail' };

/** S27 Project detail. API §12. */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['office.projects.view']}>
      <ReauthProvider>
        <Suspense>
          <ProjectDetailView id={id} />
        </Suspense>
      </ReauthProvider>
    </RequirePagePermission>
  );
}
