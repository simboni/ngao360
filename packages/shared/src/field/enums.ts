/**
 * Field and election operations enums (blueprint 6.1, 6.3, 7.2, 7.3, 13.4):
 * agents, deployments, readiness, field reports, incidents, war-room station
 * status and the offline-sync ledger.
 *
 * Every value here MUST match the corresponding Prisma enum in
 * packages/db/prisma/schema.prisma (checked by shared.test.ts). Labels are the
 * words shown next to an icon in the UI; never communicate status by colour
 * alone (blueprint 12.2).
 */
import { z } from 'zod';

type EnumObject<T extends readonly string[]> = { readonly [K in T[number]]: K };
function enumObject<const T extends readonly [string, ...string[]]>(values: T): EnumObject<T> {
  return Object.freeze(Object.fromEntries(values.map((v) => [v, v]))) as EnumObject<T>;
}

/* -------------------------------------------------------------------------- */
/* Agents (blueprint 6.3, S13)                                                */
/* -------------------------------------------------------------------------- */

export const AGENT_STATUSES = ['RECRUITED', 'ACTIVE', 'STANDBY', 'INACTIVE', 'WITHDRAWN'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AgentStatus = enumObject(AGENT_STATUSES);
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  RECRUITED: 'Recruited',
  ACTIVE: 'Active',
  STANDBY: 'Standby',
  INACTIVE: 'Inactive',
  WITHDRAWN: 'Withdrawn',
};
/** Agent status changes (WITHDRAWN is final: re-recruit as a new record). */
export const AGENT_STATUS_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  RECRUITED: ['ACTIVE', 'STANDBY', 'INACTIVE', 'WITHDRAWN'],
  ACTIVE: ['STANDBY', 'INACTIVE', 'WITHDRAWN'],
  STANDBY: ['ACTIVE', 'INACTIVE', 'WITHDRAWN'],
  INACTIVE: ['ACTIVE', 'STANDBY', 'WITHDRAWN'],
  WITHDRAWN: [],
};
export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_STATUS_TRANSITIONS[from].includes(to);
}

export const AGENT_AVAILABILITIES = ['AVAILABLE', 'LIMITED', 'UNAVAILABLE'] as const;
export type AgentAvailability = (typeof AGENT_AVAILABILITIES)[number];
export const AgentAvailability = enumObject(AGENT_AVAILABILITIES);
export const AgentAvailabilitySchema = z.enum(AGENT_AVAILABILITIES);
export const AGENT_AVAILABILITY_LABELS: Record<AgentAvailability, string> = {
  AVAILABLE: 'Available',
  LIMITED: 'Limited availability',
  UNAVAILABLE: 'Unavailable',
};

/** Optional; never required and never used for targeting or analytics. */
export const AGENT_GENDERS = ['FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export type AgentGender = (typeof AGENT_GENDERS)[number];
export const AgentGender = enumObject(AGENT_GENDERS);
export const AgentGenderSchema = z.enum(AGENT_GENDERS);
export const AGENT_GENDER_LABELS: Record<AgentGender, string> = {
  FEMALE: 'Female',
  MALE: 'Male',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'Prefer not to say',
};

/**
 * Accreditation tracking per election cycle (blueprint 6.3). NGAO360 records
 * the status; it never grants accreditation or polling-station access.
 */
export const ACCREDITATION_STATUSES = [
  'NOT_SUBMITTED',
  'SUBMITTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'NOT_APPLICABLE',
] as const;
export type AccreditationStatus = (typeof ACCREDITATION_STATUSES)[number];
export const AccreditationStatus = enumObject(ACCREDITATION_STATUSES);
export const AccreditationStatusSchema = z.enum(ACCREDITATION_STATUSES);
export const ACCREDITATION_STATUS_LABELS: Record<AccreditationStatus, string> = {
  NOT_SUBMITTED: 'Not submitted',
  SUBMITTED: 'Submitted',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  NOT_APPLICABLE: 'Not applicable',
};

export const TRAINING_STATUSES = ['SCHEDULED', 'ATTENDED', 'COMPLETED', 'NOT_PASSED', 'ABSENT'] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];
export const TrainingStatus = enumObject(TRAINING_STATUSES);
export const TrainingStatusSchema = z.enum(TRAINING_STATUSES);
export const TRAINING_STATUS_LABELS: Record<TrainingStatus, string> = {
  SCHEDULED: 'Scheduled',
  ATTENDED: 'Attended',
  COMPLETED: 'Completed',
  NOT_PASSED: 'Assessment not passed',
  ABSENT: 'Absent',
};

