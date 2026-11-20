/**
 * Campaign and organisation enums (blueprint 5.1–5.4, 10.2, 10.3, 14, 15.3,
 * 15.4): departments and teams, tasks, events and logistics, the
 * communications content workflow, finance, report templates, notification
 * delivery and the breach register.
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
/* Organisation (blueprint 5.1, S05)                                          */
/* -------------------------------------------------------------------------- */

/** Who may see a department card (and, by default, its records). */
export const DEPARTMENT_VISIBILITIES = ['ORGANISATION', 'DEPARTMENT', 'RESTRICTED'] as const;
export type DepartmentVisibility = (typeof DEPARTMENT_VISIBILITIES)[number];
export const DepartmentVisibility = enumObject(DEPARTMENT_VISIBILITIES);
export const DepartmentVisibilitySchema = z.enum(DEPARTMENT_VISIBILITIES);
export const DEPARTMENT_VISIBILITY_LABELS: Record<DepartmentVisibility, string> = {
  ORGANISATION: 'Visible to the organisation',
  DEPARTMENT: 'Department members only',
  RESTRICTED: 'Restricted (lead and managers)',
};

export const TEAM_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];
export const TeamStatus = enumObject(TEAM_STATUSES);
export const TeamStatusSchema = z.enum(TEAM_STATUSES);
export const TEAM_STATUS_LABELS: Record<TeamStatus, string> = { ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived' };

/** How the team is reached for internal coordination (never a public or voter list). */
export const TEAM_CONTACT_CHANNELS = ['IN_APP', 'EMAIL', 'PHONE', 'MESSAGING_GROUP', 'OTHER'] as const;
export type TeamContactChannel = (typeof TEAM_CONTACT_CHANNELS)[number];
export const TeamContactChannel = enumObject(TEAM_CONTACT_CHANNELS);
export const TeamContactChannelSchema = z.enum(TEAM_CONTACT_CHANNELS);
export const TEAM_CONTACT_CHANNEL_LABELS: Record<TeamContactChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Work email',
  PHONE: 'Phone',
  MESSAGING_GROUP: 'Internal messaging group',
  OTHER: 'Other',
};

export const TEAM_MEMBER_ROLES = ['COORDINATOR', 'MEMBER', 'VOLUNTEER'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];
export const TeamMemberRole = enumObject(TEAM_MEMBER_ROLES);
export const TeamMemberRoleSchema = z.enum(TEAM_MEMBER_ROLES);
export const TEAM_MEMBER_ROLE_LABELS: Record<TeamMemberRole, string> = {
  COORDINATOR: 'Coordinator',
  MEMBER: 'Member',
  VOLUNTEER: 'Volunteer',
};

/* -------------------------------------------------------------------------- */
/* Tasks (blueprint 5.2, S08)                                                 */
/* -------------------------------------------------------------------------- */

