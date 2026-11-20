/**
 * Typed wrappers for the NGAO TALLY and reference endpoints used by the tally
 * screens. Every path, request and response type follows docs/API_CONTRACT.md
 * §4 and §5. The API enforces permissions, geography scope and separation of
 * duties on every call; nothing here is a security control.
 */
import type {
  AggregateQuery,
  AssignDiscrepancy,
  AuditEvent,
  CandidateReference,
  CloseDiscrepancy,
  Contest,
  CreateDiscrepancy,
  CreateExport,
  CreateSnapshot,
  CreateSubmission,
  CreateVerification,
  DiscrepancyCaseAction,
  DiscrepancyCaseDetail,
  DiscrepancyCaseSummary,
  DiscrepancyQuery,
  DiscrepancyTransition,
  ElectionCycle,
  FormTemplate,
  GeographicUnit,
  GeographicUnitType,
  GeographyBreakdown,
  LiveAggregate,
  Paginated,
  PollingStation,
  ResolveDiscrepancy,
  ResultValueChange,
  SaveCapture,
  SignedUrlResponse,
  SubmissionDetail,
  SubmissionQuery,
  SubmissionSummary,
  SubmissionTransition,
  SupervisorActionRequest,
  TallyCentre,
  TallyExport,
  TallySnapshot,
  ValidationRun,
  Verification,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';
import type { StationCoverageRow, StationCoverageStatus } from './types';

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

/** Drop undefined/empty values so the query string stays clean. */
function q(obj: object): Query {
  const out: Query = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v as Query[string];
  }
  return out;
}

