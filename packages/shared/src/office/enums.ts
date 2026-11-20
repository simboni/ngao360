/**
 * NGAO360 Office enums (blueprint section 9): correspondence, appointments,
 * meetings, citizen cases, referrals, institutions and development projects.
 *
 * Every value here MUST match the corresponding Prisma enum in
 * packages/db/prisma/schema.prisma (checked by shared.test.ts). Labels are the
 * words shown next to an icon in the UI; never communicate status by colour alone.
 *
 * Office data is kept apart from campaign and tally data (blueprint 15.2): it
 * lives in its own tables, behind its own `office.*` permissions and the
 * `office` tenant module.
 */
import { z } from 'zod';

type EnumObject<T extends readonly string[]> = { readonly [K in T[number]]: K };
function enumObject<const T extends readonly [string, ...string[]]>(values: T): EnumObject<T> {
  return Object.freeze(Object.fromEntries(values.map((v) => [v, v]))) as EnumObject<T>;
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

/** How a person prefers to be contacted (S24 contact preference). */
export const CONTACT_PREFERENCES = ['NONE', 'PHONE', 'SMS', 'EMAIL'] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];
export const ContactPreference = enumObject(CONTACT_PREFERENCES);
export const ContactPreferenceSchema = z.enum(CONTACT_PREFERENCES);
export const CONTACT_PREFERENCE_LABELS: Record<ContactPreference, string> = {
  NONE: 'Do not contact me',
  PHONE: 'Phone call',
  SMS: 'SMS',
  EMAIL: 'Email',
};

/** Verification state of a reported fact (expenditure, milestone, evidence). */
export const VERIFICATION_STATUSES = ['UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'DISPUTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const VerificationStatus = enumObject(VERIFICATION_STATUSES);
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  UNVERIFIED: 'Not verified',
  PENDING_VERIFICATION: 'Verification pending',
  VERIFIED: 'Verified',
  DISPUTED: 'Disputed',
};

/* -------------------------------------------------------------------------- */
/* Correspondence (blueprint 9.1, S23)                                        */
/* -------------------------------------------------------------------------- */

export const CORRESPONDENCE_DIRECTIONS = ['INCOMING', 'OUTGOING'] as const;
export type CorrespondenceDirection = (typeof CORRESPONDENCE_DIRECTIONS)[number];
export const CorrespondenceDirection = enumObject(CORRESPONDENCE_DIRECTIONS);
export const CorrespondenceDirectionSchema = z.enum(CORRESPONDENCE_DIRECTIONS);
export const CORRESPONDENCE_DIRECTION_LABELS: Record<CorrespondenceDirection, string> = {
  INCOMING: 'Incoming',
  OUTGOING: 'Outgoing',
};

export const CORRESPONDENCE_CHANNELS = ['POST', 'HAND_DELIVERY', 'EMAIL', 'COURIER', 'INTERNAL_MEMO', 'OTHER'] as const;
export type CorrespondenceChannel = (typeof CORRESPONDENCE_CHANNELS)[number];
export const CorrespondenceChannel = enumObject(CORRESPONDENCE_CHANNELS);
export const CorrespondenceChannelSchema = z.enum(CORRESPONDENCE_CHANNELS);
export const CORRESPONDENCE_CHANNEL_LABELS: Record<CorrespondenceChannel, string> = {
  POST: 'Post',
  HAND_DELIVERY: 'Hand delivery',
  EMAIL: 'Email',
  COURIER: 'Courier',
  INTERNAL_MEMO: 'Internal memo',
  OTHER: 'Other',
};