/* -------------------------------------------------------------------------- */
/* Deployment (blueprint 6.3, S14)                                            */
/* -------------------------------------------------------------------------- */

export const DEPLOYMENT_ROLES = ['CHIEF_AGENT', 'STATION_AGENT', 'RELIEF_AGENT', 'RUNNER', 'SUPERVISOR'] as const;
export type DeploymentRole = (typeof DEPLOYMENT_ROLES)[number];
export const DeploymentRole = enumObject(DEPLOYMENT_ROLES);
export const DeploymentRoleSchema = z.enum(DEPLOYMENT_ROLES);
export const DEPLOYMENT_ROLE_LABELS: Record<DeploymentRole, string> = {
  CHIEF_AGENT: 'Chief agent',
  STATION_AGENT: 'Station agent',
  RELIEF_AGENT: 'Relief agent',
  RUNNER: 'Runner',
  SUPERVISOR: 'Supervisor',
};

export const DEPLOYMENT_SHIFTS = ['FULL_DAY', 'OPENING', 'DAYTIME', 'CLOSING_AND_COUNTING'] as const;
export type DeploymentShift = (typeof DEPLOYMENT_SHIFTS)[number];
export const DeploymentShift = enumObject(DEPLOYMENT_SHIFTS);
export const DeploymentShiftSchema = z.enum(DEPLOYMENT_SHIFTS);
export const DEPLOYMENT_SHIFT_LABELS: Record<DeploymentShift, string> = {
  FULL_DAY: 'Full day',
  OPENING: 'Opening',
  DAYTIME: 'Daytime',
  CLOSING_AND_COUNTING: 'Closing and counting',
};
/** Shifts that overlap (an agent cannot hold two active deployments on overlapping shifts). */
export function shiftsOverlap(a: DeploymentShift, b: DeploymentShift): boolean {
  return a === b || a === 'FULL_DAY' || b === 'FULL_DAY';
}

/**
 * Blueprint 7.2: ASSIGNED ("Assigned"), CONFIRMED ("Confirmed"), CHECKED_IN
 * ("Checked in"). Replacement keeps the original row (status REPLACED) and
 * links the successor; nothing is deleted.
 */
export const DEPLOYMENT_STATUSES = ['ASSIGNED', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'REPLACED', 'CANCELLED'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
export const DeploymentStatus = enumObject(DEPLOYMENT_STATUSES);
export const DeploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);
export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  ASSIGNED: 'Assigned',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  CHECKED_OUT: 'Checked out',
  REPLACED: 'Replaced',
  CANCELLED: 'Cancelled',
};
export const DEPLOYMENT_STATUS_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  ASSIGNED: ['CONFIRMED', 'REPLACED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'REPLACED', 'CANCELLED'],
  CHECKED_IN: ['CHECKED_OUT', 'REPLACED'],
  CHECKED_OUT: [],
  REPLACED: [],
  CANCELLED: [],
};
export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_STATUS_TRANSITIONS[from].includes(to);
}
/** Statuses that occupy a station slot and the agent's time. */
export const ACTIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ['ASSIGNED', 'CONFIRMED', 'CHECKED_IN'];

export const DEPLOYMENT_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'REPLACED',
  'CANCELLED',
  'NOTE',
] as const;
export type DeploymentEventType = (typeof DEPLOYMENT_EVENT_TYPES)[number];
export const DeploymentEventType = enumObject(DEPLOYMENT_EVENT_TYPES);
export const DeploymentEventTypeSchema = z.enum(DEPLOYMENT_EVENT_TYPES);

/* -------------------------------------------------------------------------- */
/* Readiness (S15)                                                            */
/* -------------------------------------------------------------------------- */

export const READINESS_CATEGORIES = ['ACCREDITATION', 'MATERIALS', 'TRANSPORT', 'COMMUNICATIONS', 'PAYMENT'] as const;
export type ReadinessCategory = (typeof READINESS_CATEGORIES)[number];
export const ReadinessCategory = enumObject(READINESS_CATEGORIES);
export const ReadinessCategorySchema = z.enum(READINESS_CATEGORIES);
export const READINESS_CATEGORY_LABELS: Record<ReadinessCategory, string> = {
  ACCREDITATION: 'Agent accreditation',
  MATERIALS: 'Materials issued',
  TRANSPORT: 'Transport arranged',
  COMMUNICATIONS: 'Communications checked',
  PAYMENT: 'Agent facilitation arranged',
};

