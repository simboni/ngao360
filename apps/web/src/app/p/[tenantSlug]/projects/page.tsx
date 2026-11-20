import { Suspense } from 'react';
import { PortalGate } from '@/components/public/portal-ui';
import { ProjectList } from '@/components/public/project-list';

export const metadata = { title: 'Development projects' };

/** Public project list. API §13.4. */
export default function PublicProjectsPage() {
  return (
    <PortalGate>
      <Suspense>
        <ProjectList />
      </Suspense>
    </PortalGate>
  );
}