export const TASK_STATUSES = [
  'DRAFT',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'SUBMITTED_FOR_REVIEW',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatus = enumObject(TASK_STATUSES);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  DRAFT: 'Draft',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  SUBMITTED_FOR_REVIEW: 'Submitted for review',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
/**
 * Task workflow. COMPLETED and CANCELLED are final (reopen = a new linked
 * task). SUBMITTED_FOR_REVIEW → COMPLETED is the reviewer's approval (reviewer
 * ≠ owner); → IN_PROGRESS is a return with a note. A task without a reviewer
 * may go IN_PROGRESS → COMPLETED directly (the owner closes it).
 */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['IN_PROGRESS', 'BLOCKED', 'DRAFT', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED'],
  BLOCKED: ['READY', 'IN_PROGRESS', 'CANCELLED'],
  SUBMITTED_FOR_REVIEW: ['COMPLETED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}
/** Statuses counted as "open" on the dashboard (blueprint 4.2: not completed, cancelled or archived). */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW'];

export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TaskPriority = enumObject(TASK_PRIORITIES);
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };

/** Where a task was created from (blueprint 5.2: dashboard, project, event, incident or case). */
export const TASK_SOURCE_TYPES = ['DASHBOARD', 'PROJECT', 'EVENT', 'INCIDENT', 'CASE'] as const;
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number];
export const TaskSourceType = enumObject(TASK_SOURCE_TYPES);
export const TaskSourceTypeSchema = z.enum(TASK_SOURCE_TYPES);
export const TASK_SOURCE_TYPE_LABELS: Record<TaskSourceType, string> = {
  DASHBOARD: 'Dashboard',
  PROJECT: 'Project',
  EVENT: 'Event',
  INCIDENT: 'Incident',
  CASE: 'Citizen case',
};

export const TASK_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'ASSIGNED',
  'COLLABORATORS_CHANGED',
  'REVIEWER_CHANGED',
  'STATUS_CHANGED',
  'DEPENDENCY_ADDED',
  'DEPENDENCY_REMOVED',
  'CHECKLIST_UPDATED',
  'COMMENTED',
  'ATTACHMENT_ADDED',
  'EVIDENCE_ADDED',
  'REVIEW_APPROVED',
  'REVIEW_RETURNED',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
export const TaskEventType = enumObject(TASK_EVENT_TYPES);
export const TaskEventTypeSchema = z.enum(TASK_EVENT_TYPES);

export const TASK_ATTACHMENT_KINDS = ['ATTACHMENT', 'COMPLETION_EVIDENCE'] as const;
export type TaskAttachmentKind = (typeof TASK_ATTACHMENT_KINDS)[number];
export const TaskAttachmentKind = enumObject(TASK_ATTACHMENT_KINDS);
export const TaskAttachmentKindSchema = z.enum(TASK_ATTACHMENT_KINDS);

/* -------------------------------------------------------------------------- */
/* Events and logistics (blueprint 5.3, S09)                                  */
/* -------------------------------------------------------------------------- */

export const CAMPAIGN_EVENT_TYPES = [
  'MEETING',
  'TOWN_HALL',
  'PUBLIC_RALLY',
  'TRAINING',
  'PRESS_BRIEFING',
  'FUNDRAISER',
  'COMMUNITY_SERVICE',
  'INTERNAL',
  'OTHER',
] as const;
export type CampaignEventType = (typeof CAMPAIGN_EVENT_TYPES)[number];
export const CampaignEventType = enumObject(CAMPAIGN_EVENT_TYPES);
export const CampaignEventTypeSchema = z.enum(CAMPAIGN_EVENT_TYPES);
export const CAMPAIGN_EVENT_TYPE_LABELS: Record<CampaignEventType, string> = {
  MEETING: 'Meeting',
  TOWN_HALL: 'Town hall',
  PUBLIC_RALLY: 'Public rally',
  TRAINING: 'Training session',
  PRESS_BRIEFING: 'Press briefing',
  FUNDRAISER: 'Fundraiser',
  COMMUNITY_SERVICE: 'Community service',
  INTERNAL: 'Internal event',
  OTHER: 'Other',
};

export const CAMPAIGN_EVENT_STATUSES = ['DRAFT', 'PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED'] as const;
export type CampaignEventStatus = (typeof CAMPAIGN_EVENT_STATUSES)[number];
export const CampaignEventStatus = enumObject(CAMPAIGN_EVENT_STATUSES);
export const CampaignEventStatusSchema = z.enum(CAMPAIGN_EVENT_STATUSES);
export const CAMPAIGN_EVENT_STATUS_LABELS: Record<CampaignEventStatus, string> = {
  DRAFT: 'Draft',
  PLANNED: 'Planned',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
};
export const CAMPAIGN_EVENT_STATUS_TRANSITIONS: Record<CampaignEventStatus, readonly CampaignEventStatus[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['CONFIRMED', 'POSTPONED', 'CANCELLED', 'DRAFT'],
  CONFIRMED: ['IN_PROGRESS', 'POSTPONED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  POSTPONED: ['PLANNED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
export function canTransitionCampaignEvent(from: CampaignEventStatus, to: CampaignEventStatus): boolean {
  return CAMPAIGN_EVENT_STATUS_TRANSITIONS[from].includes(to);
}

export const CAMPAIGN_EVENT_VISIBILITIES = ['INTERNAL', 'INVITED_TEAMS', 'PUBLIC'] as const;
export type CampaignEventVisibility = (typeof CAMPAIGN_EVENT_VISIBILITIES)[number];
export const CampaignEventVisibility = enumObject(CAMPAIGN_EVENT_VISIBILITIES);
export const CampaignEventVisibilitySchema = z.enum(CAMPAIGN_EVENT_VISIBILITIES);
export const CAMPAIGN_EVENT_VISIBILITY_LABELS: Record<CampaignEventVisibility, string> = {
  INTERNAL: 'Internal',
  INVITED_TEAMS: 'Invited teams only',
  PUBLIC: 'Public listing',
};

export const LOGISTICS_ITEM_TYPES = ['VEHICLE', 'EQUIPMENT', 'VENUE_SERVICE', 'MATERIALS', 'CATERING', 'OTHER'] as const;
export type LogisticsItemType = (typeof LOGISTICS_ITEM_TYPES)[number];
export const LogisticsItemType = enumObject(LOGISTICS_ITEM_TYPES);
export const LogisticsItemTypeSchema = z.enum(LOGISTICS_ITEM_TYPES);
export const LOGISTICS_ITEM_TYPE_LABELS: Record<LogisticsItemType, string> = {
  VEHICLE: 'Vehicle',
  EQUIPMENT: 'Equipment',
  VENUE_SERVICE: 'Venue service',
  MATERIALS: 'Materials',
  CATERING: 'Catering',
  OTHER: 'Other',
};

export const LOGISTICS_STATUSES = ['REQUESTED', 'CONFIRMED', 'COLLECTED', 'RETURNED', 'DAMAGED', 'LOST', 'CANCELLED'] as const;
export type LogisticsStatus = (typeof LOGISTICS_STATUSES)[number];
export const LogisticsStatus = enumObject(LOGISTICS_STATUSES);
export const LogisticsStatusSchema = z.enum(LOGISTICS_STATUSES);
export const LOGISTICS_STATUS_LABELS: Record<LogisticsStatus, string> = {
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  COLLECTED: 'Collected',
  RETURNED: 'Returned',
  DAMAGED: 'Returned damaged',
  LOST: 'Lost',
  CANCELLED: 'Cancelled',
};
export const LOGISTICS_STATUS_TRANSITIONS: Record<LogisticsStatus, readonly LogisticsStatus[]> = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COLLECTED', 'CANCELLED'],
  COLLECTED: ['RETURNED', 'DAMAGED', 'LOST'],
  RETURNED: [],
  DAMAGED: [],
  LOST: [],
  CANCELLED: [],
};
export function canTransitionLogistics(from: LogisticsStatus, to: LogisticsStatus): boolean {
  return LOGISTICS_STATUS_TRANSITIONS[from].includes(to);
}

export const CHECK_IN_METHODS = ['MANUAL', 'QR_CODE', 'SIGN_IN_SHEET', 'SELF_CHECK_IN'] as const;
export type CheckInMethod = (typeof CHECK_IN_METHODS)[number];
export const CheckInMethod = enumObject(CHECK_IN_METHODS);
export const CheckInMethodSchema = z.enum(CHECK_IN_METHODS);
export const CHECK_IN_METHOD_LABELS: Record<CheckInMethod, string> = {
  MANUAL: 'Recorded by staff',
  QR_CODE: 'QR code',
  SIGN_IN_SHEET: 'Sign-in sheet',
  SELF_CHECK_IN: 'Self check-in',
};

export const ATTENDANCE_ROLES = ['ORGANISER', 'STAFF', 'VOLUNTEER', 'SPEAKER', 'GUEST', 'PARTICIPANT', 'MEDIA'] as const;
export type AttendanceRole = (typeof ATTENDANCE_ROLES)[number];
export const AttendanceRole = enumObject(ATTENDANCE_ROLES);
export const AttendanceRoleSchema = z.enum(ATTENDANCE_ROLES);
export const ATTENDANCE_ROLE_LABELS: Record<AttendanceRole, string> = {
  ORGANISER: 'Organiser',
  STAFF: 'Staff',
  VOLUNTEER: 'Volunteer',
  SPEAKER: 'Speaker',
  GUEST: 'Guest',
  PARTICIPANT: 'Participant',
  MEDIA: 'Media',
};

export const EVENT_DOCUMENT_KINDS = ['AGENDA', 'PERMIT', 'BRIEFING', 'PHOTO', 'AFTER_ACTION_EVIDENCE', 'OTHER'] as const;
export type EventDocumentKind = (typeof EVENT_DOCUMENT_KINDS)[number];
export const EventDocumentKind = enumObject(EVENT_DOCUMENT_KINDS);
export const EventDocumentKindSchema = z.enum(EVENT_DOCUMENT_KINDS);

export const AFTER_ACTION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export type AfterActionStatus = (typeof AFTER_ACTION_STATUSES)[number];
export const AfterActionStatus = enumObject(AFTER_ACTION_STATUSES);
export const AfterActionStatusSchema = z.enum(AFTER_ACTION_STATUSES);
export const AFTER_ACTION_STATUS_LABELS: Record<AfterActionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted for review',
  APPROVED: 'Approved',
  RETURNED: 'Returned for changes',
};
export const AFTER_ACTION_STATUS_TRANSITIONS: Record<AfterActionStatus, readonly AfterActionStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['APPROVED', 'RETURNED'],
  RETURNED: ['SUBMITTED'],
  APPROVED: [],
};
export function canTransitionAfterAction(from: AfterActionStatus, to: AfterActionStatus): boolean {
  return AFTER_ACTION_STATUS_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------- */
/* Communications content workflow (blueprint 5.4)                            */
/* -------------------------------------------------------------------------- */

export const CONTENT_TYPES = ['NOTICE', 'PRESS_RELEASE', 'BULLETIN', 'WEBSITE_UPDATE', 'EVENT_INFO'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const ContentType = enumObject(CONTENT_TYPES);
export const ContentTypeSchema = z.enum(CONTENT_TYPES);
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  NOTICE: 'Notice',
  PRESS_RELEASE: 'Press release',
  BULLETIN: 'Internal bulletin',
  WEBSITE_UPDATE: 'Website update',
  EVENT_INFO: 'Event information',
};

/**
 * Audience CATEGORY of a content item. These are broad publication channels,
 * never lists of people: the platform does not hold voter lists, does not
 * target individuals and does not send bulk messages to the public
 * (blueprint 5.4, 15.2).
 */
export const CONTENT_AUDIENCES = ['INTERNAL_ALL', 'INTERNAL_DEPARTMENT', 'MEDIA', 'PUBLIC_WEBSITE', 'PUBLIC_NOTICE', 'PARTNERS'] as const;
export type ContentAudience = (typeof CONTENT_AUDIENCES)[number];
export const ContentAudience = enumObject(CONTENT_AUDIENCES);
export const ContentAudienceSchema = z.enum(CONTENT_AUDIENCES);
export const CONTENT_AUDIENCE_LABELS: Record<ContentAudience, string> = {
  INTERNAL_ALL: 'All staff (internal)',
  INTERNAL_DEPARTMENT: 'One department (internal)',
  MEDIA: 'Media',
  PUBLIC_WEBSITE: 'Public website',
  PUBLIC_NOTICE: 'Public notice board',
  PARTNERS: 'Partner organisations',
};

/** Draft → editorial review → authorised approval → publication → archive (blueprint 5.4). */
export const CONTENT_STATUSES = ['DRAFT', 'EDITORIAL_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'WITHDRAWN'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export const ContentStatus = enumObject(CONTENT_STATUSES);
export const ContentStatusSchema = z.enum(CONTENT_STATUSES);
export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  DRAFT: 'Draft',
  EDITORIAL_REVIEW: 'Editorial review',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
  WITHDRAWN: 'Withdrawn',
};
/**
 * Content workflow. Returns go back to DRAFT with a note. A published item is
 * changed only by a CORRECTION revision (status stays PUBLISHED, the
 * correction note is shown with the item), withdrawn with a reason, or
 * archived. ARCHIVED and WITHDRAWN are final.
 */
export const CONTENT_STATUS_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  DRAFT: ['EDITORIAL_REVIEW'],
  EDITORIAL_REVIEW: ['AWAITING_APPROVAL', 'DRAFT'],
  AWAITING_APPROVAL: ['APPROVED', 'DRAFT'],
  APPROVED: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: ['ARCHIVED', 'WITHDRAWN'],
  ARCHIVED: [],
  WITHDRAWN: [],
};
export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return CONTENT_STATUS_TRANSITIONS[from].includes(to);
}

