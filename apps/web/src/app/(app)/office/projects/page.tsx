import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Projects' };

/** S26 Project register. API §12. Owner: projects agent (components/office/projects). */
export default function ProjectsPage() {
  return (
    <ModulePlaceholder
      title="Project register"
      screen="S26 Project register"
      description="Commitments and projects with the responsible institution, funding source, milestone, evidence and verification label."
      breadcrumbs={[{ label: 'Office' }, { label: 'Projects' }]}
      anyOf={['office.projects.view']}
    />
  );
}
