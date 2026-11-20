/**
 * Breach register API client (API §30). The register holds categories and
 * counts only, never copies of affected personal data.
 */
import type {
  AddBreachEvent,
  BreachDetail,
  BreachQuery,
  BreachSummary,
  CampaignFile,
  CreateBreach,
  ExportBreachTimeline,
  Paginated,
  SignedUrlResponse,
  UpdateBreach,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

export const securityApi = {
  list: (q: Partial<BreachQuery>) => api.get<Paginated<BreachSummary>>('/security/breaches', { query: q as Q }),
  get: (id: string) => api.get<BreachDetail>(`/security/breaches/${id}`),
  create: (body: CreateBreach) => api.post<BreachDetail>('/security/breaches', body),
  update: (id: string, body: UpdateBreach) => api.patch<BreachDetail>(`/security/breaches/${id}`, body),
  addEvent: (id: string, body: AddBreachEvent) => api.post<BreachDetail>(`/security/breaches/${id}/events`, body),
  exportTimeline: (id: string, body: ExportBreachTimeline) => api.post<SignedUrlResponse>(`/security/breaches/${id}/export`, body),
  evidenceUrl: (id: string, eventId: string) => api.get<SignedUrlResponse>(`/security/breaches/${id}/events/${eventId}/evidence/url`),
  upload: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return api.post<CampaignFile>('/security/breaches/files', form);
  },
};