export const CONTENT_REVISION_KINDS = [
  'CREATED',
  'EDITED',
  'SUBMITTED_FOR_REVIEW',
  'RETURNED',
  'EDITORIAL_APPROVED',
  'APPROVED',
  'PUBLISHED',
  'CORRECTED',
  'ARCHIVED',
  'WITHDRAWN',
] as const;
export type ContentRevisionKind = (typeof CONTENT_REVISION_KINDS)[number];
export const ContentRevisionKind = enumObject(CONTENT_REVISION_KINDS);
export const ContentRevisionKindSchema = z.enum(CONTENT_REVISION_KINDS);

/* -------------------------------------------------------------------------- */
/* Finance (blueprint 5, 10.1, 14 Finance transaction, 15.3)                  */
/* -------------------------------------------------------------------------- */

export const FINANCE_ACCOUNT_TYPES = ['BANK', 'MOBILE_MONEY', 'CASH', 'OTHER'] as const;
export type FinanceAccountType = (typeof FINANCE_ACCOUNT_TYPES)[number];
export const FinanceAccountType = enumObject(FINANCE_ACCOUNT_TYPES);
export const FinanceAccountTypeSchema = z.enum(FINANCE_ACCOUNT_TYPES);
export const FINANCE_ACCOUNT_TYPE_LABELS: Record<FinanceAccountType, string> = {
  BANK: 'Bank account',
  MOBILE_MONEY: 'Mobile money',
  CASH: 'Petty cash',
  OTHER: 'Other',
};

