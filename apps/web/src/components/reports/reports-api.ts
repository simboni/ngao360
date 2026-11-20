/**
 * Report builder API client (API §28). Only registry datasets can be queried;
 * the API applies tenancy, scope and field permissions in the query layer.
 */
import type {
  CreateReportExport,
  DatasetDefinition,
  DatasetField,
  OkResponse,
  Paginated,
  ReportDefinition,
  ReportExport,
  ReportExportQuery,
  ReportPreview,
  ReportTemplate,
  ReportTemplateQuery,
  SaveReportTemplate,
  SignedUrlResponse,
  StandardReport,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Q = Record<string, string | number | boolean | string[] | undefined>;

/** GET /reports/datasets item: a dataset with the fields the caller may use. */
export interface AvailableDataset {
  key: string;
  label: string;
  description: string;
  group: DatasetDefinition['group'];
  fields: DatasetField[];
}

/** GET /reports/standard item. */
export type RunnableStandardReport = StandardReport & { runnable: boolean };

/** POST /reports/exports answer: the logged export plus a signed download URL. */
export type ReportExportResult = ReportExport & SignedUrlResponse;

export const reportsApi = {
  datasets: () => api.get<AvailableDataset[]>('/reports/datasets'),
  standard: () => api.get<RunnableStandardReport[]>('/reports/standard'),
  preview: (def: ReportDefinition) => api.post<ReportPreview>('/reports/preview', def),
  templates: (q: Partial<ReportTemplateQuery> = {}) => api.get<Paginated<ReportTemplate>>('/reports/templates', { query: q as Q }),
  template: (id: string) => api.get<ReportTemplate>(`/reports/templates/${id}`),
  createTemplate: (body: SaveReportTemplate) => api.post<ReportTemplate>('/reports/templates', body),
  updateTemplate: (id: string, body: SaveReportTemplate) => api.patch<ReportTemplate>(`/reports/templates/${id}`, body),
  archiveTemplate: (id: string, reason: string) => api.post<OkResponse>(`/reports/templates/${id}/archive`, { reason }),
  createExport: (body: CreateReportExport) => api.post<ReportExportResult>('/reports/exports', body),
  exports: (q: Partial<ReportExportQuery> = {}) => api.get<Paginated<ReportExport>>('/reports/exports', { query: q as Q }),
  exportUrl: (id: string) => api.get<SignedUrlResponse>(`/reports/exports/${id}/url`),
};
