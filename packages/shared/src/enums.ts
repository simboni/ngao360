/**
 * Status and classification enums shared by the API, web client and database.
 *
 * Every value here MUST match the corresponding Prisma enum in
 * packages/db/prisma/schema.prisma exactly (a unit test checks this list against
 * the schema file). Labels are the human-readable words that must always be shown
 * next to an icon in the UI: never communicate status by colour alone.
 */
import { z } from 'zod';

type EnumObject<T extends readonly string[]> = { readonly [K in T[number]]: K };

function enumObject<const T extends readonly [string, ...string[]]>(values: T): EnumObject<T> {
  return Object.freeze(Object.fromEntries(values.map((v) => [v, v]))) as EnumObject<T>;
}

/* -------------------------------------------------------------------------- */
/* Tenancy, identity and access                                               */
/* -------------------------------------------------------------------------- */

export const TENANT_TYPES = [
  'CAMPAIGN',
  'POLITICAL_PARTY',
  'ELECTED_OFFICE',
  'OBSERVER_ORGANISATION',
  'PLATFORM',
] as const;
export type TenantType = (typeof TENANT_TYPES)[number];
export const TenantType = enumObject(TENANT_TYPES);
export const TenantTypeSchema = z.enum(TENANT_TYPES);

export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
export const TenantStatus = enumObject(TENANT_STATUSES);
export const TenantStatusSchema = z.enum(TENANT_STATUSES);

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const UserStatus = enumObject(USER_STATUSES);
export const UserStatusSchema = z.enum(USER_STATUSES);
export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  INVITED: 'Invited',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
};

export const MFA_FACTOR_TYPES = ['TOTP'] as const;
export type MfaFactorType = (typeof MFA_FACTOR_TYPES)[number];
export const MfaFactorType = enumObject(MFA_FACTOR_TYPES);
export const MfaFactorTypeSchema = z.enum(MFA_FACTOR_TYPES);

export const MFA_FACTOR_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type MfaFactorStatus = (typeof MFA_FACTOR_STATUSES)[number];
export const MfaFactorStatus = enumObject(MFA_FACTOR_STATUSES);
export const MfaFactorStatusSchema = z.enum(MFA_FACTOR_STATUSES);

