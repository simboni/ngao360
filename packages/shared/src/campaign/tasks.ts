/**
 * Task DTOs (blueprint 5.2, S08): board / list / calendar / workload views,
 * accountable owner, collaborators, reviewer, dependencies, checklist,
 * comments, attachments, completion evidence and the append-only timeline.
 * API contract §24.
 */
import { z } from 'zod';
import { GeoRefSchema } from '../office/common';
import { IsoDateTimeSchema, PaginationQuerySchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema, CampaignFileSchema, DepartmentRefSchema, TeamRefSchema } from './common';
import {
  TaskAttachmentKindSchema,
  TaskEventTypeSchema,
  TaskPrioritySchema,
  TaskSourceTypeSchema,
  TaskStatusSchema,
  type TaskStatus,
} from './enums';

export const TaskSourceSchema = z.object({
  type: TaskSourceTypeSchema,
  /** Id of the source record (project, event, incident, case); null for DASHBOARD. */
  id: UuidSchema.nullable(),
  /** Reference shown on the card, e.g. EVT-2027-000004 (resolved at write time). */
  label: z.string().nullable(),
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TaskRefSchema = z.object({ id: UuidSchema, reference: z.string(), title: z.string(), status: TaskStatusSchema });
export type TaskRef = z.infer<typeof TaskRefSchema>;

export const TaskSummarySchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  owner: UserRefSchema,
  reviewer: UserRefSchema.nullable(),
  collaboratorCount: z.number().int(),
  department: DepartmentRefSchema.nullable(),
  team: TeamRefSchema.nullable(),
  geography: GeoRefSchema.nullable(),
  startAt: IsoDateTimeSchema.nullable(),
  dueAt: IsoDateTimeSchema.nullable(),
  /** dueAt in the past and status open. */
  isOverdue: z.boolean(),
  /** Number of dependencies not yet COMPLETED. */
  openDependencyCount: z.number().int(),
  checklist: z.object({ done: z.number().int(), total: z.number().int() }),
  source: TaskSourceSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  version: z.number().int(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskChecklistItemSchema = z.object({
  id: UuidSchema,
  label: z.string(),
  position: z.number().int(),
  isDone: z.boolean(),
  doneBy: UserRefSchema.nullable(),
  doneAt: IsoDateTimeSchema.nullable(),
});
export type TaskChecklistItem = z.infer<typeof TaskChecklistItemSchema>;

export const TaskCommentSchema = z.object({ id: UuidSchema, author: UserRefSchema, body: z.string(), createdAt: IsoDateTimeSchema });
export type TaskComment = z.infer<typeof TaskCommentSchema>;

export const TaskAttachmentSchema = z.object({
  id: UuidSchema,
  kind: TaskAttachmentKindSchema,
  note: z.string().nullable(),
  file: CampaignFileSchema,
  addedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
});
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;

export const TaskEventSchema = z.object({
  id: UuidSchema,
  type: TaskEventTypeSchema,
  fromStatus: TaskStatusSchema.nullable(),
  toStatus: TaskStatusSchema.nullable(),
  actor: UserRefSchema,
  note: z.string().nullable(),
  /** Changed field names / ids (never file contents). */
  data: z.record(z.unknown()).nullable(),
  createdAt: IsoDateTimeSchema,
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TASK_ALLOWED_ACTIONS = [
  'EDIT',
  'ASSIGN',
  'CHANGE_STATUS',
  'SUBMIT_FOR_REVIEW',
  'REVIEW',
  'COMMENT',
  'ATTACH',
  'ADD_EVIDENCE',
  'MANAGE_DEPENDENCIES',
  'MANAGE_CHECKLIST',
  'CANCEL',
] as const;
export const TaskAllowedActionSchema = z.enum(TASK_ALLOWED_ACTIONS);

export const TaskDetailSchema = TaskSummarySchema.extend({
  description: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
  collaborators: z.array(UserRefSchema),
  createdBy: UserRefSchema,
  dependencies: z.array(TaskRefSchema),
  /** Tasks that depend on this one. */
  dependents: z.array(TaskRefSchema),
  checklistItems: z.array(TaskChecklistItemSchema),
  comments: z.array(TaskCommentSchema),
  attachments: z.array(TaskAttachmentSchema),
  timeline: z.array(TaskEventSchema),
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  allowedActions: z.array(TaskAllowedActionSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TASK_VIEWS = ['board', 'list', 'calendar', 'workload'] as const;
export const TaskQuerySchema = PaginationQuerySchema.extend({
  status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
  priority: TaskPrioritySchema.optional(),
  ownerId: UuidSchema.optional(),
  reviewerId: UuidSchema.optional(),
  departmentId: UuidSchema.optional(),
  teamId: UuidSchema.optional(),
  geographicUnitId: UuidSchema.optional(),
  /** mine = owner or collaborator; review = awaiting my review; overdue = past due and open. */
  view: z.enum(['all', 'mine', 'review', 'overdue']).default('all'),
  dueFrom: IsoDateTimeSchema.optional(),
  dueTo: IsoDateTimeSchema.optional(),
  sourceType: TaskSourceTypeSchema.optional(),
  sourceId: UuidSchema.optional(),
});
export type TaskQuery = z.infer<typeof TaskQuerySchema>;

/** Board view: one column per status with the first N cards (S08). */
export const TaskBoardSchema = z.object({
  columns: z.array(z.object({ status: TaskStatusSchema, total: z.number().int(), items: z.array(TaskSummarySchema) })),
});
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

/** Workload view: open tasks per owner (counts only, in the caller's scope). */
export const TaskWorkloadSchema = z.object({
  rows: z.array(
    z.object({
      owner: UserRefSchema,
      open: z.number().int(),
      overdue: z.number().int(),
      blocked: z.number().int(),
      awaitingReview: z.number().int(),
      dueThisWeek: z.number().int(),
    }),
  ),
  asOf: IsoDateTimeSchema,
});
export type TaskWorkload = z.infer<typeof TaskWorkloadSchema>;

const dueAfterStart = (v: { startAt?: string | null; dueAt?: string | null }) => !v.startAt || !v.dueAt || v.startAt <= v.dueAt;

export const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(10000).nullable().optional(),
    acceptanceCriteria: z.string().trim().max(5000).nullable().optional(),
    ownerId: UuidSchema,
    collaboratorIds: z.array(UuidSchema).max(30).default([]),
    reviewerId: UuidSchema.nullable().optional(),
    priority: TaskPrioritySchema.default('NORMAL'),
    status: z.enum(['DRAFT', 'READY']).default('DRAFT'),
    startAt: IsoDateTimeSchema.nullable().optional(),
    dueAt: IsoDateTimeSchema.nullable().optional(),
    departmentId: UuidSchema.nullable().optional(),
    teamId: UuidSchema.nullable().optional(),
    geographicUnitId: UuidSchema.nullable().optional(),
    dependsOnTaskIds: z.array(UuidSchema).max(30).default([]),
    checklist: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
    source: z.object({ type: TaskSourceTypeSchema, id: UuidSchema.nullable().optional() }).nullable().optional(),
  })
  .refine(dueAfterStart, { message: 'dueAt must be on or after startAt', path: ['dueAt'] })
  .refine((v) => !v.reviewerId || v.reviewerId !== v.ownerId, { message: 'The reviewer must be someone other than the owner', path: ['reviewerId'] });
export type CreateTask = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    acceptanceCriteria: z.string().trim().max(5000).nullable().optional(),
    priority: TaskPrioritySchema.optional(),
    startAt: IsoDateTimeSchema.nullable().optional(),
    dueAt: IsoDateTimeSchema.nullable().optional(),
    departmentId: UuidSchema.nullable().optional(),
    teamId: UuidSchema.nullable().optional(),
    geographicUnitId: UuidSchema.nullable().optional(),
    expectedVersion: CampaignExpectedVersionSchema,
  })
  .refine(dueAfterStart, { message: 'dueAt must be on or after startAt', path: ['dueAt'] });
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

/** Owner / reviewer / collaborators (tasks.assign). Owner ≠ reviewer. */
export const AssignTaskSchema = z
  .object({
    ownerId: UuidSchema.optional(),
    reviewerId: UuidSchema.nullable().optional(),
    collaboratorIds: z.array(UuidSchema).max(30).optional(),
    expectedVersion: CampaignExpectedVersionSchema,
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => !v.ownerId || !v.reviewerId || v.ownerId !== v.reviewerId, {
    message: 'The reviewer must be someone other than the owner',
    path: ['reviewerId'],
  });
export type AssignTask = z.infer<typeof AssignTaskSchema>;

/** Status change (not review decisions, which use ReviewTask). BLOCKED and CANCELLED need a reason. */
export const ChangeTaskStatusSchema = z
  .object({
    toStatus: TaskStatusSchema,
    reason: z.string().trim().max(2000).optional(),
    expectedVersion: CampaignExpectedVersionSchema,
  })
  .refine((v) => !['BLOCKED', 'CANCELLED'].includes(v.toStatus) || (v.reason?.length ?? 0) >= 3, {
    message: 'Give a reason for blocking or cancelling',
    path: ['reason'],
  });
export type ChangeTaskStatus = z.infer<typeof ChangeTaskStatusSchema>;

/** Reviewer decision on a SUBMITTED_FOR_REVIEW task (reviewer ≠ owner; 403 SEPARATION_OF_DUTIES). */
export const ReviewTaskSchema = z.object({
  decision: z.enum(['APPROVE', 'RETURN']),
  note: z.string().trim().max(2000).optional(),
  expectedVersion: CampaignExpectedVersionSchema,
}).refine((v) => v.decision === 'APPROVE' || (v.note?.length ?? 0) >= 3, { message: 'Say what needs to change', path: ['note'] });
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

export const AddTaskDependencySchema = z.object({ dependsOnTaskId: UuidSchema });
export type AddTaskDependency = z.infer<typeof AddTaskDependencySchema>;
export const TaskDependencyParamSchema = z.object({ id: UuidSchema, dependsOnTaskId: UuidSchema });
export type TaskDependencyParam = z.infer<typeof TaskDependencyParamSchema>;

export const SaveTaskChecklistSchema = z.object({
  items: z
    .array(z.object({ id: UuidSchema.optional(), label: z.string().trim().min(1).max(300), isDone: z.boolean().default(false) }))
    .max(50),
  expectedVersion: CampaignExpectedVersionSchema,
});
export type SaveTaskChecklist = z.infer<typeof SaveTaskChecklistSchema>;

export const AddTaskCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) });
export type AddTaskComment = z.infer<typeof AddTaskCommentSchema>;

export const AddTaskAttachmentSchema = z.object({
  fileId: UuidSchema,
  kind: TaskAttachmentKindSchema.default('ATTACHMENT'),
  note: z.string().trim().max(500).optional(),
});
export type AddTaskAttachment = z.infer<typeof AddTaskAttachmentSchema>;

export const TaskCalendarQuerySchema = z.object({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  departmentId: UuidSchema.optional(),
  teamId: UuidSchema.optional(),
  ownerId: UuidSchema.optional(),
});
export type TaskCalendarQuery = z.infer<typeof TaskCalendarQuerySchema>;

/* --------------------------------- Helpers --------------------------------- */

/**
 * True when adding `taskId → dependsOnId` would create a cycle in `edges`
 * (pairs of [task, dependsOn]). Used before inserting a dependency (409 CONFLICT).
 */
export function wouldCreateDependencyCycle(edges: ReadonlyArray<readonly [string, string]>, taskId: string, dependsOnId: string): boolean {
  if (taskId === dependsOnId) return true;
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

/** A task cannot start (IN_PROGRESS) or complete while a dependency is not COMPLETED. */
export function dependenciesSatisfied(dependencyStatuses: readonly TaskStatus[]): boolean {
  return dependencyStatuses.every((s) => s === 'COMPLETED');
}
