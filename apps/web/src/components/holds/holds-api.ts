/**
 * Display holds and redacted copies (docs/API_CONTRACT.md §35). The API serves the redacted copy
 * only, never a held original, and enforces the second-person rule on every release.
 */
import type { ConfirmDeclaredRedaction, DisplayHoldQuery, DisplayHoldSummary, Paginated, SignedUrlResponse } from '@ngao360/shared';
import { api } from '@/lib/api-client';

export const holdsApi = {
  list: (q: Partial<DisplayHoldQuery>) => api.get<Paginated<DisplayHoldSummary>>('/tally/sources/holds', { query: q as Record<string, string | number | undefined> }),
  get: (id: string) => api.get<DisplayHoldSummary>(`/tally/sources/holds/${id}`),
  redactedUrl: (id: string) => api.get<SignedUrlResponse>(`/tally/sources/holds/${id}/redacted/url`),
  attach: (id: string, file: File, reason: string) => {
    const form = new FormData();
    form.set('file', file);
    if (reason.trim()) form.set('reason', reason.trim());
    return api.post<DisplayHoldSummary>(`/tally/sources/holds/${id}/redacted-copy`, form);
  },
  confirm: (id: string, body: ConfirmDeclaredRedaction) => api.post<DisplayHoldSummary>(`/tally/sources/holds/${id}/confirm`, body),
};