/** Blueprint 3.1 geography dimension. */
export const SCOPE_TYPES = [
  'ORGANISATION',
  'COUNTY',
  'CONSTITUENCY',
  'WARD',
  'POLLING_CENTRE',
  'POLLING_STATION',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const ScopeType = enumObject(SCOPE_TYPES);
export const ScopeTypeSchema = z.enum(SCOPE_TYPES);

/** Blueprint 3.1 record sensitivity dimension. */
export const SENSITIVITY_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED'] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];
export const SensitivityLevel = enumObject(SENSITIVITY_LEVELS);
export const SensitivityLevelSchema = z.enum(SENSITIVITY_LEVELS);

export const AUDIT_ACTOR_TYPES = ['USER', 'SYSTEM', 'PLATFORM_SUPPORT'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const AuditActorType = enumObject(AUDIT_ACTOR_TYPES);
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

/* -------------------------------------------------------------------------- */
/* Reference data                                                             */
/* -------------------------------------------------------------------------- */

/** Provenance of a cycle's data (DECISIONS.md: historical 2022 data for demo/pilot). */
export const DATA_PROVENANCES = ['SYNTHETIC', 'HISTORICAL', 'LIVE'] as const;
export type DataProvenance = (typeof DATA_PROVENANCES)[number];
export const DataProvenance = enumObject(DATA_PROVENANCES);
export const DataProvenanceSchema = z.enum(DATA_PROVENANCES);
export const DATA_PROVENANCE_LABELS: Record<DataProvenance, string> = {
  SYNTHETIC: 'Synthetic demonstration data',
  HISTORICAL: 'Historical data — not live or official results',
  LIVE: 'Live election data',
};

export const ELECTION_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type ElectionCycleStatus = (typeof ELECTION_CYCLE_STATUSES)[number];
export const ElectionCycleStatus = enumObject(ELECTION_CYCLE_STATUSES);
export const ElectionCycleStatusSchema = z.enum(ELECTION_CYCLE_STATUSES);

export const GEOGRAPHIC_UNIT_TYPES = ['COUNTY', 'CONSTITUENCY', 'WARD', 'POLLING_CENTRE'] as const;
export type GeographicUnitType = (typeof GEOGRAPHIC_UNIT_TYPES)[number];
export const GeographicUnitType = enumObject(GEOGRAPHIC_UNIT_TYPES);
export const GeographicUnitTypeSchema = z.enum(GEOGRAPHIC_UNIT_TYPES);
/** Expected parent type for each unit type (county has no parent). */
export const GEOGRAPHIC_PARENT_TYPE: Record<GeographicUnitType, GeographicUnitType | null> = {
  COUNTY: null,
  CONSTITUENCY: 'COUNTY',
  WARD: 'CONSTITUENCY',
  POLLING_CENTRE: 'WARD',
};

export const REGISTRY_VERSION_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type RegistryVersionStatus = (typeof REGISTRY_VERSION_STATUSES)[number];
export const RegistryVersionStatus = enumObject(REGISTRY_VERSION_STATUSES);
export const RegistryVersionStatusSchema = z.enum(REGISTRY_VERSION_STATUSES);

export const POLLING_STATION_STATUSES = ['ACTIVE', 'INACTIVE', 'PENDING_VERIFICATION'] as const;
export type PollingStationStatus = (typeof POLLING_STATION_STATUSES)[number];
export const PollingStationStatus = enumObject(POLLING_STATION_STATUSES);
export const PollingStationStatusSchema = z.enum(POLLING_STATION_STATUSES);

export const TALLY_CENTRE_LEVELS = ['CONSTITUENCY', 'COUNTY', 'NATIONAL'] as const;
export type TallyCentreLevel = (typeof TALLY_CENTRE_LEVELS)[number];
export const TallyCentreLevel = enumObject(TALLY_CENTRE_LEVELS);
export const TallyCentreLevelSchema = z.enum(TALLY_CENTRE_LEVELS);

/** The six elective positions (blueprint 8.1 / Appendix A). */
export const OFFICE_TYPES = [
  'PRESIDENT',
  'NATIONAL_ASSEMBLY',
  'COUNTY_ASSEMBLY',
  'GOVERNOR',
  'SENATOR',
  'WOMAN_REPRESENTATIVE',
] as const;
export type OfficeType = (typeof OFFICE_TYPES)[number];
export const OfficeType = enumObject(OFFICE_TYPES);
export const OfficeTypeSchema = z.enum(OFFICE_TYPES);
export const OFFICE_TYPE_LABELS: Record<OfficeType, string> = {
  PRESIDENT: 'President',
  NATIONAL_ASSEMBLY: 'Member of National Assembly',
  COUNTY_ASSEMBLY: 'Member of County Assembly',
  GOVERNOR: 'County Governor',
  SENATOR: 'Senator',
  WOMAN_REPRESENTATIVE: 'County Woman Representative',
};

export const CONTEST_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED'] as const;
export type ContestStatus = (typeof CONTEST_STATUSES)[number];
export const ContestStatus = enumObject(CONTEST_STATUSES);
export const ContestStatusSchema = z.enum(CONTEST_STATUSES);

/** Stage of the official form within the results chain. */
export const FORM_LEVELS = [
  'POLLING_STATION',
  'CONSTITUENCY',
  'COUNTY',
  'NATIONAL',
  'CERTIFICATE',
] as const;
export type FormLevel = (typeof FORM_LEVELS)[number];
export const FormLevel = enumObject(FORM_LEVELS);
export const FormLevelSchema = z.enum(FORM_LEVELS);

export const FORM_TEMPLATE_APPROVAL_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'RETIRED',
] as const;
export type FormTemplateApprovalState = (typeof FORM_TEMPLATE_APPROVAL_STATES)[number];
export const FormTemplateApprovalState = enumObject(FORM_TEMPLATE_APPROVAL_STATES);
export const FormTemplateApprovalStateSchema = z.enum(FORM_TEMPLATE_APPROVAL_STATES);
export const FORM_TEMPLATE_APPROVAL_STATE_LABELS: Record<FormTemplateApprovalState, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  RETIRED: 'Retired',
};

/* -------------------------------------------------------------------------- */
/* Blueprint 7.2: operational status taxonomy                                 */
/* -------------------------------------------------------------------------- */

