/**
 * Permission catalogue. Keys use the form `<module>.<action>` or
 * `<module>.<resource>.<action>` (blueprint 3.1: view, create, edit, submit,
 * approve, export, configure). The API enforces these server-side with
 * `@RequirePermission(...)`; the web client uses them only to shape navigation.
 */
import { z } from 'zod';

export interface PermissionDefinition {
  key: string;
  module: PermissionModule;
  action: string;
  description: string;
  /** High-risk permissions require MFA and re-authentication for sensitive actions. */
  highRisk?: boolean;
}

export const PERMISSION_MODULES = [
  'dashboard',
  'workspace',
  'users',
  'roles',
  'audit',
  'reference',
  'forms',
  'tally',
  'incidents',
  'office',
  'notifications',
  'platform',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSIONS = {
  // Overview
  DASHBOARD_VIEW: 'dashboard.view',
  NOTIFICATIONS_VIEW: 'notifications.view',

  // Workspace
  WORKSPACE_VIEW: 'workspace.view',
  WORKSPACE_CONFIGURE: 'workspace.configure',

  // Administration: users, roles, audit
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_EDIT: 'users.edit',
  USERS_SUSPEND: 'users.suspend',
  USERS_RESET_MFA: 'users.reset_mfa',
  ROLES_VIEW: 'roles.view',
  ROLES_CONFIGURE: 'roles.configure',
  ROLES_ASSIGN: 'roles.assign',
  AUDIT_VIEW: 'audit.view',
  AUDIT_EXPORT: 'audit.export',

  // Reference data (election cycles, geography, stations, tally centres, contests, candidates)
  REFERENCE_VIEW: 'reference.view',
  REFERENCE_EDIT: 'reference.edit',
  REFERENCE_IMPORT: 'reference.import',
  REFERENCE_APPROVE: 'reference.approve',

  // Form-template registry
  FORMS_VIEW: 'forms.view',
  FORMS_CONFIGURE: 'forms.configure',
  FORMS_APPROVE: 'forms.approve',

  // NGAO TALLY
  TALLY_VIEW: 'tally.view',
  TALLY_SUBMIT: 'tally.submit',
  TALLY_CAPTURE: 'tally.capture',
  TALLY_VERIFY: 'tally.verify',
  TALLY_APPROVE: 'tally.approve',
  TALLY_RESULTS_VIEW: 'tally.results.view',
  TALLY_SNAPSHOT_CREATE: 'tally.snapshot.create',
  TALLY_RELEASE: 'tally.release',
  TALLY_EXPORT: 'tally.export',
  TALLY_SOURCE_DOWNLOAD: 'tally.source.download',
  TALLY_DISCREPANCY_VIEW: 'tally.discrepancy.view',
  TALLY_DISCREPANCY_MANAGE: 'tally.discrepancy.manage',
  TALLY_DISCREPANCY_RESOLVE: 'tally.discrepancy.resolve',
  TALLY_EXCLUDE: 'tally.exclude',

  // Incidents (minimal in the foundation)
  INCIDENTS_VIEW: 'incidents.view',
  INCIDENTS_CREATE: 'incidents.create',
  INCIDENTS_MANAGE: 'incidents.manage',

  // NGAO360 Office (blueprint 9). Separate from campaign and tally data (blueprint 15.2).
  OFFICE_CORRESPONDENCE_VIEW: 'office.correspondence.view',
  OFFICE_CORRESPONDENCE_CREATE: 'office.correspondence.create',
  OFFICE_CORRESPONDENCE_EDIT: 'office.correspondence.edit',
  OFFICE_CORRESPONDENCE_CONFIDENTIAL: 'office.correspondence.confidential',
  OFFICE_APPOINTMENTS_VIEW: 'office.appointments.view',
  OFFICE_APPOINTMENTS_MANAGE: 'office.appointments.manage',
  OFFICE_MEETINGS_VIEW: 'office.meetings.view',
  OFFICE_MEETINGS_MANAGE: 'office.meetings.manage',
  OFFICE_CASES_VIEW: 'office.cases.view',
  OFFICE_CASES_CREATE: 'office.cases.create',
  OFFICE_CASES_MANAGE: 'office.cases.manage',
  OFFICE_CASES_INTERNAL_NOTES: 'office.cases.internal_notes',
  OFFICE_CASES_CONTACT_VIEW: 'office.cases.contact.view',
  OFFICE_CASES_REFERRAL: 'office.cases.referral',
  OFFICE_CASES_CLOSE: 'office.cases.close',
  OFFICE_PROJECTS_VIEW: 'office.projects.view',
  OFFICE_PROJECTS_EDIT: 'office.projects.edit',
  OFFICE_PROJECTS_EVIDENCE: 'office.projects.evidence',
  OFFICE_PROJECTS_VERIFY: 'office.projects.verify',
  OFFICE_PROJECTS_PUBLISH: 'office.projects.publish',
  OFFICE_INSTITUTIONS_MANAGE: 'office.institutions.manage',

  // Platform operator
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  PLATFORM_HEALTH_VIEW: 'platform.health.view',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSION_KEYS = Object.values(PERMISSIONS) as [PermissionKey, ...PermissionKey[]];
export const PermissionKeySchema = z.enum(ALL_PERMISSION_KEYS);

const d = (
  key: PermissionKey,
  description: string,
  highRisk = false,
): PermissionDefinition => {
  const [module, ...rest] = key.split('.');
  return {
    key,
    module: module as PermissionModule,
    action: rest.join('.'),
    description,
    ...(highRisk ? { highRisk } : {}),
  };
};

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  d(PERMISSIONS.DASHBOARD_VIEW, 'View the executive dashboard'),
  d(PERMISSIONS.NOTIFICATIONS_VIEW, 'View own notifications'),
  d(PERMISSIONS.WORKSPACE_VIEW, 'View workspace settings'),
  d(PERMISSIONS.WORKSPACE_CONFIGURE, 'Configure workspace, modules and retention', true),
  d(PERMISSIONS.USERS_VIEW, 'View the user directory'),
  d(PERMISSIONS.USERS_CREATE, 'Invite users', true),
  d(PERMISSIONS.USERS_EDIT, 'Edit user profiles'),
  d(PERMISSIONS.USERS_SUSPEND, 'Suspend or reactivate users', true),
  d(PERMISSIONS.USERS_RESET_MFA, 'Reset a user MFA factor', true),
  d(PERMISSIONS.ROLES_VIEW, 'View roles and permission matrix'),
  d(PERMISSIONS.ROLES_CONFIGURE, 'Create and edit roles', true),
  d(PERMISSIONS.ROLES_ASSIGN, 'Grant or revoke role assignments', true),
  d(PERMISSIONS.AUDIT_VIEW, 'Inspect audit events'),
  d(PERMISSIONS.AUDIT_EXPORT, 'Export audit events', true),
  d(PERMISSIONS.REFERENCE_VIEW, 'View election cycles, geography, stations, contests and candidates'),
  d(PERMISSIONS.REFERENCE_EDIT, 'Edit reference data'),
  d(PERMISSIONS.REFERENCE_IMPORT, 'Import reference datasets'),
  d(PERMISSIONS.REFERENCE_APPROVE, 'Approve a station registry version', true),
  d(PERMISSIONS.FORMS_VIEW, 'View form templates'),
  d(PERMISSIONS.FORMS_CONFIGURE, 'Create and edit form templates'),
  d(PERMISSIONS.FORMS_APPROVE, 'Approve form templates for an election cycle', true),
  d(PERMISSIONS.TALLY_VIEW, 'Access the NGAO TALLY module'),
  d(PERMISSIONS.TALLY_SUBMIT, 'Upload result forms and submit metadata'),
  d(PERMISSIONS.TALLY_CAPTURE, 'Capture and correct draft result values'),
  d(PERMISSIONS.TALLY_VERIFY, 'Independently verify a submission (never own submission)', true),
  d(PERMISSIONS.TALLY_APPROVE, 'Approve or reject verification outcomes as tally supervisor', true),
  d(PERMISSIONS.TALLY_RESULTS_VIEW, 'View the internal parallel tally aggregate'),
  d(PERMISSIONS.TALLY_SNAPSHOT_CREATE, 'Create an immutable tally snapshot'),
  d(PERMISSIONS.TALLY_RELEASE, 'Release an internal parallel aggregate snapshot', true),
  d(PERMISSIONS.TALLY_EXPORT, 'Export parallel tally data with disclaimer', true),
  d(PERMISSIONS.TALLY_SOURCE_DOWNLOAD, 'Download original source form files'),
  d(PERMISSIONS.TALLY_DISCREPANCY_VIEW, 'View discrepancy cases'),
  d(PERMISSIONS.TALLY_DISCREPANCY_MANAGE, 'Open, assign and comment on discrepancy cases'),
  d(PERMISSIONS.TALLY_DISCREPANCY_RESOLVE, 'Resolve and close discrepancy cases', true),
  d(PERMISSIONS.TALLY_EXCLUDE, 'Exclude a submission from the aggregate with reason', true),
  d(PERMISSIONS.INCIDENTS_VIEW, 'View incidents'),
  d(PERMISSIONS.INCIDENTS_CREATE, 'Report an incident'),
  d(PERMISSIONS.INCIDENTS_MANAGE, 'Acknowledge, assign and close incidents'),
  d(PERMISSIONS.OFFICE_CORRESPONDENCE_VIEW, 'View the correspondence register (internal and public items)'),
  d(PERMISSIONS.OFFICE_CORRESPONDENCE_CREATE, 'Register incoming and draft outgoing correspondence'),
  d(PERMISSIONS.OFFICE_CORRESPONDENCE_EDIT, 'Edit, assign, attach files to and move correspondence through its workflow'),
  d(PERMISSIONS.OFFICE_CORRESPONDENCE_CONFIDENTIAL, 'View and handle confidential and highly restricted correspondence'),
  d(PERMISSIONS.OFFICE_APPOINTMENTS_VIEW, 'View appointment requests and the office diary'),
  d(PERMISSIONS.OFFICE_APPOINTMENTS_MANAGE, 'Record, confirm, reschedule and close appointments'),
  d(PERMISSIONS.OFFICE_MEETINGS_VIEW, 'View meetings, minutes, action items and decisions'),
  d(PERMISSIONS.OFFICE_MEETINGS_MANAGE, 'Schedule meetings and record minutes, actions and decisions'),
  d(PERMISSIONS.OFFICE_CASES_VIEW, 'View citizen cases and their public timeline'),
  d(PERMISSIONS.OFFICE_CASES_CREATE, 'Record a citizen case on behalf of a requester'),
  d(PERMISSIONS.OFFICE_CASES_MANAGE, 'Triage, assign, update and propose resolutions for citizen cases'),
  d(PERMISSIONS.OFFICE_CASES_INTERNAL_NOTES, 'Read and write internal case notes'),
  d(PERMISSIONS.OFFICE_CASES_CONTACT_VIEW, 'View requester contact details (personal data)'),
  d(PERMISSIONS.OFFICE_CASES_REFERRAL, 'Refer cases to responsible institutions and record follow-up'),
  d(PERMISSIONS.OFFICE_CASES_CLOSE, 'Close and reopen citizen cases (a different person from the resolver when required)'),
  d(PERMISSIONS.OFFICE_PROJECTS_VIEW, 'View the development project register'),
  d(PERMISSIONS.OFFICE_PROJECTS_EDIT, 'Create and update projects and milestones'),
  d(PERMISSIONS.OFFICE_PROJECTS_EVIDENCE, 'Upload project evidence (photographs, reports, documents)'),
  d(PERMISSIONS.OFFICE_PROJECTS_VERIFY, 'Verify project evidence, expenditure and completion (never own uploads)', true),
  d(PERMISSIONS.OFFICE_PROJECTS_PUBLISH, 'Publish approved project fields on the public portal', true),
  d(PERMISSIONS.OFFICE_INSTITUTIONS_MANAGE, 'Maintain the institution registry (responsible bodies)'),
  d(PERMISSIONS.PLATFORM_TENANTS_MANAGE, 'Provision and suspend tenants', true),
  d(PERMISSIONS.PLATFORM_HEALTH_VIEW, 'View platform service health'),
];

/** True when the permission set grants any access to a module (used for navigation). */
export function hasModuleAccess(permissions: Iterable<string>, module: PermissionModule): boolean {
  for (const p of permissions) {
    if (p === `${module}.view` || p.startsWith(`${module}.`)) return true;
  }
  return false;
}

/** Permissions that, when held, make the user "privileged" and MFA mandatory. */
export const MFA_REQUIRING_PERMISSIONS: ReadonlySet<string> = new Set(
  PERMISSION_DEFINITIONS.filter((p) => p.highRisk).map((p) => p.key),
);
