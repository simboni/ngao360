/**
 * Administration DTOs: users, roles, role assignments, audit log.
 */
import { z } from 'zod';
import { AuditActorTypeSchema, ScopeTypeSchema, UserStatusSchema } from '../enums';
import { PermissionKeySchema } from '../permissions';
import {
  IsoDateTimeSchema,
  PaginationQuerySchema,
  ReasonSchema,
  UserRefSchema,
  UuidSchema,
} from './common';

/* ---------------------------------- Users ---------------------------------- */

export const RoleAssignmentSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  roleId: UuidSchema,
  roleKey: z.string(),
  roleName: z.string(),
  scopeType: ScopeTypeSchema,
  geographicUnitId: UuidSchema.nullable(),
  geographicUnitName: z.string().nullable(),
  pollingStationId: UuidSchema.nullable(),
  pollingStationName: z.string().nullable(),
  /** Station code of a POLLING_STATION grant; the grant follows this code across registry versions. */
  pollingStationCode: z.string().nullable().optional(),
  electionCycleId: UuidSchema.nullable(),
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  grantedBy: UserRefSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const UserSummarySchema = z.object({
  id: UuidSchema,
  email: z.string(),
  phone: z.string().nullable(),
  displayName: z.string(),
  status: UserStatusSchema,
  mfaEnabled: z.boolean(),
  lastLoginAt: IsoDateTimeSchema.nullable(),
  roles: z.array(z.object({ key: z.string(), name: z.string(), scopeType: ScopeTypeSchema })),
  createdAt: IsoDateTimeSchema,
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserDetailSchema = UserSummarySchema.extend({
  assignments: z.array(RoleAssignmentSchema),
  privacyNoticeVersion: z.string().nullable(),
  privacyNoticeAcceptedAt: IsoDateTimeSchema.nullable(),
  /**
   * Present only in the response that issues an invitation (create or
   * re-issue). The raw token is never stored and is not shown again; relay it
   * to the invited person through a separate channel.
   */
  invitation: z
    .object({ token: z.string(), expiresAt: IsoDateTimeSchema, acceptPath: z.string() })
    .optional(),
});
export type UserDetail = z.infer<typeof UserDetailSchema>;

export const UserQuerySchema = PaginationQuerySchema.extend({
  status: UserStatusSchema.optional(),
  roleKey: z.string().optional(),
});
export type UserQuery = z.infer<typeof UserQuerySchema>;

export const PasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256)
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');

export const CreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(32).nullable().optional(),
  displayName: z.string().trim().min(2).max(200),
  // No initial password: administrators never choose another person's password
  // (blueprint 3.2). The user is INVITED and redeems a single-use invitation.
  // The key is refused outright so an old client cannot silently send one.
  initialPassword: z
    .never({ message: 'Administrators cannot set a password for another person; the user sets it from the invitation' })
    .optional(),
  roleAssignments: z
    .array(
      z.object({
        roleId: UuidSchema,
        scopeType: ScopeTypeSchema.default('ORGANISATION'),
        geographicUnitId: UuidSchema.nullable().default(null),
        pollingStationId: UuidSchema.nullable().default(null),
        electionCycleId: UuidSchema.nullable().default(null),
        expiresAt: IsoDateTimeSchema.nullable().default(null),
      }),
    )
    .default([]),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  displayName: z.string().trim().min(2).max(200).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
});
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const UserStatusChangeSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  reason: ReasonSchema,
});
export type UserStatusChange = z.infer<typeof UserStatusChangeSchema>;

export const ResetMfaSchema = z.object({ reason: ReasonSchema });
export type ResetMfa = z.infer<typeof ResetMfaSchema>;

/* ---------------------------------- Roles ---------------------------------- */

export const PermissionSchema = z.object({
  key: PermissionKeySchema,
  module: z.string(),
  action: z.string(),
  description: z.string(),
  highRisk: z.boolean(),
});
export type Permission = z.infer<typeof PermissionSchema>;