export const CORRESPONDENCE_CATEGORIES = [
  'GENERAL',
  'INVITATION',
  'PETITION',
  'COMPLAINT',
  'REQUEST_FOR_SUPPORT',
  'GOVERNMENT_CIRCULAR',
  'INTERGOVERNMENTAL',
  'LEGAL',
  'MEDIA',
  'FINANCE',
  'OTHER',
] as const;
export type CorrespondenceCategory = (typeof CORRESPONDENCE_CATEGORIES)[number];
export const CorrespondenceCategory = enumObject(CORRESPONDENCE_CATEGORIES);
export const CorrespondenceCategorySchema = z.enum(CORRESPONDENCE_CATEGORIES);
export const CORRESPONDENCE_CATEGORY_LABELS: Record<CorrespondenceCategory, string> = {
  GENERAL: 'General',
  INVITATION: 'Invitation',
  PETITION: 'Petition',
  COMPLAINT: 'Complaint',
  REQUEST_FOR_SUPPORT: 'Request for support',
  GOVERNMENT_CIRCULAR: 'Government circular',
  INTERGOVERNMENTAL: 'Intergovernmental',
  LEGAL: 'Legal',
  MEDIA: 'Media',
  FINANCE: 'Finance',
  OTHER: 'Other',
};

export const CORRESPONDENCE_STATUSES = [
  'DRAFT',
  'RECEIVED',
  'ASSIGNED',
  'IN_PROGRESS',
  'RESPONDED',
  'SENT',
  'FILED',
  'ARCHIVED',
] as const;
export type CorrespondenceStatus = (typeof CORRESPONDENCE_STATUSES)[number];
export const CorrespondenceStatus = enumObject(CORRESPONDENCE_STATUSES);
export const CorrespondenceStatusSchema = z.enum(CORRESPONDENCE_STATUSES);
export const CORRESPONDENCE_STATUS_LABELS: Record<CorrespondenceStatus, string> = {
  DRAFT: 'Draft',
  RECEIVED: 'Received',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  RESPONDED: 'Responded',
  SENT: 'Sent',
  FILED: 'Filed',
  ARCHIVED: 'Archived',
};
/**
 * Incoming: RECEIVED → ASSIGNED → IN_PROGRESS → RESPONDED → FILED → ARCHIVED.
 * Outgoing: DRAFT → SENT → FILED → ARCHIVED. Items that need no response may be
 * filed directly. Records are never deleted.
 */
export const CORRESPONDENCE_STATUS_TRANSITIONS: Record<CorrespondenceStatus, readonly CorrespondenceStatus[]> = {
  DRAFT: ['SENT', 'ARCHIVED'],
  RECEIVED: ['ASSIGNED', 'FILED'],
  ASSIGNED: ['IN_PROGRESS', 'RESPONDED', 'FILED'],
  IN_PROGRESS: ['RESPONDED', 'FILED'],
  RESPONDED: ['FILED'],
  SENT: ['FILED'],
  FILED: ['ARCHIVED'],
  ARCHIVED: [],
};
export function canTransitionCorrespondence(from: CorrespondenceStatus, to: CorrespondenceStatus): boolean {
  return CORRESPONDENCE_STATUS_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------- */
/* Appointments and meetings (blueprint 9.1)                                  */
/* -------------------------------------------------------------------------- */

export const APPOINTMENT_SOURCES = ['WALK_IN', 'PHONE', 'EMAIL', 'LETTER', 'REFERRAL', 'OTHER'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
export const AppointmentSource = enumObject(APPOINTMENT_SOURCES);
export const AppointmentSourceSchema = z.enum(APPOINTMENT_SOURCES);

export const APPOINTMENT_STATUSES = [
  'REQUESTED',
  'CONFIRMED',
  'RESCHEDULED',
  'DECLINED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const AppointmentStatus = enumObject(APPOINTMENT_STATUSES);
export const AppointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  RESCHEDULED: 'Rescheduled',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
  NO_SHOW: 'Did not attend',
};
export const APPOINTMENT_STATUS_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  REQUESTED: ['CONFIRMED', 'DECLINED', 'CANCELLED'],
  CONFIRMED: ['RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'],
  RESCHEDULED: ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'],
  DECLINED: [],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: ['RESCHEDULED'],
};
export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_STATUS_TRANSITIONS[from].includes(to);
}

export const MEETING_STATUSES = ['SCHEDULED', 'HELD', 'CANCELLED'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const MeetingStatus = enumObject(MEETING_STATUSES);
export const MeetingStatusSchema = z.enum(MEETING_STATUSES);
export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  SCHEDULED: 'Scheduled',
  HELD: 'Held',
  CANCELLED: 'Cancelled',
};

