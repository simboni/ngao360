/**
 * Communications content API client (API §26). Types come from @ngao360/shared.
 */
import type { ContentDetail, ContentQuery, ContentSummary, ContentTransition, CorrectContent, CreateContent, Paginated, UpdateContent } from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

export const commsApi = {
  list: (q: Partial<ContentQuery>) => api.get<Paginated<ContentSummary>>('/comms/content', { query: q as Q }),
  get: (id: string) => api.get<ContentDetail>(`/comms/content/${id}`),
  create: (body: CreateContent) => api.post<ContentDetail>('/comms/content', body),
  update: (id: string, body: UpdateContent) => api.patch<ContentDetail>(`/comms/content/${id}`, body),
  transition: (id: string, body: ContentTransition) => api.post<ContentDetail>(`/comms/content/${id}/transition`, body),
  correct: (id: string, body: CorrectContent) => api.post<ContentDetail>(`/comms/content/${id}/correct`, body),
};
