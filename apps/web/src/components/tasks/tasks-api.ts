/**
 * Task API client (API §24). Types come from @ngao360/shared.
 */
import type {
  AddTaskAttachment,
  AddTaskComment,
  AddTaskDependency,
  AssignTask,
  ChangeTaskStatus,
  CreateTask,
  Paginated,
  ReviewTask,
  SaveTaskChecklist,
  SignedUrlResponse,
  TaskAttachment,
  TaskBoard,
  TaskCalendarQuery,
  TaskComment,
  TaskDetail,
  TaskQuery,
  TaskSummary,
  TaskWorkload,
  UpdateTask,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

export const tasksApi = {
  list: (q: Partial<TaskQuery>) => api.get<Paginated<TaskSummary>>('/tasks', { query: q as Q }),
  board: (q: Partial<TaskQuery>) => api.get<TaskBoard>('/tasks/board', { query: q as Q }),
  calendar: (q: TaskCalendarQuery) => api.get<TaskSummary[]>('/tasks/calendar', { query: q as unknown as Q }),
  workload: (q: Partial<TaskQuery>) => api.get<TaskWorkload>('/tasks/workload', { query: q as Q }),
  get: (id: string) => api.get<TaskDetail>(`/tasks/${id}`),
  create: (body: CreateTask) => api.post<TaskDetail>('/tasks', body),
  update: (id: string, body: UpdateTask) => api.patch<TaskDetail>(`/tasks/${id}`, body),
  assign: (id: string, body: AssignTask) => api.post<TaskDetail>(`/tasks/${id}/assign`, body),
  status: (id: string, body: ChangeTaskStatus) => api.post<TaskDetail>(`/tasks/${id}/status`, body),
  review: (id: string, body: ReviewTask) => api.post<TaskDetail>(`/tasks/${id}/review`, body),
  addDependency: (id: string, body: AddTaskDependency) => api.post<TaskDetail>(`/tasks/${id}/dependencies`, body),
  removeDependency: (id: string, dependsOnTaskId: string) => api.delete<TaskDetail>(`/tasks/${id}/dependencies/${dependsOnTaskId}`),
  saveChecklist: (id: string, body: SaveTaskChecklist) => api.put<TaskDetail>(`/tasks/${id}/checklist`, body),
  comment: (id: string, body: AddTaskComment) => api.post<TaskComment>(`/tasks/${id}/comments`, body),
  attach: (id: string, body: AddTaskAttachment) => api.post<TaskAttachment>(`/tasks/${id}/attachments`, body),
  attachmentUrl: (id: string, attachmentId: string) => api.get<SignedUrlResponse>(`/tasks/${id}/attachments/${attachmentId}/url`),
};