export const FINANCE_ACCOUNT_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type FinanceAccountStatus = (typeof FINANCE_ACCOUNT_STATUSES)[number];
export const FinanceAccountStatus = enumObject(FINANCE_ACCOUNT_STATUSES);
export const FinanceAccountStatusSchema = z.enum(FINANCE_ACCOUNT_STATUSES);

export const FINANCE_CATEGORY_KINDS = ['INCOME', 'EXPENSE', 'TRANSFER'] as const;
export type FinanceCategoryKind = (typeof FINANCE_CATEGORY_KINDS)[number];
export const FinanceCategoryKind = enumObject(FINANCE_CATEGORY_KINDS);
export const FinanceCategoryKindSchema = z.enum(FINANCE_CATEGORY_KINDS);

export const FINANCE_PAYEE_KINDS = ['SUPPLIER', 'INDIVIDUAL', 'ORGANISATION', 'STAFF', 'OTHER'] as const;
export type FinancePayeeKind = (typeof FINANCE_PAYEE_KINDS)[number];
export const FinancePayeeKind = enumObject(FINANCE_PAYEE_KINDS);
export const FinancePayeeKindSchema = z.enum(FINANCE_PAYEE_KINDS);
export const FINANCE_PAYEE_KIND_LABELS: Record<FinancePayeeKind, string> = {
  SUPPLIER: 'Supplier',
  INDIVIDUAL: 'Individual',
  ORGANISATION: 'Organisation',
  STAFF: 'Staff member',
  OTHER: 'Other',
};