export const OPERATIONAL_STATUSES = [
  'NOT_ASSIGNED',
  'ASSIGNED',
  'CONFIRMED',
  'CHECKED_IN',
  'UPDATE_RECEIVED',
  'FORM_EXPECTED',
  'FORM_RECEIVED',
  'VERIFICATION_PENDING',
  'VERIFIED_FOR_PARALLEL_TALLY',
  'FLAGGED',
  'CLOSED',
] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];
export const OperationalStatus = enumObject(OPERATIONAL_STATUSES);
export const OperationalStatusSchema = z.enum(OPERATIONAL_STATUSES);
export const OPERATIONAL_STATUS_LABELS: Record<OperationalStatus, string> = {
  NOT_ASSIGNED: 'Not assigned',
  ASSIGNED: 'Assigned',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  UPDATE_RECEIVED: 'Update received',
  FORM_EXPECTED: 'Form expected',
  FORM_RECEIVED: 'Form received',
  VERIFICATION_PENDING: 'Verification pending',
  VERIFIED_FOR_PARALLEL_TALLY: 'Verified for parallel tally',
  FLAGGED: 'Flagged',
  CLOSED: 'Closed',
};

/* -------------------------------------------------------------------------- */
/* Blueprint 8.3: result submission workflow                                  */
/* -------------------------------------------------------------------------- */

export const SUBMISSION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'OCR_COMPLETE',
  'DATA_ENTRY_REVIEWED',
  'SECOND_REVIEW_PENDING',
  'VERIFIED',
  'RETURNED',
  'DISPUTED',
  'QUARANTINED',
  'EXCLUDED_FROM_AGGREGATE',
  'ARCHIVED',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const SubmissionStatus = enumObject(SUBMISSION_STATUSES);
export const SubmissionStatusSchema = z.enum(SUBMISSION_STATUSES);
export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  OCR_COMPLETE: 'OCR draft ready',
  DATA_ENTRY_REVIEWED: 'Data entry reviewed',
  SECOND_REVIEW_PENDING: 'Second review pending',
  VERIFIED: 'Verified for parallel tally',
  RETURNED: 'Returned',
  DISPUTED: 'Disputed',
  QUARANTINED: 'Quarantined (form version)',
  EXCLUDED_FROM_AGGREGATE: 'Excluded from aggregate',
  ARCHIVED: 'Archived',
};

/**
 * Allowed submission status transitions. The tally module must enforce these
 * server-side; every transition writes an audit event.
 */