export const ACTION_ITEM_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];
export const ActionItemStatus = enumObject(ACTION_ITEM_STATUSES);
export const ActionItemStatusSchema = z.enum(ACTION_ITEM_STATUSES);

/* -------------------------------------------------------------------------- */
/* Citizen cases (blueprint 9.2, S24/S25)                                     */
/* -------------------------------------------------------------------------- */

export const CASE_CATEGORIES = [
  'WATER_SANITATION',
  'ROADS_TRANSPORT',
  'HEALTH',
  'EDUCATION_BURSARY',
  'AGRICULTURE_LIVESTOCK',
  'LAND_HOUSING',
  'TRADE_MARKETS',
  'ENVIRONMENT_WASTE',
  'SOCIAL_SUPPORT',
  'PUBLIC_SERVICE_COMPLAINT',
  'SECURITY_REFERRAL',
  'OTHER',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];
export const CaseCategory = enumObject(CASE_CATEGORIES);
export const CaseCategorySchema = z.enum(CASE_CATEGORIES);
export const CASE_CATEGORY_LABELS: Record<CaseCategory, string> = {
  WATER_SANITATION: 'Water and sanitation',
  ROADS_TRANSPORT: 'Roads and transport',
  HEALTH: 'Health services',
  EDUCATION_BURSARY: 'Education and bursaries',
  AGRICULTURE_LIVESTOCK: 'Agriculture and livestock',
  LAND_HOUSING: 'Land and housing',
  TRADE_MARKETS: 'Trade and markets',
  ENVIRONMENT_WASTE: 'Environment and waste',
  SOCIAL_SUPPORT: 'Social support',
  PUBLIC_SERVICE_COMPLAINT: 'Complaint about a public service',
  SECURITY_REFERRAL: 'Security matter (referred to the responsible authority)',
  OTHER: 'Other',
};

export const CASE_SOURCES = ['PORTAL', 'WALK_IN', 'PHONE', 'LETTER', 'EMAIL', 'SMS', 'OUTREACH'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];
export const CaseSource = enumObject(CASE_SOURCES);
export const CaseSourceSchema = z.enum(CASE_SOURCES);
export const CASE_SOURCE_LABELS: Record<CaseSource, string> = {
  PORTAL: 'Public portal',
  WALK_IN: 'Walk-in',
  PHONE: 'Phone',
  LETTER: 'Letter',
  EMAIL: 'Email',
  SMS: 'SMS',
  OUTREACH: 'Outreach visit',
};

export const CASE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];
export const CasePriority = enumObject(CASE_PRIORITIES);
export const CasePrioritySchema = z.enum(CASE_PRIORITIES);
export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

/** Blueprint 9.2 case stages. "Closed / reopened" is split so reopening is its own state. */
export const CASE_STATUSES = [
  'SUBMITTED',
  'TRIAGE',
  'ASSIGNED',
  'IN_PROGRESS',
  'REFERRED',
  'RESOLUTION_PROPOSED',
  'CITIZEN_FEEDBACK',
  'CLOSED',
  'REOPENED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CaseStatus = enumObject(CASE_STATUSES);
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  SUBMITTED: 'Submitted',
  TRIAGE: 'Triage',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  REFERRED: 'Referred',
  RESOLUTION_PROPOSED: 'Resolution proposed',
  CITIZEN_FEEDBACK: 'Awaiting citizen feedback',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};
/**
 * Allowed case transitions. Reopening a closed case is a transition to
 * REOPENED (a new event), never a deletion or an edit of the closure.
 */
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  SUBMITTED: ['TRIAGE', 'CLOSED'],
  TRIAGE: ['ASSIGNED', 'REFERRED', 'CLOSED'],
  ASSIGNED: ['IN_PROGRESS', 'REFERRED', 'RESOLUTION_PROPOSED'],
  IN_PROGRESS: ['REFERRED', 'RESOLUTION_PROPOSED'],
  REFERRED: ['IN_PROGRESS', 'RESOLUTION_PROPOSED'],
  RESOLUTION_PROPOSED: ['CITIZEN_FEEDBACK', 'IN_PROGRESS', 'CLOSED'],
  CITIZEN_FEEDBACK: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['ASSIGNED', 'IN_PROGRESS'],
};
export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * What a requester sees on the tracking page. Internal stages are collapsed
 * into plain-language public stages; internal notes are never shown.
 */