export const RoleSchema = z.object({
  id: UuidSchema,
  key: z.string(),
  name: z.string(),
  description: z.string(),
  restrictions: z.string().nullable(),
  isSystem: z.boolean(),
  mfaRequired: z.boolean(),
  permissions: z.array(PermissionKeySchema),
  assignmentCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Role = z.infer<typeof RoleSchema>;

export const CreateRoleSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).default(''),
  mfaRequired: z.boolean().default(false),
  permissions: z.array(PermissionKeySchema).min(1),
});
export type CreateRole = z.infer<typeof CreateRoleSchema>;

/** System roles cannot be edited; clone them into a custom role instead. */
export const UpdateRoleSchema = CreateRoleSchema.omit({ key: true }).partial().extend({
  reason: ReasonSchema,
});
export type UpdateRole = z.infer<typeof UpdateRoleSchema>;

export const CreateRoleAssignmentSchema = z
  .object({
    userId: UuidSchema,
    roleId: UuidSchema,
    scopeType: ScopeTypeSchema.default('ORGANISATION'),
    geographicUnitId: UuidSchema.nullable().default(null),
    pollingStationId: UuidSchema.nullable().default(null),
    electionCycleId: UuidSchema.nullable().default(null),
    validFrom: IsoDateTimeSchema.optional(),
    expiresAt: IsoDateTimeSchema.nullable().default(null),
    reason: ReasonSchema,
  })
  .refine(
    (v) =>
      v.scopeType === 'ORGANISATION'
        ? v.geographicUnitId === null && v.pollingStationId === null
        : v.scopeType === 'POLLING_STATION'
          ? v.pollingStationId !== null
          : v.geographicUnitId !== null,
    { message: 'Scope target does not match scopeType', path: ['scopeType'] },
  );
export type CreateRoleAssignment = z.infer<typeof CreateRoleAssignmentSchema>;

export const RevokeRoleAssignmentSchema = z.object({ reason: ReasonSchema });
export type RevokeRoleAssignment = z.infer<typeof RevokeRoleAssignmentSchema>;

/* -------------------------------- Audit log -------------------------------- */