export const SUBMISSION_STATUS_TRANSITIONS: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  DRAFT: ['SUBMITTED', 'ARCHIVED'],
  SUBMITTED: ['OCR_COMPLETE', 'DATA_ENTRY_REVIEWED', 'QUARANTINED', 'RETURNED', 'DISPUTED'],
  OCR_COMPLETE: ['DATA_ENTRY_REVIEWED', 'QUARANTINED', 'RETURNED', 'DISPUTED'],
  DATA_ENTRY_REVIEWED: ['SECOND_REVIEW_PENDING', 'RETURNED', 'DISPUTED'],
  SECOND_REVIEW_PENDING: ['VERIFIED', 'RETURNED', 'DISPUTED'],
  // A verified record leaves the aggregate only by a reasoned exclusion (it stays visible as excluded).
  VERIFIED: ['DISPUTED', 'EXCLUDED_FROM_AGGREGATE'],
  RETURNED: ['SUBMITTED', 'DATA_ENTRY_REVIEWED', 'ARCHIVED'],
  DISPUTED: ['SECOND_REVIEW_PENDING', 'VERIFIED', 'EXCLUDED_FROM_AGGREGATE', 'ARCHIVED'],
  QUARANTINED: ['SUBMITTED', 'EXCLUDED_FROM_AGGREGATE', 'ARCHIVED'],
  EXCLUDED_FROM_AGGREGATE: ['SECOND_REVIEW_PENDING', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionSubmission(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return SUBMISSION_STATUS_TRANSITIONS[from].includes(to);
}

/** Only this status is eligible for the default verified aggregate (blueprint 8.6). */
export const AGGREGATE_ELIGIBLE_STATUS: SubmissionStatus = 'VERIFIED';

export const SUBMISSION_SOURCE_TYPES = [
  'AGENT_UPLOAD',
  'CLERK_UPLOAD',
  'AUTHORISED_CHANNEL',
  'PUBLIC_PORTAL_COPY',
] as const;
export type SubmissionSourceType = (typeof SUBMISSION_SOURCE_TYPES)[number];
export const SubmissionSourceType = enumObject(SUBMISSION_SOURCE_TYPES);
export const SubmissionSourceTypeSchema = z.enum(SUBMISSION_SOURCE_TYPES);
export const SUBMISSION_SOURCE_TYPE_LABELS: Record<SubmissionSourceType, string> = {
  AGENT_UPLOAD: 'Agent upload',
  CLERK_UPLOAD: 'Clerk upload',
  AUTHORISED_CHANNEL: 'Other authorised channel',
  PUBLIC_PORTAL_COPY: 'Copy of publicly published form',
};

export const IMAGE_QUALITY_LEVELS = ['GOOD', 'ACCEPTABLE', 'POOR', 'ILLEGIBLE'] as const;
export type ImageQuality = (typeof IMAGE_QUALITY_LEVELS)[number];
export const ImageQuality = enumObject(IMAGE_QUALITY_LEVELS);
export const ImageQualitySchema = z.enum(IMAGE_QUALITY_LEVELS);

export const RESULT_VALUE_CHANGE_SOURCES = ['OCR', 'MANUAL_ENTRY', 'VERIFIER_CORRECTION', 'SUPERVISOR_RESOLUTION'] as const;
export type ResultValueChangeSource = (typeof RESULT_VALUE_CHANGE_SOURCES)[number];
export const ResultValueChangeSource = enumObject(RESULT_VALUE_CHANGE_SOURCES);
export const ResultValueChangeSourceSchema = z.enum(RESULT_VALUE_CHANGE_SOURCES);

export const OCR_EXTRACTION_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'NOT_CONFIGURED'] as const;
export type OcrExtractionStatus = (typeof OCR_EXTRACTION_STATUSES)[number];
export const OcrExtractionStatus = enumObject(OCR_EXTRACTION_STATUSES);
export const OcrExtractionStatusSchema = z.enum(OCR_EXTRACTION_STATUSES);

export const VALIDATION_OUTCOMES = ['PASS', 'WARNING', 'FAIL'] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];
export const ValidationOutcome = enumObject(VALIDATION_OUTCOMES);
export const ValidationOutcomeSchema = z.enum(VALIDATION_OUTCOMES);
export const VALIDATION_OUTCOME_LABELS: Record<ValidationOutcome, string> = {
  PASS: 'Pass',
  WARNING: 'Warning',
  FAIL: 'Fail',
};

/* -------------------------------------------------------------------------- */
/* Blueprint 8.5: verification and discrepancies                              */
/* -------------------------------------------------------------------------- */

export const VERIFICATION_DECISIONS = ['PASS', 'RETURN', 'DISPUTE'] as const;
export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];
export const VerificationDecision = enumObject(VERIFICATION_DECISIONS);
export const VerificationDecisionSchema = z.enum(VERIFICATION_DECISIONS);
export const VERIFICATION_DECISION_LABELS: Record<VerificationDecision, string> = {
  PASS: 'Pass',
  RETURN: 'Return to submitter',
  DISPUTE: 'Dispute',
};

export const SUPERVISOR_ACTIONS = ['APPROVED', 'REJECTED', 'THIRD_CHECK_REQUESTED'] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];
export const SupervisorAction = enumObject(SUPERVISOR_ACTIONS);
export const SupervisorActionSchema = z.enum(SUPERVISOR_ACTIONS);

