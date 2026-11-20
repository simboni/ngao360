/**
 * Organisation structure DTOs (blueprint 5.1, S05): departments (tree) and
 * teams with members. API contract §23.
 */
import { z } from 'zod';
import { GeoRefSchema } from '../office/common';
import { IsoDateSchema, IsoDateTimeSchema, PaginationQuerySchema, ReasonSchema, UserRefSchema, UuidSchema, QueryBooleanSchema } from '../schemas/common';
import { CampaignExpectedVersionSchema, DepartmentRefSchema } from './common';
import {
  DepartmentVisibilitySchema,
  TeamContactChannelSchema,
  TeamMemberRoleSchema,
  TeamStatusSchema,
} from './enums';

const CodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,23}$/, 'Use 2–24 capital letters, digits, "-" or "_", e.g. FIN or FIELD-OPS');

/* -------------------------------- Departments ------------------------------- */

export const DepartmentSummarySchema = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  lead: UserRefSchema.nullable(),
  parentId: UuidSchema.nullable(),
  /** Depth in the tree (0 = top level). */
  depth: z.number().int(),
  budgetCode: z.string().nullable(),
  activeFrom: IsoDateSchema.nullable(),
  activeTo: IsoDateSchema.nullable(),
  /** False outside [activeFrom, activeTo]. */
  isActive: z.boolean(),
  visibility: DepartmentVisibilitySchema,
  teamCount: z.number().int(),
  childCount: z.number().int(),
  version: z.number().int(),
});
export type DepartmentSummary = z.infer<typeof DepartmentSummarySchema>;

export interface DepartmentTreeNode extends DepartmentSummary {
  children: DepartmentTreeNode[];
}
export const DepartmentTreeNodeSchema: z.ZodType<DepartmentTreeNode> = DepartmentSummarySchema.extend({
  children: z.lazy(() => z.array(DepartmentTreeNodeSchema)),
});

export const DepartmentTreeSchema = z.object({
  roots: z.array(DepartmentTreeNodeSchema),
  /** Departments the caller may act on (lead, or `org.departments.manage` in scope). */
  manageableIds: z.array(UuidSchema),
});
export type DepartmentTree = z.infer<typeof DepartmentTreeSchema>;

export const DepartmentDetailSchema = DepartmentSummarySchema.extend({
  parent: DepartmentRefSchema.nullable(),
  path: z.array(DepartmentRefSchema),
  teams: z.array(z.lazy(() => TeamSummarySchema)),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(['EDIT', 'MOVE', 'ADD_TEAM', 'ADD_CHILD'])),
});
export type DepartmentDetail = z.infer<typeof DepartmentDetailSchema>;

const DepartmentFieldsSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  leadUserId: UuidSchema.nullable().optional(),
  parentId: UuidSchema.nullable().optional(),
  budgetCode: z.string().trim().max(40).nullable().optional(),
  activeFrom: IsoDateSchema.nullable().optional(),
  activeTo: IsoDateSchema.nullable().optional(),
  visibility: DepartmentVisibilitySchema.default('ORGANISATION'),
});

const activeRange = (v: { activeFrom?: string | null; activeTo?: string | null }) =>
  !v.activeFrom || !v.activeTo || v.activeFrom <= v.activeTo;

export const CreateDepartmentSchema = DepartmentFieldsSchema.refine(activeRange, {
  message: 'activeTo must be on or after activeFrom',
  path: ['activeTo'],
});
export type CreateDepartment = z.infer<typeof CreateDepartmentSchema>;

/** Moving a department (parentId) re-checks for cycles (409 CONFLICT) and rewrites descendant paths. */
export const UpdateDepartmentSchema = DepartmentFieldsSchema.partial()
  .extend({ expectedVersion: CampaignExpectedVersionSchema, reason: ReasonSchema.optional() })
  .refine(activeRange, { message: 'activeTo must be on or after activeFrom', path: ['activeTo'] });
export type UpdateDepartment = z.infer<typeof UpdateDepartmentSchema>;

export const DepartmentQuerySchema = z.object({
  includeInactive: QueryBooleanSchema.default(false),
});
export type DepartmentQuery = z.infer<typeof DepartmentQuerySchema>;

/* ----------------------------------- Teams ---------------------------------- */

export const TeamMemberSchema = z.object({
  id: UuidSchema,
  user: UserRefSchema,
  role: TeamMemberRoleSchema,
  joinedAt: IsoDateTimeSchema,
  /** Set when the member left; the row is kept as history. */
  leftAt: IsoDateTimeSchema.nullable(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  department: DepartmentRefSchema,
  coordinator: UserRefSchema.nullable(),
  geography: GeoRefSchema.nullable(),
  contactChannel: TeamContactChannelSchema,
  /** Internal coordination detail (e.g. group name); never a public or voter list. */
  contactDetail: z.string().nullable(),
  status: TeamStatusSchema,
  memberCount: z.number().int(),
  version: z.number().int(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const TeamDetailSchema = TeamSummarySchema.extend({
  members: z.array(TeamMemberSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  allowedActions: z.array(z.enum(['EDIT', 'MANAGE_MEMBERS', 'ARCHIVE'])),
});
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

export const TeamQuerySchema = PaginationQuerySchema.extend({
  departmentId: UuidSchema.optional(),
  status: TeamStatusSchema.optional(),
  geographicUnitId: UuidSchema.optional(),
  mine: QueryBooleanSchema.optional(),
});
export type TeamQuery = z.infer<typeof TeamQuerySchema>;

export const CreateTeamSchema = z.object({
  name: z.string().trim().min(2).max(120),
  departmentId: UuidSchema,
  coordinatorUserId: UuidSchema.nullable().optional(),
  geographicUnitId: UuidSchema.nullable().optional(),
  contactChannel: TeamContactChannelSchema.default('IN_APP'),
  contactDetail: z.string().trim().max(200).nullable().optional(),
});
export type CreateTeam = z.infer<typeof CreateTeamSchema>;

export const UpdateTeamSchema = CreateTeamSchema.partial().extend({
  status: TeamStatusSchema.optional(),
  expectedVersion: CampaignExpectedVersionSchema,
  reason: ReasonSchema.optional(),
});
export type UpdateTeam = z.infer<typeof UpdateTeamSchema>;

/** Add (or re-add) members; existing active members keep their row. */
export const AddTeamMembersSchema = z.object({
  members: z.array(z.object({ userId: UuidSchema, role: TeamMemberRoleSchema.default('MEMBER') })).min(1).max(100),
});
export type AddTeamMembers = z.infer<typeof AddTeamMembersSchema>;

/** Removing a member sets `left_at` (history kept). */
export const RemoveTeamMemberSchema = z.object({ reason: ReasonSchema.optional() });
export type RemoveTeamMember = z.infer<typeof RemoveTeamMemberSchema>;

export const TeamMemberParamSchema = z.object({ id: UuidSchema, memberId: UuidSchema });
export type TeamMemberParam = z.infer<typeof TeamMemberParamSchema>;

/** People a caller may pick as lead / coordinator / owner (active users of the tenant, name only). */
export const AssignableUserSchema = UserRefSchema.extend({
  departmentIds: z.array(UuidSchema),
  teamIds: z.array(UuidSchema),
});
export type AssignableUser = z.infer<typeof AssignableUserSchema>;
export const AssignableUserQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  departmentId: UuidSchema.optional(),
  teamId: UuidSchema.optional(),
  /** Only users holding this permission (e.g. tasks.review for reviewers). */
  permission: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AssignableUserQuery = z.infer<typeof AssignableUserQuerySchema>;
