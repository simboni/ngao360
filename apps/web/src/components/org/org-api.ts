/**
 * Organisation API client (API §23). Types come from @ngao360/shared.
 */
import type {
  AddTeamMembers,
  CreateDepartment,
  CreateTeam,
  DepartmentDetail,
  DepartmentTree,
  Paginated,
  RemoveTeamMember,
  TeamDetail,
  TeamQuery,
  TeamSummary,
  UpdateDepartment,
  UpdateTeam,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

export const orgApi = {
  tree: (includeInactive = false) => api.get<DepartmentTree>('/org/departments/tree', { query: { includeInactive } }),
  department: (id: string) => api.get<DepartmentDetail>(`/org/departments/${id}`),
  createDepartment: (body: CreateDepartment) => api.post<DepartmentDetail>('/org/departments', body),
  updateDepartment: (id: string, body: UpdateDepartment) => api.patch<DepartmentDetail>(`/org/departments/${id}`, body),
  teams: (q: Partial<TeamQuery>) => api.get<Paginated<TeamSummary>>('/org/teams', { query: q as Record<string, string> }),
  team: (id: string) => api.get<TeamDetail>(`/org/teams/${id}`),
  createTeam: (body: CreateTeam) => api.post<TeamDetail>('/org/teams', body),
  updateTeam: (id: string, body: UpdateTeam) => api.patch<TeamDetail>(`/org/teams/${id}`, body),
  addMembers: (id: string, body: AddTeamMembers) => api.post<TeamDetail>(`/org/teams/${id}/members`, body),
  removeMember: (id: string, memberId: string, body: RemoveTeamMember) => api.post<TeamDetail>(`/org/teams/${id}/members/${memberId}/remove`, body),
};
