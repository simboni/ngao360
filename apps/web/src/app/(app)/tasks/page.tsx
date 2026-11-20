import { TaskBoardScreen } from '@/components/tasks/task-board';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Tasks' };

/** S08 Task board (board, list, calendar and workload views). API §24. */
export default function TasksPage() {
  return (
    <RequirePagePermission anyOf={['tasks.view']}>
      <TaskBoardScreen />
    </RequirePagePermission>
  );
}