export const PUBLIC_CASE_STAGES = ['RECEIVED', 'UNDER_REVIEW', 'IN_PROGRESS', 'REFERRED', 'RESOLUTION_PROPOSED', 'CLOSED'] as const;
export type PublicCaseStage = (typeof PUBLIC_CASE_STAGES)[number];
export const PublicCaseStageSchema = z.enum(PUBLIC_CASE_STAGES);
export const PUBLIC_CASE_STAGE_LABELS: Record<PublicCaseStage, string> = {
  RECEIVED: 'Received',
  UNDER_REVIEW: 'Being reviewed',
  IN_PROGRESS: 'Being worked on',
  REFERRED: 'Referred to the responsible institution',
  RESOLUTION_PROPOSED: 'Resolution proposed — your feedback is welcome',
  CLOSED: 'Closed',
};
export const CASE_STATUS_PUBLIC_STAGE: Record<CaseStatus, PublicCaseStage> = {
  SUBMITTED: 'RECEIVED',
  TRIAGE: 'UNDER_REVIEW',
  ASSIGNED: 'IN_PROGRESS',
  IN_PROGRESS: 'IN_PROGRESS',
  REFERRED: 'REFERRED',
  RESOLUTION_PROPOSED: 'RESOLUTION_PROPOSED',
  CITIZEN_FEEDBACK: 'RESOLUTION_PROPOSED',
  CLOSED: 'CLOSED',
  REOPENED: 'UNDER_REVIEW',
};

export const CASE_CLOSURE_REASONS = [
  'RESOLVED',
  'REFERRED_OUT',
  'DUPLICATE',
  'OUT_OF_JURISDICTION',
  'NO_RESPONSE_FROM_REQUESTER',
  'WITHDRAWN',
  'ABUSIVE_OR_SPAM',
] as const;
export type CaseClosureReason = (typeof CASE_CLOSURE_REASONS)[number];
export const CaseClosureReason = enumObject(CASE_CLOSURE_REASONS);
export const CaseClosureReasonSchema = z.enum(CASE_CLOSURE_REASONS);
export const CASE_CLOSURE_REASON_LABELS: Record<CaseClosureReason, string> = {
  RESOLVED: 'Resolved',
  REFERRED_OUT: 'Handed over to the responsible institution',
  DUPLICATE: 'Duplicate of another request',
  OUT_OF_JURISDICTION: 'Outside this office’s mandate',
  NO_RESPONSE_FROM_REQUESTER: 'No response from the requester',
  WITHDRAWN: 'Withdrawn by the requester',
  ABUSIVE_OR_SPAM: 'Abusive or spam',
};

export const CASE_EVENT_TYPES = [
  'SUBMITTED',
  'STATUS_CHANGED',
  'ASSIGNED',
  'NOTE',
  'PUBLIC_UPDATE',
  'CONTACT_ATTEMPT',
  'EVIDENCE_ADDED',
  'REFERRED',
  'REFERRAL_UPDATED',
  'RESOLUTION_PROPOSED',
  'CITIZEN_FEEDBACK',
  'CLOSED',
  'REOPENED',
] as const;
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];
export const CaseEventType = enumObject(CASE_EVENT_TYPES);
export const CaseEventTypeSchema = z.enum(CASE_EVENT_TYPES);

/**
 * PUBLIC: shown to the requester on the tracking page (reference + tracking
 * code). It is never listed publicly. INTERNAL: staff only, and internal notes
 * additionally need `office.cases.internal_notes`.
 */
export const CASE_EVENT_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export type CaseEventVisibility = (typeof CASE_EVENT_VISIBILITIES)[number];
export const CaseEventVisibility = enumObject(CASE_EVENT_VISIBILITIES);
export const CaseEventVisibilitySchema = z.enum(CASE_EVENT_VISIBILITIES);

export const CASE_EVENT_ACTOR_TYPES = ['STAFF', 'REQUESTER', 'SYSTEM'] as const;
export type CaseEventActorType = (typeof CASE_EVENT_ACTOR_TYPES)[number];
export const CaseEventActorType = enumObject(CASE_EVENT_ACTOR_TYPES);
export const CaseEventActorTypeSchema = z.enum(CASE_EVENT_ACTOR_TYPES);