export const CONTRIBUTION_SOURCE_KINDS = ['INDIVIDUAL', 'ORGANISATION', 'POLITICAL_PARTY', 'OWN_FUNDS', 'OTHER'] as const;
export type ContributionSourceKind = (typeof CONTRIBUTION_SOURCE_KINDS)[number];
export const ContributionSourceKind = enumObject(CONTRIBUTION_SOURCE_KINDS);
export const ContributionSourceKindSchema = z.enum(CONTRIBUTION_SOURCE_KINDS);
export const CONTRIBUTION_SOURCE_KIND_LABELS: Record<ContributionSourceKind, string> = {
  INDIVIDUAL: 'Individual',
  ORGANISATION: 'Organisation',
  POLITICAL_PARTY: 'Political party',
  OWN_FUNDS: "Candidate's own funds",
  OTHER: 'Other',
};

export const FINANCE_TRANSACTION_TYPES = ['CONTRIBUTION', 'EXPENSE', 'TRANSFER', 'REFUND', 'REVERSAL'] as const;
export type FinanceTransactionType = (typeof FINANCE_TRANSACTION_TYPES)[number];
export const FinanceTransactionType = enumObject(FINANCE_TRANSACTION_TYPES);
export const FinanceTransactionTypeSchema = z.enum(FINANCE_TRANSACTION_TYPES);
export const FINANCE_TRANSACTION_TYPE_LABELS: Record<FinanceTransactionType, string> = {
  CONTRIBUTION: 'Contribution',
  EXPENSE: 'Expense',
  TRANSFER: 'Transfer between accounts',
  REFUND: 'Refund',
  REVERSAL: 'Reversing entry',
};