export const READINESS_ITEM_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'NOT_APPLICABLE'] as const;
export type ReadinessItemStatus = (typeof READINESS_ITEM_STATUSES)[number];
export const ReadinessItemStatus = enumObject(READINESS_ITEM_STATUSES);
export const ReadinessItemStatusSchema = z.enum(READINESS_ITEM_STATUSES);
export const READINESS_ITEM_STATUS_LABELS: Record<ReadinessItemStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  BLOCKED: 'Blocked',
  NOT_APPLICABLE: 'Not applicable',
};

/** Overall checklist state, derived from its items (`deriveReadinessStatus`). */
export const READINESS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'READY', 'BLOCKED'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export const ReadinessStatus = enumObject(READINESS_STATUSES);
export const ReadinessStatusSchema = z.enum(READINESS_STATUSES);
export const READINESS_STATUS_LABELS: Record<ReadinessStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  READY: 'Ready',
  BLOCKED: 'Blocked',
};

/**
 * BLOCKED if any item is blocked; READY when every item is DONE or
 * NOT_APPLICABLE (and at least one is DONE); NOT_STARTED when nothing has
 * started; otherwise IN_PROGRESS.
 */
export function deriveReadinessStatus(items: ReadonlyArray<{ status: ReadinessItemStatus }>): ReadinessStatus {
  if (items.length === 0) return 'NOT_STARTED';
  if (items.some((i) => i.status === 'BLOCKED')) return 'BLOCKED';
  const settled = items.every((i) => i.status === 'DONE' || i.status === 'NOT_APPLICABLE');
  if (settled && items.some((i) => i.status === 'DONE')) return 'READY';
  if (items.every((i) => i.status === 'NOT_STARTED' || i.status === 'NOT_APPLICABLE')) return 'NOT_STARTED';
  return 'IN_PROGRESS';
}

/* -------------------------------------------------------------------------- */
/* Field reports (blueprint 6.1, S11)                                         */
/* -------------------------------------------------------------------------- */

export const FIELD_REPORT_TYPES = ['OPENING_OF_POLLS', 'POLLING_OBSERVATION', 'CLOSING_AND_COUNTING', 'GENERAL'] as const;
export type FieldReportType = (typeof FIELD_REPORT_TYPES)[number];
export const FieldReportType = enumObject(FIELD_REPORT_TYPES);
export const FieldReportTypeSchema = z.enum(FIELD_REPORT_TYPES);
export const FIELD_REPORT_TYPE_LABELS: Record<FieldReportType, string> = {
  OPENING_OF_POLLS: 'Opening of polls',
  POLLING_OBSERVATION: 'Polling observation',
  CLOSING_AND_COUNTING: 'Closing and counting observation',
  GENERAL: 'General field report',
};

/** Template lifecycle; an ACTIVE template is immutable (changes create a new version). */
export const FIELD_REPORT_TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type FieldReportTemplateStatus = (typeof FIELD_REPORT_TEMPLATE_STATUSES)[number];
export const FieldReportTemplateStatus = enumObject(FIELD_REPORT_TEMPLATE_STATUSES);
export const FieldReportTemplateStatusSchema = z.enum(FIELD_REPORT_TEMPLATE_STATUSES);
export const FIELD_REPORT_TEMPLATE_STATUS_LABELS: Record<FieldReportTemplateStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  RETIRED: 'Retired',
};