export const tallyApi = {
  /* ------------------------------ Reference -------------------------------- */
  electionCycles: () => api.get<Paginated<ElectionCycle>>('/reference/election-cycles', { query: { pageSize: 100 } }),
  contests: (electionCycleId: string) =>
    api.get<Paginated<Contest>>('/reference/contests', { query: { electionCycleId, pageSize: 200 } }),
  candidates: (contestId: string) => api.get<CandidateReference[]>(`/reference/contests/${contestId}/candidates`),
  formTemplates: (electionCycleId: string, contestType?: string) =>
    api.get<Paginated<FormTemplate>>('/reference/form-templates', {
      query: q({ electionCycleId, contestType, approvalState: 'APPROVED', pageSize: 100 }),
    }),
  formTemplate: (id: string) => api.get<FormTemplate>(`/reference/form-templates/${id}`),
  geographicUnits: (electionCycleId: string, type: GeographicUnitType, parentId?: string) =>
    api.get<Paginated<GeographicUnit>>('/reference/geographic-units', {
      query: q({ electionCycleId, type, parentId, pageSize: 200, sort: 'officialName', order: 'asc' }),
    }),
  geographicUnit: (id: string) => api.get<GeographicUnit>(`/reference/geographic-units/${id}`),
  pollingStations: (electionCycleId: string, wardId: string, search?: string) =>
    api.get<Paginated<PollingStation>>('/reference/polling-stations', {
      query: q({ electionCycleId, wardId, q: search, pageSize: 200 }),
    }),
  tallyCentres: (electionCycleId: string, level?: string) =>
    api.get<Paginated<TallyCentre>>('/reference/tally-centres', { query: q({ electionCycleId, level, pageSize: 200 }) }),

  /* ------------------------------ Submissions ------------------------------ */
  submissions: (query: Partial<SubmissionQuery>) =>
    api.get<Paginated<SubmissionSummary>>('/tally/submissions', { query: q(query) }),
  submission: (id: string) => api.get<SubmissionDetail>(`/tally/submissions/${id}`),
  createSubmission: (file: File, metadata: CreateSubmission) => {
    const form = new FormData();
    form.set('file', file);
    form.set('metadata', JSON.stringify(metadata));
    return api.post<SubmissionDetail>('/tally/submissions', form);
  },
  sourceUrl: (id: string, download = false) =>
    api.get<SignedUrlResponse>(`/tally/submissions/${id}/source-url`, { query: download ? { download: 1 } : undefined }),
  transition: (id: string, body: SubmissionTransition) =>
    api.post<SubmissionDetail>(`/tally/submissions/${id}/transition`, body),
  designateCanonical: (id: string, reason: string) =>
    api.post<SubmissionDetail>(`/tally/submissions/${id}/designate-canonical`, { reason }),
  audit: (id: string) => api.get<AuditEvent[]>(`/tally/submissions/${id}/audit`),

  /* -------------------------------- Capture -------------------------------- */
  saveValues: (id: string, body: SaveCapture) => api.put<SubmissionDetail>(`/tally/submissions/${id}/values`, body),
  valueHistory: (id: string) => api.get<ResultValueChange[]>(`/tally/submissions/${id}/values/history`),
  submitForReview: (id: string, reason?: string) =>
    api.post<SubmissionDetail>(`/tally/submissions/${id}/submit-for-review`, reason ? { reason } : {}),
  validate: (id: string) => api.post<ValidationRun>(`/tally/submissions/${id}/validate`),

  /* ------------------------------ Verification ----------------------------- */
  verify: (id: string, body: CreateVerification) => api.post<Verification>(`/tally/submissions/${id}/verifications`, body),
  supervisorAction: (verificationId: string, body: SupervisorActionRequest) =>
    api.post<Verification>(`/tally/verifications/${verificationId}/supervisor-action`, body),

  /* ------------------------------ Discrepancies ---------------------------- */
  discrepancies: (query: Partial<DiscrepancyQuery>) =>
    api.get<Paginated<DiscrepancyCaseSummary>>('/tally/discrepancies', { query: q(query) }),
  discrepancy: (id: string) => api.get<DiscrepancyCaseDetail>(`/tally/discrepancies/${id}`),
  createDiscrepancy: (body: CreateDiscrepancy) => api.post<DiscrepancyCaseDetail>('/tally/discrepancies', body),
  assignDiscrepancy: (id: string, body: AssignDiscrepancy) =>
    api.post<DiscrepancyCaseDetail>(`/tally/discrepancies/${id}/assign`, body),
  commentDiscrepancy: (id: string, note: string) =>
    api.post<DiscrepancyCaseAction>(`/tally/discrepancies/${id}/comments`, { note }),
  transitionDiscrepancy: (id: string, body: DiscrepancyTransition) =>
    api.post<DiscrepancyCaseDetail>(`/tally/discrepancies/${id}/transition`, body),
  resolveDiscrepancy: (id: string, body: ResolveDiscrepancy) =>
    api.post<DiscrepancyCaseDetail>(`/tally/discrepancies/${id}/resolve`, body),
  closeDiscrepancy: (id: string, body: CloseDiscrepancy) =>
    api.post<DiscrepancyCaseDetail>(`/tally/discrepancies/${id}/close`, body),

  /* --------------------------- Results & snapshots ------------------------- */
  live: (query: AggregateQuery) => api.get<LiveAggregate>('/tally/results/live', { query: q(query) }),
  breakdown: (query: AggregateQuery & { parentUnitId?: string }) =>
    api.get<GeographyBreakdown>('/tally/results/breakdown', { query: q(query) }),
  stations: (query: AggregateQuery & { page?: number; pageSize?: number; q?: string; status?: StationCoverageStatus }) =>
    api.get<Paginated<StationCoverageRow>>('/tally/results/stations', { query: q(query) }),
  snapshots: (electionCycleId: string, contestId: string) =>
    api.get<Paginated<TallySnapshot>>('/tally/snapshots', {
      query: { electionCycleId, contestId, pageSize: 20, sort: 'createdAt', order: 'desc' },
    }),
  createSnapshot: (body: CreateSnapshot) => api.post<TallySnapshot>('/tally/snapshots', body),
  releaseSnapshot: (id: string, reason: string) => api.post<TallySnapshot>(`/tally/snapshots/${id}/release`, { reason }),
  createExport: (body: CreateExport) => api.post<TallyExport>('/tally/exports', body),
  exportDownloadUrl: (id: string) => api.get<SignedUrlResponse>(`/tally/exports/${id}/download-url`),
};
