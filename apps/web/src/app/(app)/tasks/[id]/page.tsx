import { TaskDetailPage } from '@/components/tasks/task-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Task' };

/** S08 Task detail. API §24. */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['tasks.view']}>
      <TaskDetailPage id={id} />
    </RequirePagePermission>
  );
}