export const DISCREPANCY_TYPES = [
  'ARITHMETIC',
  'METADATA',
  'IMAGE_QUALITY',
  'DUPLICATE',
  'CROSS_STAGE_MISMATCH',
  'FORM_VERSION_MISMATCH',
  'REVIEWER_DISAGREEMENT',
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];
export const DiscrepancyType = enumObject(DISCREPANCY_TYPES);
export const DiscrepancyTypeSchema = z.enum(DISCREPANCY_TYPES);
export const DISCREPANCY_TYPE_LABELS: Record<DiscrepancyType, string> = {
  ARITHMETIC: 'Arithmetic',
  METADATA: 'Metadata',
  IMAGE_QUALITY: 'Image quality',
  DUPLICATE: 'Duplicate',
  CROSS_STAGE_MISMATCH: 'Cross-stage mismatch',
  FORM_VERSION_MISMATCH: 'Form version mismatch',
  REVIEWER_DISAGREEMENT: 'Reviewer disagreement',
};
/** Required handling text from blueprint 8.5, shown on the discrepancy case screen. */
export const DISCREPANCY_REQUIRED_HANDLING: Record<DiscrepancyType, string> = {
  ARITHMETIC:
    'Hold from verified aggregate; show exact fields and arithmetic; request second review.',
  METADATA:
    'Flag; verify against approved station registry; retain original submitted metadata.',
  IMAGE_QUALITY: 'Return for clearer copy or manual escalation; do not guess.',
  DUPLICATE:
    'Link records; designate canonical record after review; retain both audit trails.',
  CROSS_STAGE_MISMATCH: 'Create variance case with both source records; no automatic overwrite.',
  FORM_VERSION_MISMATCH:
    'Quarantine until configuration administrator confirms applicable version.',
  REVIEWER_DISAGREEMENT:
    'Escalate to tally supervisor; require a reasoned resolution and a third check if configured.',
};

export const DISCREPANCY_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type DiscrepancySeverity = (typeof DISCREPANCY_SEVERITIES)[number];
export const DiscrepancySeverity = enumObject(DISCREPANCY_SEVERITIES);
export const DiscrepancySeveritySchema = z.enum(DISCREPANCY_SEVERITIES);

export const DISCREPANCY_STATUSES = ['OPEN', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];
export const DiscrepancyStatus = enumObject(DISCREPANCY_STATUSES);
export const DiscrepancyStatusSchema = z.enum(DISCREPANCY_STATUSES);
export const DISCREPANCY_STATUS_LABELS: Record<DiscrepancyStatus, string> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  ESCALATED: 'Escalated',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const DISCREPANCY_LINK_ROLES = ['SOURCE_A', 'SOURCE_B', 'RELATED'] as const;
export type DiscrepancyLinkRole = (typeof DISCREPANCY_LINK_ROLES)[number];
export const DiscrepancyLinkRole = enumObject(DISCREPANCY_LINK_ROLES);
export const DiscrepancyLinkRoleSchema = z.enum(DISCREPANCY_LINK_ROLES);

/* -------------------------------------------------------------------------- */
/* Files, snapshots, incidents, notifications                                 */
/* -------------------------------------------------------------------------- */

export const STORED_FILE_PURPOSES = [
  'RESULT_FORM',
  'EVIDENCE',
  'EXPORT',
  'REFERENCE_IMPORT',
  'OTHER',
  // NGAO360 Office (kept apart from result-form evidence, blueprint 15.2)
  'CORRESPONDENCE',
  'CASE_EVIDENCE',
  'PROJECT_EVIDENCE',
] as const;
export type StoredFilePurpose = (typeof STORED_FILE_PURPOSES)[number];
export const StoredFilePurpose = enumObject(STORED_FILE_PURPOSES);
export const StoredFilePurposeSchema = z.enum(STORED_FILE_PURPOSES);

export const MALWARE_SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'SKIPPED'] as const;
export type MalwareScanStatus = (typeof MALWARE_SCAN_STATUSES)[number];
export const MalwareScanStatus = enumObject(MALWARE_SCAN_STATUSES);
export const MalwareScanStatusSchema = z.enum(MALWARE_SCAN_STATUSES);

export const STORAGE_DRIVERS = ['LOCAL', 'S3'] as const;
export type StorageDriverKind = (typeof STORAGE_DRIVERS)[number];
export const StorageDriverKind = enumObject(STORAGE_DRIVERS);

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const ExportFormat = enumObject(EXPORT_FORMATS);
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);

export const INCIDENT_STATUSES = ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'UNRESOLVED', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatus = enumObject(INCIDENT_STATUSES);
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

export const INCIDENT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type IncidentPriority = (typeof INCIDENT_PRIORITIES)[number];
export const IncidentPriority = enumObject(INCIDENT_PRIORITIES);
export const IncidentPrioritySchema = z.enum(INCIDENT_PRIORITIES);

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationChannel = enumObject(NOTIFICATION_CHANNELS);
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
