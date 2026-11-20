import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Project detail' };

/** S27 Project detail. API §12. */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Project detail"
      screen="S27 Project detail"
      description={`Project ${id}: summary, milestones, documents, photographs, financial fields, update history and public view.`}
      breadcrumbs={[{ label: 'Office' }, { label: 'Projects', href: '/office/projects' }, { label: 'Project' }]}
      anyOf={['office.projects.view']}
    />
  );
}
