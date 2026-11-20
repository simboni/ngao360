import { PortalGate } from '@/components/public/portal-ui';
import { ProjectDetailView } from '@/components/public/project-detail';

export const metadata = { title: 'Project' };

/** Public project view. API §13.4: approved public fields only. */
export default async function PublicProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PortalGate>
      <ProjectDetailView id={id} />
    </PortalGate>
  );
}