export const AuditEventSchema = z.object({
  id: UuidSchema,
  seq: z.string(),
  actor: UserRefSchema.nullable(),
  actorType: AuditActorTypeSchema,
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  /** Redacted snapshots (secrets removed). */
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  sourceIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  eventHash: z.string(),
  occurredAt: IsoDateTimeSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditQuerySchema = PaginationQuerySchema.extend({
  actorId: UuidSchema.optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** Canonical audit action names used across modules. */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_REFRESH: 'auth.refresh',
  AUTH_MFA_ENROL_STARTED: 'auth.mfa.enrol_started',
  AUTH_MFA_ENROLLED: 'auth.mfa.enrolled',
  AUTH_MFA_LOCKED: 'auth.mfa.locked',
  AUTH_INVITATION_ACCEPTED: 'auth.invitation.accepted',
  AUTH_MFA_VERIFIED: 'auth.mfa.verified',
  AUTH_MFA_FAILED: 'auth.mfa.failed',
  AUTH_REAUTH: 'auth.reauth',
  USER_CREATED: 'user.created',
  USER_INVITATION_ISSUED: 'user.invitation_issued',
  USER_UPDATED: 'user.updated',
  USER_STATUS_CHANGED: 'user.status_changed',
  USER_MFA_RESET: 'user.mfa_reset',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_ASSIGNED: 'role.assigned',
  ROLE_REVOKED: 'role.revoked',
  AUDIT_EXPORTED: 'audit.exported',
  REFERENCE_CREATED: 'reference.created',
  REFERENCE_UPDATED: 'reference.updated',
  REFERENCE_IMPORTED: 'reference.imported',
  REGISTRY_APPROVED: 'reference.registry.approved',
  FORM_TEMPLATE_CREATED: 'form_template.created',
  FORM_TEMPLATE_UPDATED: 'form_template.updated',
  FORM_TEMPLATE_STATE_CHANGED: 'form_template.state_changed',
  FILE_STORED: 'file.stored',
  FILE_SOURCE_ACCESSED: 'file.source_accessed',
  SUBMISSION_CREATED: 'tally.submission.created',
  SUBMISSION_STATUS_CHANGED: 'tally.submission.status_changed',
  SUBMISSION_CANONICAL_DESIGNATED: 'tally.submission.canonical_designated',
  RESULT_VALUE_CHANGED: 'tally.result_value.changed',
  OCR_RECORDED: 'tally.ocr.recorded',
  VALIDATION_RUN: 'tally.validation.run',
  VERIFICATION_RECORDED: 'tally.verification.recorded',
  SUPERVISOR_ACTION: 'tally.verification.supervisor_action',
  DISCREPANCY_OPENED: 'tally.discrepancy.opened',
  DISCREPANCY_UPDATED: 'tally.discrepancy.updated',
  DISCREPANCY_RESOLVED: 'tally.discrepancy.resolved',
  DISCREPANCY_CLOSED: 'tally.discrepancy.closed',
  SNAPSHOT_CREATED: 'tally.snapshot.created',
  SNAPSHOT_RELEASED: 'tally.snapshot.released',
  EXPORT_CREATED: 'tally.export.created',

  // Tenant module activation
  MODULE_UPDATED: 'workspace.module.updated',

  // NGAO360 Office: correspondence
  CORRESPONDENCE_CREATED: 'office.correspondence.created',
  CORRESPONDENCE_UPDATED: 'office.correspondence.updated',
  CORRESPONDENCE_ASSIGNED: 'office.correspondence.assigned',
  CORRESPONDENCE_STATUS_CHANGED: 'office.correspondence.status_changed',
  CORRESPONDENCE_ATTACHMENT_ADDED: 'office.correspondence.attachment_added',
  // Appointments and meetings
  APPOINTMENT_CREATED: 'office.appointment.created',
  APPOINTMENT_UPDATED: 'office.appointment.updated',
  APPOINTMENT_STATUS_CHANGED: 'office.appointment.status_changed',
  MEETING_CREATED: 'office.meeting.created',
  MEETING_UPDATED: 'office.meeting.updated',
  MEETING_ACTION_ITEM_SAVED: 'office.meeting.action_item_saved',
  MEETING_DECISION_RECORDED: 'office.meeting.decision_recorded',
  // Citizen cases
  CASE_CREATED: 'office.case.created',
  CASE_PUBLIC_SUBMITTED: 'office.case.public_submitted',
  CASE_UPDATED: 'office.case.updated',
  CASE_ASSIGNED: 'office.case.assigned',
  CASE_STATUS_CHANGED: 'office.case.status_changed',
  CASE_EVENT_ADDED: 'office.case.event_added',
  CASE_EVIDENCE_ADDED: 'office.case.evidence_added',
  CASE_CONTACT_VIEWED: 'office.case.contact_viewed',
  CASE_CONTACT_UPDATED: 'office.case.contact_updated',
  CASE_CONTACT_ERASED: 'office.case.contact_erased',
  CASE_REDACTED: 'office.case.redacted',
  CASE_REFERRED: 'office.case.referred',
  CASE_REFERRAL_UPDATED: 'office.case.referral_updated',
  CASE_CITIZEN_FEEDBACK: 'office.case.citizen_feedback',
  CASE_CLOSED: 'office.case.closed',
  CASE_REOPENED: 'office.case.reopened',
  // Institutions
  INSTITUTION_CREATED: 'office.institution.created',
  INSTITUTION_UPDATED: 'office.institution.updated',
  // Projects
  PROJECT_CREATED: 'office.project.created',
  PROJECT_UPDATED: 'office.project.updated',
  PROJECT_STATUS_CHANGED: 'office.project.status_changed',
  PROJECT_MILESTONE_SAVED: 'office.project.milestone_saved',
  PROJECT_EVIDENCE_ADDED: 'office.project.evidence_added',
  PROJECT_VERIFICATION_RECORDED: 'office.project.verification_recorded',
  PROJECT_COMPLETION_VERIFIED: 'office.project.completion_verified',
  PROJECT_PUBLICATION_CHANGED: 'office.project.publication_changed',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
