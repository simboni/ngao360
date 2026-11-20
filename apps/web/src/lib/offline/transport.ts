/**
 * The queue's server calls, made with the normal API client (same-origin
 * `/api`, cookies, CSRF header, single refresh on 401). Paths and bodies
 * follow docs/API_CONTRACT.md §16.4, §19.2 and §22.
 */
import type { AttachEvidence, FieldEvidenceUpload, SyncRequest, SyncResponse } from '@ngao360/shared';
import { api } from '@/lib/api-client';
import type { QueueTransport } from './queue';

export const apiQueueTransport: QueueTransport = {
  sync: (items) => api.post<SyncResponse>('/field/sync', { items } satisfies SyncRequest),
  uploadEvidence: async (file, filename) => {
    const form = new FormData();
    form.set('file', file, filename);
    const res = await api.post<FieldEvidenceUpload>('/field/evidence', form);
    return { fileId: res.fileId };
  },
  attachReportEvidence: async (reportId, fileIds) => {
    await api.post(`/field/reports/${encodeURIComponent(reportId)}/evidence`, { fileIds } satisfies AttachEvidence);
  },
};