/**
 * Ledger entry lifecycle (S10 request/approve/pay). PAID means settled: paid
 * out for an expense or refund, received and banked for a contribution, moved
 * for a transfer. APPROVED and later entries are immutable; a correction is a
 * REVERSAL entry that, once approved, marks the original REVERSED.
 */
export const FINANCE_TRANSACTION_STATUSES = ['DRAFT', 'REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED', 'REVERSED'] as const;
export type FinanceTransactionStatus = (typeof FINANCE_TRANSACTION_STATUSES)[number];
export const FinanceTransactionStatus = enumObject(FINANCE_TRANSACTION_STATUSES);
export const FinanceTransactionStatusSchema = z.enum(FINANCE_TRANSACTION_STATUSES);
export const FINANCE_TRANSACTION_STATUS_LABELS: Record<FinanceTransactionStatus, string> = {
  DRAFT: 'Draft',
  REQUESTED: 'Awaiting approval',
  APPROVED: 'Approved',
  PAID: 'Paid / settled',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  REVERSED: 'Reversed',
};
export const FINANCE_TRANSACTION_STATUS_TRANSITIONS: Record<FinanceTransactionStatus, readonly FinanceTransactionStatus[]> = {
  DRAFT: ['REQUESTED', 'CANCELLED'],
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PAID', 'REVERSED'],
  PAID: ['REVERSED'],
  REJECTED: [],
  CANCELLED: [],
  REVERSED: [],
};
export function canTransitionFinanceTransaction(from: FinanceTransactionStatus, to: FinanceTransactionStatus): boolean {
  return FINANCE_TRANSACTION_STATUS_TRANSITIONS[from].includes(to);
}
/** Statuses whose financial fields are frozen (DB trigger `finance_transactions_guard`). */
export const LOCKED_FINANCE_STATUSES: readonly FinanceTransactionStatus[] = ['APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED'];
/** Statuses that count in balances, budget vs actual and limit checks. */
export const POSTED_FINANCE_STATUSES: readonly FinanceTransactionStatus[] = ['APPROVED', 'PAID', 'REVERSED'];