export const CITIZEN_FEEDBACK_RESPONSES = ['CONFIRM_RESOLVED', 'DISPUTE', 'ADDITIONAL_INFORMATION'] as const;
export type CitizenFeedbackResponse = (typeof CITIZEN_FEEDBACK_RESPONSES)[number];
export const CitizenFeedbackResponseSchema = z.enum(CITIZEN_FEEDBACK_RESPONSES);

export const REFERRAL_STATUSES = ['SENT', 'ACKNOWLEDGED', 'RESPONDED', 'NO_RESPONSE', 'CLOSED'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const ReferralStatus = enumObject(REFERRAL_STATUSES);
export const ReferralStatusSchema = z.enum(REFERRAL_STATUSES);
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  SENT: 'Sent',
  ACKNOWLEDGED: 'Acknowledged',
  RESPONDED: 'Responded',
  NO_RESPONSE: 'No response',
  CLOSED: 'Closed',
};

/* -------------------------------------------------------------------------- */
/* Institutions (responsible bodies)                                          */
/* -------------------------------------------------------------------------- */

export const INSTITUTION_TYPES = [
  'COUNTY_DEPARTMENT',
  'COUNTY_ENTITY',
  'COUNTY_ASSEMBLY',
  'NATIONAL_MINISTRY',
  'NATIONAL_AGENCY',
  'STATE_CORPORATION',
  'CONSTITUENCY_FUND',
  'DEVELOPMENT_PARTNER',
  'NON_GOVERNMENTAL',
  'CONTRACTOR',
  'OTHER',
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];
export const InstitutionType = enumObject(INSTITUTION_TYPES);
export const InstitutionTypeSchema = z.enum(INSTITUTION_TYPES);
export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  COUNTY_DEPARTMENT: 'County government department',
  COUNTY_ENTITY: 'County entity',
  COUNTY_ASSEMBLY: 'County assembly',
  NATIONAL_MINISTRY: 'National ministry or state department',
  NATIONAL_AGENCY: 'National agency',
  STATE_CORPORATION: 'State corporation',
  CONSTITUENCY_FUND: 'Constituency development fund',
  DEVELOPMENT_PARTNER: 'Development partner',
  NON_GOVERNMENTAL: 'Non-governmental organisation',
  CONTRACTOR: 'Contractor',
  OTHER: 'Other',
};

/* -------------------------------------------------------------------------- */
/* Development projects (blueprint 9.3, S26/S27)                              */
/* -------------------------------------------------------------------------- */

export const PROJECT_CATEGORIES = [
  'WATER_SANITATION',
  'ROADS_INFRASTRUCTURE',
  'HEALTH',
  'EDUCATION',
  'AGRICULTURE',
  'TRADE_MARKETS',
  'ENERGY',
  'ENVIRONMENT',
  'SOCIAL_SERVICES',
  'YOUTH_SPORTS',
  'HOUSING_URBAN',
  'ICT',
  'OTHER',
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];
export const ProjectCategory = enumObject(PROJECT_CATEGORIES);
export const ProjectCategorySchema = z.enum(PROJECT_CATEGORIES);
export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  WATER_SANITATION: 'Water and sanitation',
  ROADS_INFRASTRUCTURE: 'Roads and infrastructure',
  HEALTH: 'Health',
  EDUCATION: 'Education',
  AGRICULTURE: 'Agriculture',
  TRADE_MARKETS: 'Trade and markets',
  ENERGY: 'Energy',
  ENVIRONMENT: 'Environment',
  SOCIAL_SERVICES: 'Social services',
  YOUTH_SPORTS: 'Youth and sports',
  HOUSING_URBAN: 'Housing and urban development',
  ICT: 'ICT',
  OTHER: 'Other',
};