/** Supervisor review (blueprint 6.1: accept; return for clarification; escalate; close). */
export const FIELD_REPORT_REVIEW_STATUSES = ['SUBMITTED', 'ACCEPTED', 'RETURNED', 'ESCALATED', 'CLOSED'] as const;
export type FieldReportReviewStatus = (typeof FIELD_REPORT_REVIEW_STATUSES)[number];
export const FieldReportReviewStatus = enumObject(FIELD_REPORT_REVIEW_STATUSES);
export const FieldReportReviewStatusSchema = z.enum(FIELD_REPORT_REVIEW_STATUSES);
export const FIELD_REPORT_REVIEW_STATUS_LABELS: Record<FieldReportReviewStatus, string> = {
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  RETURNED: 'Returned for clarification',
  ESCALATED: 'Escalated',
  CLOSED: 'Closed',
};
export const FIELD_REPORT_REVIEW_TRANSITIONS: Record<FieldReportReviewStatus, readonly FieldReportReviewStatus[]> = {
  SUBMITTED: ['ACCEPTED', 'RETURNED', 'ESCALATED', 'CLOSED'],
  RETURNED: ['ACCEPTED', 'ESCALATED', 'CLOSED'],
  ACCEPTED: ['ESCALATED', 'CLOSED'],
  ESCALATED: ['ACCEPTED', 'CLOSED'],
  CLOSED: [],
};
export function canTransitionFieldReport(from: FieldReportReviewStatus, to: FieldReportReviewStatus): boolean {
  return FIELD_REPORT_REVIEW_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------- */
/* Incidents (blueprint 7.3, S17)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Neutral, factual categories. A category describes what was observed, never
 * who is to blame (blueprint 15.3: no auto-labelling of a person or
 * institution as fraudulent or criminal).
 */
export const INCIDENT_CATEGORIES = [
  'OPENING_OR_CLOSING_TIME',
  'MATERIALS',
  'EQUIPMENT',
  'AGENT_ACCESS',
  'VOTER_IDENTIFICATION',
  'PROCEDURE',
  'COUNTING_AND_FORMS',
  'SECURITY',
  'VIOLENCE_OR_INTIMIDATION',
  'ACCESSIBILITY',
  'LOGISTICS',
  'COMMUNICATIONS',
  'HEALTH_AND_SAFETY',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const IncidentCategory = enumObject(INCIDENT_CATEGORIES);
export const IncidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  OPENING_OR_CLOSING_TIME: 'Opening or closing time',
  MATERIALS: 'Election materials missing or insufficient',
  EQUIPMENT: 'Equipment or technology not working',
  AGENT_ACCESS: 'Agent access or accreditation issue',
  VOTER_IDENTIFICATION: 'Voter identification or register issue',
  PROCEDURE: 'Procedure not followed as expected',
  COUNTING_AND_FORMS: 'Counting or results-form concern',
  SECURITY: 'Security concern',
  VIOLENCE_OR_INTIMIDATION: 'Violence or intimidation',
  ACCESSIBILITY: 'Accessibility or assisted-voter issue',
  LOGISTICS: 'Transport or logistics',
  COMMUNICATIONS: 'Communications failure',
  HEALTH_AND_SAFETY: 'Health and safety',
  OTHER: 'Other',
};

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const IncidentSeverity = enumObject(INCIDENT_SEVERITIES);
export const IncidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};
export const INCIDENT_SEVERITY_RANK: Record<IncidentSeverity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Default initial severity per category (blueprint 7.3 step 2: "initial
 * priority based on configurable rules"). Tenants override it in
 * `FieldModuleConfig.incidentSeverityDefaults`; a desk officer sets the
 * triaged severity.
 */
export const DEFAULT_INCIDENT_SEVERITY: Record<IncidentCategory, IncidentSeverity> = {
  OPENING_OR_CLOSING_TIME: 'MEDIUM',
  MATERIALS: 'MEDIUM',
  EQUIPMENT: 'MEDIUM',
  AGENT_ACCESS: 'HIGH',
  VOTER_IDENTIFICATION: 'MEDIUM',
  PROCEDURE: 'MEDIUM',
  COUNTING_AND_FORMS: 'HIGH',
  SECURITY: 'HIGH',
  VIOLENCE_OR_INTIMIDATION: 'CRITICAL',
  ACCESSIBILITY: 'MEDIUM',
  LOGISTICS: 'LOW',
  COMMUNICATIONS: 'LOW',
  HEALTH_AND_SAFETY: 'HIGH',
  OTHER: 'LOW',
};

/** Blueprint 7.3 workflow: reported → triaged → assigned → escalated → resolved → closed. */
export const INCIDENT_STATUSES = ['REPORTED', 'TRIAGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatus = enumObject(INCIDENT_STATUSES);
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);
export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  REPORTED: 'Reported',
  TRIAGED: 'Triaged',
  ASSIGNED: 'Assigned',
  ESCALATED: 'Escalated',
  RESOLVED: 'Resolved, awaiting closure',
  CLOSED: 'Closed',
};
/**
 * Allowed moves. A CLOSED incident can be reopened (back to TRIAGED) with a
 * reason; incidents are never deleted. RESOLVED → ASSIGNED sends a resolution
 * back when the closing reviewer does not accept it.
 */
export const INCIDENT_STATUS_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  REPORTED: ['TRIAGED'],
  TRIAGED: ['ASSIGNED', 'ESCALATED', 'RESOLVED'],
  ASSIGNED: ['ESCALATED', 'RESOLVED', 'TRIAGED'],
  ESCALATED: ['ASSIGNED', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'ASSIGNED', 'ESCALATED'],
  CLOSED: ['TRIAGED'],
};
export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_STATUS_TRANSITIONS[from].includes(to);
}
export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = ['REPORTED', 'TRIAGED', 'ASSIGNED', 'ESCALATED', 'RESOLVED'];

