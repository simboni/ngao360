import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Tasks' };

/** S08 Task board. */
export default function TasksPage() {
  return (
    <ModulePlaceholder
      title="Tasks"
      screen="S08 Task board"
      description="Board, list, calendar and workload views of tasks in your departments and area: owner, reviewer, priority, due date, dependencies, checklist progress and source record. API §24."
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Tasks' }]}
      anyOf={['tasks.view']}
    />
  );
}