export const FINANCE_DOCUMENT_KINDS = ['INVOICE', 'RECEIPT', 'CONTRACT', 'BANK_SLIP', 'MOBILE_MONEY_STATEMENT', 'APPROVAL_MEMO', 'DECLARATION', 'OTHER'] as const;
export type FinanceDocumentKind = (typeof FINANCE_DOCUMENT_KINDS)[number];
export const FinanceDocumentKind = enumObject(FINANCE_DOCUMENT_KINDS);
export const FinanceDocumentKindSchema = z.enum(FINANCE_DOCUMENT_KINDS);

export const FINANCE_TRANSACTION_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'DOCUMENT_ADDED',
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PAID',
  'CANCELLED',
  'REVERSED',
  'COMPLIANCE_EVALUATED',
] as const;
export type FinanceTransactionEventType = (typeof FINANCE_TRANSACTION_EVENT_TYPES)[number];
export const FinanceTransactionEventType = enumObject(FINANCE_TRANSACTION_EVENT_TYPES);
export const FinanceTransactionEventTypeSchema = z.enum(FINANCE_TRANSACTION_EVENT_TYPES);

export const BUDGET_LINE_STATUSES = ['DRAFT', 'APPROVED', 'CLOSED'] as const;
export type BudgetLineStatus = (typeof BUDGET_LINE_STATUSES)[number];
export const BudgetLineStatus = enumObject(BUDGET_LINE_STATUSES);
export const BudgetLineStatusSchema = z.enum(BUDGET_LINE_STATUSES);

/** Kinds of tenant-configured finance limits (blueprint 15.3: never hardcoded). */
export const FINANCE_LIMIT_KINDS = ['SINGLE_SOURCE_CAP_PCT', 'SPENDING_LIMIT', 'REPORTING_DEADLINE'] as const;
export type FinanceLimitKind = (typeof FINANCE_LIMIT_KINDS)[number];
export const FinanceLimitKind = enumObject(FINANCE_LIMIT_KINDS);
export const FinanceLimitKindSchema = z.enum(FINANCE_LIMIT_KINDS);
export const FINANCE_LIMIT_KIND_LABELS: Record<FinanceLimitKind, string> = {
  SINGLE_SOURCE_CAP_PCT: 'Single-source contribution cap (%)',
  SPENDING_LIMIT: 'Spending limit',
  REPORTING_DEADLINE: 'Reporting deadline',
};

/** What a single-source cap percentage is measured against. */
export const FINANCE_CAP_BASES = ['TOTAL_CONTRIBUTIONS', 'SPENDING_LIMIT'] as const;
export type FinanceCapBasis = (typeof FINANCE_CAP_BASES)[number];
export const FinanceCapBasis = enumObject(FINANCE_CAP_BASES);
export const FinanceCapBasisSchema = z.enum(FINANCE_CAP_BASES);

export const LIMIT_ENFORCEMENTS = ['WARN', 'BLOCK'] as const;
export type LimitEnforcement = (typeof LIMIT_ENFORCEMENTS)[number];
export const LimitEnforcement = enumObject(LIMIT_ENFORCEMENTS);
export const LimitEnforcementSchema = z.enum(LIMIT_ENFORCEMENTS);
export const LIMIT_ENFORCEMENT_LABELS: Record<LimitEnforcement, string> = {
  WARN: 'Warn only',
  BLOCK: 'Block approval',
};

/* -------------------------------------------------------------------------- */
/* Reports (blueprint 10.2, S28)                                              */
/* -------------------------------------------------------------------------- */

export const REPORT_TEMPLATE_SCOPES = ['PRIVATE', 'ROLES', 'ORGANISATION'] as const;
export type ReportTemplateScope = (typeof REPORT_TEMPLATE_SCOPES)[number];
export const ReportTemplateScope = enumObject(REPORT_TEMPLATE_SCOPES);
export const ReportTemplateScopeSchema = z.enum(REPORT_TEMPLATE_SCOPES);
export const REPORT_TEMPLATE_SCOPE_LABELS: Record<ReportTemplateScope, string> = {
  PRIVATE: 'Only me',
  ROLES: 'Selected roles',
  ORGANISATION: 'Everyone allowed to use the dataset',
};

