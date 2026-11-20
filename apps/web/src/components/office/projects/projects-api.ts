/**
 * Project register API calls (docs/API_CONTRACT.md §12). Types come from
 * @ngao360/shared; the API enforces scope, transitions, separation of duties
 * and publication rules.
 */
import type {
  AuditEvent,
  CreateProject,
  CreateProjectEvidence,
  CreateProjectMilestone,
  Institution,
  InstitutionQuery,
  Paginated,
  ProjectDetail,
  ProjectEvidence,
  ProjectMilestone,
  ProjectQuery,
  ProjectSummary,
  ProjectTransition,
  PublicPortalInfo,
  PublicProjectDetail,
  SignedUrlResponse,
  UpdateProject,
  UpdateProjectMilestone,
  UpdateProjectPublication,
  VerifyProjectCompletion,
  VerifyProjectExpenditure,
  VerifyRecord,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

const p = (id: string) => `/office/projects/${encodeURIComponent(id)}`;

/** `isPublic` goes as the 'true'/'false' string the query schema expects. */
export type ProjectListQuery = Partial<Omit<ProjectQuery, 'page' | 'pageSize' | 'isPublic'>> & { page?: number; pageSize?: number; isPublic?: 'true' | 'false' };

export const projectsApi = {
  list: (query: ProjectListQuery) => api.get<Paginated<ProjectSummary>>('/office/projects', { query: query as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<ProjectDetail>(p(id)),
  create: (body: CreateProject) => api.post<ProjectDetail>('/office/projects', body),
  update: (id: string, body: UpdateProject) => api.patch<ProjectDetail>(p(id), body),
  transition: (id: string, body: ProjectTransition) => api.post<ProjectDetail>(`${p(id)}/transition`, body),
  verifyCompletion: (id: string, body: VerifyProjectCompletion) => api.post<ProjectDetail>(`${p(id)}/verify-completion`, body),
  verifyExpenditure: (id: string, body: VerifyProjectExpenditure) => api.post<ProjectDetail>(`${p(id)}/verify-expenditure`, body),
  addMilestone: (id: string, body: CreateProjectMilestone) => api.post<ProjectMilestone>(`${p(id)}/milestones`, body),
  updateMilestone: (id: string, milestoneId: string, body: UpdateProjectMilestone) =>
    api.patch<ProjectMilestone>(`${p(id)}/milestones/${encodeURIComponent(milestoneId)}`, body),
  verifyMilestone: (id: string, milestoneId: string, body: VerifyRecord) =>
    api.post<ProjectMilestone>(`${p(id)}/milestones/${encodeURIComponent(milestoneId)}/verify`, body),
  addEvidence: (id: string, file: File, metadata: CreateProjectEvidence) => {
    const form = new FormData();
    form.set('file', file);
    form.set('metadata', JSON.stringify(metadata));
    return api.post<ProjectEvidence>(`${p(id)}/evidence`, form);
  },
  verifyEvidence: (id: string, evidenceId: string, body: VerifyRecord) =>
    api.post<ProjectEvidence>(`${p(id)}/evidence/${encodeURIComponent(evidenceId)}/verify`, body),
  evidenceUrl: (id: string, evidenceId: string, download = false) =>
    api.get<SignedUrlResponse>(`${p(id)}/evidence/${encodeURIComponent(evidenceId)}/url`, { query: download ? { download: 1 } : undefined }),
  publish: (id: string, body: UpdateProjectPublication) => api.put<ProjectDetail>(`${p(id)}/publication`, body),
  publicPreview: (id: string) => api.get<PublicProjectDetail>(`${p(id)}/public-preview`),
  history: (id: string) => api.get<AuditEvent[]>(`${p(id)}/history`),
  institutions: (query: { q?: string; type?: InstitutionQuery['type']; active?: 'true' | 'false' } = {}) =>
    api.get<Paginated<Institution>>('/office/institutions', { query: { pageSize: 200, ...query } as Record<string, string | number | undefined> }),
  /**
   * Constituencies and wards for filters and forms. Office roles do not hold
   * `reference.view`, so this reads the tenant's public portal description
   * (public data); it fails when the portal is off, and callers then hide the
   * geography filter. See docs/CHANGE_REQUESTS.md (Office geography lookup).
   */
  portalGeography: (tenantSlug: string) => api.get<PublicPortalInfo>(`/public/${encodeURIComponent(tenantSlug)}/portal`, { noRefresh: true }),
};
