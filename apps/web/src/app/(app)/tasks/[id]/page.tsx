import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Task' };

/** S08 Task detail. */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Task"
      screen="S08 Task detail"
      description={`Task ${id}: description and acceptance criteria, owner, collaborators and reviewer, dependencies, checklist, comments, attachments, completion evidence and the activity timeline.`}
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Tasks', href: '/tasks' }, { label: 'Task' }]}
      anyOf={['tasks.view']}
    />
  );
}