/** How an incident ended. Disputed matters close as UNRESOLVED, never as resolved. */
export const INCIDENT_OUTCOMES = ['RESOLVED', 'UNRESOLVED', 'REFERRED', 'NO_ACTION_NEEDED', 'DUPLICATE'] as const;
export type IncidentOutcome = (typeof INCIDENT_OUTCOMES)[number];
export const IncidentOutcome = enumObject(INCIDENT_OUTCOMES);
export const IncidentOutcomeSchema = z.enum(INCIDENT_OUTCOMES);
export const INCIDENT_OUTCOME_LABELS: Record<IncidentOutcome, string> = {
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved (disputed or open questions remain)',
  REFERRED: 'Referred to a competent authority',
  NO_ACTION_NEEDED: 'No action needed',
  DUPLICATE: 'Duplicate of another incident',
};

export const INCIDENT_ESCALATION_TARGETS = [
  'WAR_ROOM_COMMAND',
  'LEGAL_COMPLIANCE',
  'SECURITY_LIAISON',
  'COMPETENT_AUTHORITY',
  'OTHER',
] as const;
export type IncidentEscalationTarget = (typeof INCIDENT_ESCALATION_TARGETS)[number];
export const IncidentEscalationTarget = enumObject(INCIDENT_ESCALATION_TARGETS);
export const IncidentEscalationTargetSchema = z.enum(INCIDENT_ESCALATION_TARGETS);
export const INCIDENT_ESCALATION_TARGET_LABELS: Record<IncidentEscalationTarget, string> = {
  WAR_ROOM_COMMAND: 'War Room command',
  LEGAL_COMPLIANCE: 'Legal and compliance',
  SECURITY_LIAISON: 'Security liaison',
  COMPETENT_AUTHORITY: 'Competent authority (referral)',
  OTHER: 'Other',
};

/** Append-only incident history; corrections are new events, never edits of the report. */
export const INCIDENT_EVENT_TYPES = [
  'REPORTED',
  'TRIAGED',
  'ASSIGNED',
  'ESCALATED',
  'NOTE',
  'CORRECTION',
  'EVIDENCE_ADDED',
  'EVIDENCE_HOLD_PLACED',
  'EVIDENCE_HOLD_RELEASED',
  'REFERRED',
  'SUBJECT_RECORDED',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];
export const IncidentEventType = enumObject(INCIDENT_EVENT_TYPES);
export const IncidentEventTypeSchema = z.enum(INCIDENT_EVENT_TYPES);

/* -------------------------------------------------------------------------- */
/* War Room station status (blueprint 7.2, S16)                               */
/* -------------------------------------------------------------------------- */

/** Where a station's current operational status came from. */
export const STATION_STATUS_SOURCES = ['DERIVED', 'MANUAL'] as const;
export type StationStatusSource = (typeof STATION_STATUS_SOURCES)[number];
export const StationStatusSource = enumObject(STATION_STATUS_SOURCES);
export const StationStatusSourceSchema = z.enum(STATION_STATUS_SOURCES);

/* -------------------------------------------------------------------------- */
/* Offline sync ledger (blueprint 13.4)                                       */
/* -------------------------------------------------------------------------- */

export const CLIENT_SUBMISSION_KINDS = [
  'FIELD_REPORT',
  'INCIDENT',
  'INCIDENT_NOTE',
  'CHECK_IN',
  'ASSIGNMENT_CONFIRMATION',
] as const;
export type ClientSubmissionKind = (typeof CLIENT_SUBMISSION_KINDS)[number];
export const ClientSubmissionKind = enumObject(CLIENT_SUBMISSION_KINDS);
export const ClientSubmissionKindSchema = z.enum(CLIENT_SUBMISSION_KINDS);

export const CLIENT_SUBMISSION_OUTCOMES = ['ACCEPTED', 'REJECTED', 'CONFLICT'] as const;
export type ClientSubmissionOutcome = (typeof CLIENT_SUBMISSION_OUTCOMES)[number];
export const ClientSubmissionOutcome = enumObject(CLIENT_SUBMISSION_OUTCOMES);
export const ClientSubmissionOutcomeSchema = z.enum(CLIENT_SUBMISSION_OUTCOMES);