/* -------------------------------------------------------------------------- */
/* Notification centre (blueprint 10.3)                                       */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
export const NotificationSeverity = enumObject(NOTIFICATION_SEVERITIES);
export const NotificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  INFO: 'Information',
  WARNING: 'Warning',
  CRITICAL: 'Critical alert',
};

export const NOTIFICATION_DELIVERY_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];
export const NotificationDeliveryStatus = enumObject(NOTIFICATION_DELIVERY_STATUSES);
export const NotificationDeliveryStatusSchema = z.enum(NOTIFICATION_DELIVERY_STATUSES);

export const NOTIFICATION_ACK_ACTIONS = ['ACKNOWLEDGED', 'ESCALATED', 'CLOSED'] as const;
export type NotificationAckAction = (typeof NOTIFICATION_ACK_ACTIONS)[number];
export const NotificationAckAction = enumObject(NOTIFICATION_ACK_ACTIONS);
export const NotificationAckActionSchema = z.enum(NOTIFICATION_ACK_ACTIONS);

/* -------------------------------------------------------------------------- */
/* Breach register (blueprint 15.4)                                           */
/* -------------------------------------------------------------------------- */

/** detect → contain → preserve evidence → assess → notify → remediate → lessons/close (blueprint 15.4). */
export const BREACH_STATUSES = ['DETECTED', 'CONTAINED', 'EVIDENCE_PRESERVED', 'ASSESSED', 'NOTIFIED', 'REMEDIATED', 'CLOSED'] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];
export const BreachStatus = enumObject(BREACH_STATUSES);
export const BreachStatusSchema = z.enum(BREACH_STATUSES);
export const BREACH_STATUS_LABELS: Record<BreachStatus, string> = {
  DETECTED: 'Detected',
  CONTAINED: 'Contained',
  EVIDENCE_PRESERVED: 'Evidence preserved',
  ASSESSED: 'Scope and risk assessed',
  NOTIFIED: 'Notifications made',
  REMEDIATED: 'Remediated',
  CLOSED: 'Closed (lessons documented)',
};
/**
 * Steps may be skipped forward (e.g. no notification required: ASSESSED →
 * REMEDIATED with the decision recorded); CLOSED needs lessons and a closer
 * other than the reporter. A closed record can be reopened (back to ASSESSED).
 */
export const BREACH_STATUS_TRANSITIONS: Record<BreachStatus, readonly BreachStatus[]> = {
  DETECTED: ['CONTAINED', 'EVIDENCE_PRESERVED', 'ASSESSED'],
  CONTAINED: ['EVIDENCE_PRESERVED', 'ASSESSED'],
  EVIDENCE_PRESERVED: ['ASSESSED'],
  ASSESSED: ['NOTIFIED', 'REMEDIATED'],
  NOTIFIED: ['REMEDIATED'],
  REMEDIATED: ['CLOSED'],
  CLOSED: ['ASSESSED'],
};
export function canTransitionBreach(from: BreachStatus, to: BreachStatus): boolean {
  return BREACH_STATUS_TRANSITIONS[from].includes(to);
}

export const BREACH_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];
export const BreachSeverity = enumObject(BREACH_SEVERITIES);
export const BreachSeveritySchema = z.enum(BREACH_SEVERITIES);

export const BREACH_EVENT_TYPES = [
  'DETECTED',
  'CONTAINED',
  'EVIDENCE_PRESERVED',
  'ASSESSED',
  'CONTROLLER_NOTIFIED',
  'REGULATOR_NOTIFIED',
  'SUBJECTS_NOTIFIED',
  'NOTIFICATION_NOT_REQUIRED',
  'REMEDIATED',
  'LESSONS_RECORDED',
  'CLOSED',
  'REOPENED',
  'NOTE',
] as const;
export type BreachEventType = (typeof BREACH_EVENT_TYPES)[number];
export const BreachEventType = enumObject(BREACH_EVENT_TYPES);
export const BreachEventTypeSchema = z.enum(BREACH_EVENT_TYPES);
