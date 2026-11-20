import { Suspense } from 'react';
import { ProjectRegister } from '@/components/office/projects/project-register';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Projects' };

/** S26 Project register. API §12. */
export default function ProjectsPage() {
  return (
    <RequirePagePermission anyOf={['office.projects.view']}>
      <Suspense>
        <ProjectRegister />
      </Suspense>
    </RequirePagePermission>
  );
}
