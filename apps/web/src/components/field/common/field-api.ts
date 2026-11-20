/**
 * Typed wrappers for the field-operations and War Room endpoints used by the
 * desktop screens (S13–S16 and the incident desk). Every path, request and
 * response type follows docs/API_CONTRACT.md §16–21. The API enforces
 * permissions, geography and cycle scope, module activation and separation of
 * duties on every call; nothing here is a security control.
 */
import type {
  AddIncidentEvent,
  AgentDetail,
  AgentQuery,
  AgentSensitiveReveal,
  AgentStatusChange,
  AgentSummary,
  AgentTraining,
  AgentAccreditation,
  AssignIncident,
  AuditEvent,
  CancelDeployment,
  CloseIncident,
  CreateAgent,
  CreateDeployment,
  DeploymentCoverage,
  DeploymentCoverageQuery,
  DeploymentDetail,
  DeploymentQuery,
  DeploymentSummary,
  ElectionCycle,
  EscalateIncident,
  FieldReportQuery,
  FieldReportSummary,
  GenerateReadiness,
  GenerateReadinessResult,
  GeographicUnit,
  GeographicUnitType,
  IncidentDetail,
  IncidentEvent,
  IncidentQuery,
  IncidentSubject,
  IncidentSummary,
  Paginated,
  ReadinessChecklist,
  ReadinessQuery,
  ReadinessSummary,
  RecordIncidentSubject,
  RecordTraining,
  ReopenIncident,
  ReplaceDeployment,
  ReplaceDeploymentResult,
  ResolveIncident,
  RevealAgentSensitive,
  RosterExport,
  SetAccreditation,
  SetStationStatus,
  SignedUrlResponse,
  StationStatusDetail,
  StationStatusList,
  StationStatusQuery,
  TriageIncident,
  UpdateDeployment,
  UpdateReadinessItem,
  WarRoomOverview,
  WarRoomQuery,
  UserRef,
} from '@ngao360/shared';
import { api } from '@/lib/api-client';

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

/** Drop empty values so the API's zod query schemas see only what was chosen. */
export function q(obj: object): Query {
  const out: Query = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v as Query[string];
  }
  return out;
}

const enc = encodeURIComponent;