/** Where the commitment to the project comes from (blueprint 9.3 "source of commitment"). */
export const COMMITMENT_SOURCES = [
  'MANIFESTO_PLEDGE',
  'PUBLIC_STATEMENT',
  'COUNTY_INTEGRATED_DEVELOPMENT_PLAN',
  'ANNUAL_DEVELOPMENT_PLAN',
  'COUNTY_BUDGET',
  'NATIONAL_BUDGET',
  'CONSTITUENCY_FUND',
  'DEVELOPMENT_PARTNER_AGREEMENT',
  'CITIZEN_REQUEST',
  'OTHER',
] as const;
export type CommitmentSource = (typeof COMMITMENT_SOURCES)[number];
export const CommitmentSource = enumObject(COMMITMENT_SOURCES);
export const CommitmentSourceSchema = z.enum(COMMITMENT_SOURCES);
export const COMMITMENT_SOURCE_LABELS: Record<CommitmentSource, string> = {
  MANIFESTO_PLEDGE: 'Manifesto pledge',
  PUBLIC_STATEMENT: 'Public statement',
  COUNTY_INTEGRATED_DEVELOPMENT_PLAN: 'County Integrated Development Plan',
  ANNUAL_DEVELOPMENT_PLAN: 'Annual Development Plan',
  COUNTY_BUDGET: 'County budget',
  NATIONAL_BUDGET: 'National budget',
  CONSTITUENCY_FUND: 'Constituency development fund',
  DEVELOPMENT_PARTNER_AGREEMENT: 'Development partner agreement',
  CITIZEN_REQUEST: 'Citizen request',
  OTHER: 'Other',
};

export const FUNDING_SOURCES = [
  'COUNTY_GOVERNMENT',
  'NATIONAL_GOVERNMENT',
  'CONSTITUENCY_FUND',
  'DEVELOPMENT_PARTNER',
  'PUBLIC_PRIVATE_PARTNERSHIP',
  'OTHER',
  'NOT_YET_IDENTIFIED',
] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];
export const FundingSource = enumObject(FUNDING_SOURCES);
export const FundingSourceSchema = z.enum(FUNDING_SOURCES);
export const FUNDING_SOURCE_LABELS: Record<FundingSource, string> = {
  COUNTY_GOVERNMENT: 'County government',
  NATIONAL_GOVERNMENT: 'National government',
  CONSTITUENCY_FUND: 'Constituency development fund',
  DEVELOPMENT_PARTNER: 'Development partner',
  PUBLIC_PRIVATE_PARTNERSHIP: 'Public–private partnership',
  OTHER: 'Other',
  NOT_YET_IDENTIFIED: 'Not yet identified',
};

/** Blueprint 9.3 status list. */
export const PROJECT_STATUSES = [
  'PROPOSED',
  'COMMITTED',
  'APPROVED',
  'FUNDED',
  'PROCUREMENT',
  'ONGOING',
  'DELAYED',
  'COMPLETED',
  'VERIFIED_COMPLETED',
  'CANCELLED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const ProjectStatus = enumObject(PROJECT_STATUSES);
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PROPOSED: 'Proposed',
  COMMITTED: 'Commitment (not yet approved)',
  APPROVED: 'Approved',
  FUNDED: 'Funded',
  PROCUREMENT: 'In procurement',
  ONGOING: 'Ongoing',
  DELAYED: 'Delayed',
  COMPLETED: 'Reported complete (not yet verified)',
  VERIFIED_COMPLETED: 'Verified complete',
  CANCELLED: 'Cancelled',
};
/**
 * Coarse kind of a project status, so the public view always distinguishes a
 * commitment from an approved project and from verified completion.
 */
