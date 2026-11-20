/**
 * Citizen case API calls (docs/API_CONTRACT.md §11). Every response type is
 * from @ngao360/shared; the API is the authority on permissions, scope,
 * transitions and separation of duties.
 */
import type {
  AddCaseEvent,
  AddCaseEvidence,
  AssignCase,
  AuditEvent,
  CaseContact,
  CaseDetail,
  CaseEvent,
  CaseQuery,
  CaseReferral,
  CaseSummary,
  CaseTransition,
  CloseCase,
  CreateCase,
  CreateCaseReferral,
  CreateCaseResponse,
  EraseCaseContact,
  Institution,
  InstitutionQuery,
  Paginated,
  ProposeCaseResolution,
  PublicPortalInfo,
  ReopenCase,
  SignedUrlResponse,
  UpdateCase,
  UpdateCaseReferral,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

const c = (id: string) => `/office/cases/${encodeURIComponent(id)}`;

export type CaseListQuery = Partial<Omit<CaseQuery, 'page' | 'pageSize'>> & { page?: number; pageSize?: number };

export const casesApi = {
  list: (query: CaseListQuery) => api.get<Paginated<CaseSummary>>('/office/cases', { query: query as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<CaseDetail>(c(id)),
  create: (body: CreateCase) => api.post<CreateCaseResponse>('/office/cases', body),
  update: (id: string, body: UpdateCase) => api.patch<CaseDetail>(c(id), body),
  assign: (id: string, body: AssignCase) => api.post<CaseDetail>(`${c(id)}/assign`, body),
  transition: (id: string, body: CaseTransition) => api.post<CaseDetail>(`${c(id)}/transition`, body),
  addEvent: (id: string, body: AddCaseEvent) => api.post<CaseEvent>(`${c(id)}/events`, body),
  addEvidence: (id: string, file: File, metadata: AddCaseEvidence) => {
    const form = new FormData();
    form.set('file', file);
    form.set('metadata', JSON.stringify(metadata));
    return api.post<CaseEvent>(`${c(id)}/evidence`, form);
  },
  fileUrl: (id: string, fileId: string, download = false) =>
    api.get<SignedUrlResponse>(`${c(id)}/files/${encodeURIComponent(fileId)}/url`, { query: download ? { download: 1 } : undefined }),
  contact: (id: string) => api.get<CaseContact>(`${c(id)}/contact`),
  eraseContact: (id: string, body: EraseCaseContact) => api.post<CaseContact>(`${c(id)}/contact/erase`, body),
  referrals: (id: string) => api.get<CaseReferral[]>(`${c(id)}/referrals`),
  refer: (id: string, body: CreateCaseReferral) => api.post<CaseDetail>(`${c(id)}/referrals`, body),
  updateReferral: (id: string, referralId: string, body: UpdateCaseReferral) =>
    api.patch<CaseReferral>(`${c(id)}/referrals/${encodeURIComponent(referralId)}`, body),
  proposeResolution: (id: string, body: ProposeCaseResolution) => api.post<CaseDetail>(`${c(id)}/propose-resolution`, body),
  close: (id: string, body: CloseCase) => api.post<CaseDetail>(`${c(id)}/close`, body),
  reopen: (id: string, body: ReopenCase) => api.post<CaseDetail>(`${c(id)}/reopen`, body),
  history: (id: string) => api.get<AuditEvent[]>(`${c(id)}/history`),
  /** `active` is sent as the string the query schema expects ('true' / 'false'). */
  institutions: (query: { q?: string; type?: InstitutionQuery['type']; active?: 'true' | 'false' }) =>
    api.get<Paginated<Institution>>('/office/institutions', { query: { pageSize: 200, ...query } as Record<string, string | number | undefined> }),
  /**
   * Constituencies and wards for filters and forms. Office roles do not hold
   * `reference.view`, so this reuses the tenant's public portal description
   * (public data). It fails when the portal is switched off; callers then hide
   * the geography filter and ask for a landmark instead.
   */
  portalGeography: (tenantSlug: string) => api.get<PublicPortalInfo>(`/public/${encodeURIComponent(tenantSlug)}/portal`, { noRefresh: true }),
};