export const fieldApi = {
  /* ------------------------------ Reference -------------------------------- */
  electionCycles: () => api.get<Paginated<ElectionCycle>>('/reference/election-cycles', { query: { pageSize: 100 } }),
  electionCycle: (id: string) => api.get<ElectionCycle>(`/reference/election-cycles/${id}`),
  geographicUnits: (electionCycleId: string, type: GeographicUnitType, parentId?: string) =>
    api.get<Paginated<GeographicUnit>>('/reference/geographic-units', {
      query: q({ electionCycleId, type, parentId, pageSize: 200, sort: 'officialName', order: 'asc' }),
    }),


  /* -------------------------------- Agents (§16) --------------------------- */
  agents: (query: Partial<AgentQuery>) => api.get<Paginated<AgentSummary>>('/field/agents', { query: q(query) }),
  agent: (id: string) => api.get<AgentDetail>(`/field/agents/${id}`),
  createAgent: (body: CreateAgent) => api.post<AgentDetail>('/field/agents', body),
  agentStatus: (id: string, body: AgentStatusChange) => api.post<AgentDetail>(`/field/agents/${id}/status`, body),
  revealAgent: (id: string, body: RevealAgentSensitive) => api.post<AgentSensitiveReveal>(`/field/agents/${id}/reveal`, body),
  recordTraining: (id: string, body: RecordTraining) => api.post<AgentTraining>(`/field/agents/${id}/trainings`, body),
  setAccreditation: (id: string, body: SetAccreditation) => api.put<AgentAccreditation>(`/field/agents/${id}/accreditation`, body),
  agentHistory: (id: string) => api.get<AuditEvent[]>(`/field/agents/${id}/history`),

  /* ------------------------------ Deployment (§17) ------------------------- */
  coverage: (query: Partial<DeploymentCoverageQuery>) =>
    api.get<DeploymentCoverage>('/field/deployments/coverage', { query: q(query) }),
  deployments: (query: Partial<DeploymentQuery>) =>
    api.get<Paginated<DeploymentSummary>>('/field/deployments', { query: q(query) }),
  deployment: (id: string) => api.get<DeploymentDetail>(`/field/deployments/${id}`),
  createDeployment: (body: CreateDeployment) => api.post<DeploymentDetail>('/field/deployments', body),
  updateDeployment: (id: string, body: UpdateDeployment) => api.patch<DeploymentDetail>(`/field/deployments/${id}`, body),
  replaceDeployment: (id: string, body: ReplaceDeployment) =>
    api.post<ReplaceDeploymentResult>(`/field/deployments/${id}/replace`, body),
  cancelDeployment: (id: string, body: CancelDeployment) => api.post<DeploymentDetail>(`/field/deployments/${id}/cancel`, body),
  rosterExport: (body: RosterExport) => api.post<SignedUrlResponse>('/field/deployments/roster-export', body),

  /* ------------------------------ Readiness (§18) -------------------------- */
  readinessSummary: (query: Partial<ReadinessQuery>) =>
    api.get<ReadinessSummary>('/field/readiness/summary', { query: q(query) }),
  readiness: (query: Partial<ReadinessQuery>) =>
    api.get<Paginated<ReadinessChecklist>>('/field/readiness', { query: q(query) }),
  generateReadiness: (body: GenerateReadiness) => api.post<GenerateReadinessResult>('/field/readiness/generate', body),
  updateReadinessItem: (id: string, itemId: string, body: UpdateReadinessItem) =>
    api.patch<ReadinessChecklist>(`/field/readiness/${id}/items/${itemId}`, body),

  /* ---------------------------- Field reports (§19) ------------------------ */
  reports: (query: Partial<FieldReportQuery>) => api.get<Paginated<FieldReportSummary>>('/field/reports', { query: q(query) }),

  /* ------------------------------ Incidents (§20) -------------------------- */
  incidents: (query: Partial<IncidentQuery>) => api.get<Paginated<IncidentSummary>>('/field/incidents', { query: q(query) }),
  incident: (id: string) => api.get<IncidentDetail>(`/field/incidents/${id}`),
  /** Active users who may be assigned the incident (`field.incidents.assign`, geo). */
  incidentAssignableUsers: (id: string) => api.get<UserRef[]>(`/field/incidents/${id}/assignable-users`),
  triageIncident: (id: string, body: TriageIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/triage`, body),
  assignIncident: (id: string, body: AssignIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/assign`, body),
  escalateIncident: (id: string, body: EscalateIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/escalate`, body),
  addIncidentEvent: (id: string, body: AddIncidentEvent) => api.post<IncidentEvent>(`/field/incidents/${id}/events`, body),
  resolveIncident: (id: string, body: ResolveIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/resolve`, body),
  closeIncident: (id: string, body: CloseIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/close`, body),
  reopenIncident: (id: string, body: ReopenIncident) => api.post<IncidentDetail>(`/field/incidents/${id}/reopen`, body),
  incidentSubjects: (id: string) => api.get<IncidentSubject[]>(`/field/incidents/${id}/subject`),
  recordIncidentSubject: (id: string, body: RecordIncidentSubject) =>
    api.post<IncidentSubject>(`/field/incidents/${id}/subject`, body),
  incidentEvidenceUrl: (id: string, fileId: string) =>
    api.get<SignedUrlResponse>(`/field/incidents/${id}/evidence/${fileId}/url`),
  incidentHistory: (id: string) => api.get<AuditEvent[]>(`/field/incidents/${id}/history`),

  /* ------------------------------ War Room (§21) --------------------------- */
  warRoomOverview: (query: WarRoomQuery) => api.get<WarRoomOverview>('/warroom/overview', { query: q(query) }),
  warRoomStations: (query: Partial<StationStatusQuery>) => api.get<StationStatusList>('/warroom/stations', { query: q(query) }),
  warRoomStation: (code: string, electionCycleId?: string) =>
    api.get<StationStatusDetail>(`/warroom/stations/${enc(code)}`, { query: q({ electionCycleId }) }),
  setStationStatus: (code: string, body: SetStationStatus) =>
    api.put<StationStatusDetail>(`/warroom/stations/${enc(code)}/status`, body),
};
