/**
 * Field and election operations: geo resolver kinds registered by FieldModule
 * and audit entity type names.
 */

/** GeoScopeService kinds: `@RequirePermission(..., { geo: { kind: FIELD_GEO_KIND.INCIDENT, from: 'params', key: 'id' } })`. */
export const FIELD_GEO_KIND = {
  AGENT: 'fieldAgent',
  DEPLOYMENT: 'fieldDeployment',
  READINESS_CHECKLIST: 'fieldReadinessChecklist',
  FIELD_REPORT: 'fieldReport',
  INCIDENT: 'fieldIncident',
  /** Station status rows are addressed by cycle + code; params `cycleId` + `code` are resolved by the warroom service. */
} as const;

/** `entityType` values for audit events. */
export const FIELD_ENTITY = {
  AGENT: 'Agent',
  AGENT_SENSITIVE: 'AgentSensitive',
  AGENT_TRAINING: 'AgentTraining',
  AGENT_ACCREDITATION: 'AgentAccreditation',
  DEPLOYMENT: 'Deployment',
  READINESS_CHECKLIST: 'ReadinessChecklist',
  READINESS_ITEM: 'ReadinessItem',
  FIELD_REPORT_TEMPLATE: 'FieldReportTemplate',
  FIELD_REPORT: 'FieldReport',
  INCIDENT: 'Incident',
  STATION_STATUS: 'StationStatus',
  CLIENT_SUBMISSION: 'ClientSubmission',
} as const;
