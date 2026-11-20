/**
 * Correspondence API calls (docs/API_CONTRACT.md §9). Types come from
 * @ngao360/shared; the API enforces permissions, confidentiality and transitions.
 */
import type {
  AddCorrespondenceAttachment,
  AssignCorrespondence,
  AuditEvent,
  CorrespondenceAttachment,
  CorrespondenceDetail,
  CorrespondenceQuery,
  CorrespondenceSummary,
  CorrespondenceTransition,
  CreateCorrespondence,
  Paginated,
  SignedUrlResponse,
  UpdateCorrespondence,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

const c = (id: string) => `/office/correspondence/${encodeURIComponent(id)}`;

export type CorrespondenceListQuery = Partial<Omit<CorrespondenceQuery, 'page' | 'pageSize'>> & { page?: number; pageSize?: number };

export const correspondenceApi = {
  list: (query: CorrespondenceListQuery) =>
    api.get<Paginated<CorrespondenceSummary>>('/office/correspondence', { query: query as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<CorrespondenceDetail>(c(id)),
  create: (body: CreateCorrespondence) => api.post<CorrespondenceDetail>('/office/correspondence', body),
  update: (id: string, body: UpdateCorrespondence) => api.patch<CorrespondenceDetail>(c(id), body),
  assign: (id: string, body: AssignCorrespondence) => api.post<CorrespondenceDetail>(`${c(id)}/assign`, body),
  transition: (id: string, body: CorrespondenceTransition) => api.post<CorrespondenceDetail>(`${c(id)}/transition`, body),
  attach: (id: string, file: File, metadata: AddCorrespondenceAttachment) => {
    const form = new FormData();
    form.set('file', file);
    form.set('metadata', JSON.stringify(metadata));
    return api.post<CorrespondenceAttachment>(`${c(id)}/attachments`, form);
  },
  attachmentUrl: (id: string, attachmentId: string, download = false) =>
    api.get<SignedUrlResponse>(`${c(id)}/attachments/${encodeURIComponent(attachmentId)}/url`, { query: download ? { download: 1 } : undefined }),
  history: (id: string) => api.get<AuditEvent[]>(`${c(id)}/history`),
};