export const PROJECT_STAGE_KINDS = ['COMMITMENT', 'APPROVED', 'IMPLEMENTATION', 'REPORTED_COMPLETE', 'VERIFIED_COMPLETE', 'CANCELLED'] as const;
export type ProjectStageKind = (typeof PROJECT_STAGE_KINDS)[number];
export const ProjectStageKindSchema = z.enum(PROJECT_STAGE_KINDS);
export const PROJECT_STAGE_KIND: Record<ProjectStatus, ProjectStageKind> = {
  PROPOSED: 'COMMITMENT',
  COMMITTED: 'COMMITMENT',
  APPROVED: 'APPROVED',
  FUNDED: 'APPROVED',
  PROCUREMENT: 'IMPLEMENTATION',
  ONGOING: 'IMPLEMENTATION',
  DELAYED: 'IMPLEMENTATION',
  COMPLETED: 'REPORTED_COMPLETE',
  VERIFIED_COMPLETED: 'VERIFIED_COMPLETE',
  CANCELLED: 'CANCELLED',
};
export const PROJECT_STAGE_KIND_LABELS: Record<ProjectStageKind, string> = {
  COMMITMENT: 'Commitment — not yet an approved project',
  APPROVED: 'Approved project',
  IMPLEMENTATION: 'Under implementation',
  REPORTED_COMPLETE: 'Reported complete — awaiting independent verification',
  VERIFIED_COMPLETE: 'Completion verified',
  CANCELLED: 'Cancelled',
};
/**
 * Allowed project transitions. VERIFIED_COMPLETED needs `office.projects.verify`,
 * a verifier who is not the person who reported completion, and verified
 * non-photographic evidence (see `completionEvidenceSufficient`). A verified
 * completion can be withdrawn (back to ONGOING) with a reason.
 */
export const PROJECT_STATUS_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  PROPOSED: ['COMMITTED', 'APPROVED', 'CANCELLED'],
  COMMITTED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['FUNDED', 'PROCUREMENT', 'ONGOING', 'CANCELLED'],
  FUNDED: ['PROCUREMENT', 'ONGOING', 'CANCELLED'],
  PROCUREMENT: ['ONGOING', 'DELAYED', 'CANCELLED'],
  ONGOING: ['DELAYED', 'COMPLETED', 'CANCELLED'],
  DELAYED: ['ONGOING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['VERIFIED_COMPLETED', 'ONGOING'],
  VERIFIED_COMPLETED: ['ONGOING'],
  CANCELLED: [],
};
export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}

export const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DONE', 'DELAYED', 'CANCELLED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export const MilestoneStatus = enumObject(MILESTONE_STATUSES);
export const MilestoneStatusSchema = z.enum(MILESTONE_STATUSES);
export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  DONE: 'Reported done',
  DELAYED: 'Delayed',
  CANCELLED: 'Cancelled',
};

export const PROJECT_EVIDENCE_TYPES = [
  'PHOTO',
  'INSPECTION_REPORT',
  'COMPLETION_CERTIFICATE',
  'HANDOVER_DOCUMENT',
  'PAYMENT_RECORD',
  'CONTRACT_DOCUMENT',
  'MEETING_MINUTES',
  'OTHER_DOCUMENT',
] as const;
export type ProjectEvidenceType = (typeof PROJECT_EVIDENCE_TYPES)[number];
export const ProjectEvidenceType = enumObject(PROJECT_EVIDENCE_TYPES);
export const ProjectEvidenceTypeSchema = z.enum(PROJECT_EVIDENCE_TYPES);
export const PROJECT_EVIDENCE_TYPE_LABELS: Record<ProjectEvidenceType, string> = {
  PHOTO: 'Progress photograph',
  INSPECTION_REPORT: 'Inspection report',
  COMPLETION_CERTIFICATE: 'Completion certificate',
  HANDOVER_DOCUMENT: 'Handover document',
  PAYMENT_RECORD: 'Payment record',
  CONTRACT_DOCUMENT: 'Contract document',
  MEETING_MINUTES: 'Meeting minutes',
  OTHER_DOCUMENT: 'Other document',
};
/** Evidence types that can support a completion verification. A photograph alone never can. */
export const COMPLETION_EVIDENCE_TYPES: readonly ProjectEvidenceType[] = [
  'INSPECTION_REPORT',
  'COMPLETION_CERTIFICATE',
  'HANDOVER_DOCUMENT',
];

/**
 * True when the evidence set can support marking a project VERIFIED_COMPLETED:
 * at least one VERIFIED item of a completion type (inspection report,
 * completion certificate or handover document). Photographs never suffice on
 * their own (blueprint 9.3).
 */
export function completionEvidenceSufficient(
  evidence: ReadonlyArray<{ type: ProjectEvidenceType; verificationStatus: VerificationStatus }>,
): boolean {
  return evidence.some((e) => e.verificationStatus === 'VERIFIED' && COMPLETION_EVIDENCE_TYPES.includes(e.type));
}
