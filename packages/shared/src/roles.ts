/**
 * System role definitions mirroring blueprint section 3. Each tenant receives a
 * copy of these roles at provisioning (see packages/db seed). Tenants may add
 * custom roles; system roles are not editable in place.
 *
 * Separation of duties (blueprint 3.2) is enforced per record by the tally
 * module, not by role exclusivity: the same user must never be the submitter,
 * independent verifier and approver of the same results record.
 */
import { z } from 'zod';
import { PERMISSIONS as P, type PermissionKey } from './permissions';

export const SYSTEM_ROLE_KEYS = [
  'PLATFORM_OPERATOR',
  'ORGANISATION_OWNER',
  'CAMPAIGN_DIRECTOR',
  'OPERATIONS_DIRECTOR',
  'DEPARTMENT_LEAD',
  'COORDINATOR',
  'POLLING_AGENT',
  'DATA_ENTRY_CLERK',
  'RESULTS_VERIFIER',
  'TALLY_SUPERVISOR',
  'FINANCE_OFFICER',
  'LEGAL_COMPLIANCE_OFFICER',
  'COMMUNICATIONS_EDITOR',
  'OFFICE_ADMINISTRATOR',
  'CASE_OFFICER',
  'CORRESPONDENCE_CLERK',
  'PROJECTS_OFFICER',
  'PUBLIC_INFORMATION_EDITOR',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
export const SystemRoleKeySchema = z.enum(SYSTEM_ROLE_KEYS);

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** Restricted actions from blueprint section 3, shown in the role editor. */
  restrictions: string;
  permissions: readonly PermissionKey[];
  /** MFA is mandatory for privileged roles (blueprint 15.1). */
  mfaRequired: boolean;
}

const BASE: PermissionKey[] = [P.DASHBOARD_VIEW, P.NOTIFICATIONS_VIEW];

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'PLATFORM_OPERATOR',
    name: 'Platform operator',
    description: 'Tenant provisioning, service health, support diagnostics.',
    restrictions:
      'No routine access to customer content; time-limited, approved support elevation only.',
    permissions: [P.PLATFORM_TENANTS_MANAGE, P.PLATFORM_HEALTH_VIEW, P.NOTIFICATIONS_VIEW],
    mfaRequired: true,
  },
  {
    key: 'ORGANISATION_OWNER',
    name: 'Organisation owner',
    description: 'Workspace settings, invitations, module activation, retention settings.',
    restrictions: 'Cannot alter already verified tally values without workflow.',
    permissions: [
      ...BASE,
      P.WORKSPACE_VIEW,
      P.WORKSPACE_CONFIGURE,
      P.USERS_VIEW,
      P.USERS_CREATE,
      P.USERS_EDIT,
      P.USERS_SUSPEND,
      P.USERS_RESET_MFA,
      P.ROLES_VIEW,
      P.ROLES_CONFIGURE,
      P.ROLES_ASSIGN,
      P.AUDIT_VIEW,
      P.AUDIT_EXPORT,
      P.REFERENCE_VIEW,
      P.REFERENCE_EDIT,
      P.REFERENCE_IMPORT,
      P.REFERENCE_APPROVE,
      P.FORMS_VIEW,
      P.FORMS_CONFIGURE,
      P.FORMS_APPROVE,
      P.TALLY_VIEW,
      P.TALLY_RESULTS_VIEW,
      P.TALLY_DISCREPANCY_VIEW,
      P.INCIDENTS_VIEW,
      // Office oversight is read-only; requester contact details stay with case staff.
      P.OFFICE_CORRESPONDENCE_VIEW,
      P.OFFICE_APPOINTMENTS_VIEW,
      P.OFFICE_MEETINGS_VIEW,
      P.OFFICE_CASES_VIEW,
      P.OFFICE_PROJECTS_VIEW,
    ],
    mfaRequired: true,
  },
  {
    key: 'CAMPAIGN_DIRECTOR',
    name: 'Campaign director',
    description: 'Executive dashboards, workstreams, departmental status, approved reports.',
    restrictions: 'No direct editing of source result records unless separately assigned.',
    permissions: [
      ...BASE,
      P.WORKSPACE_VIEW,
      P.USERS_VIEW,
      P.REFERENCE_VIEW,
      P.FORMS_VIEW,
      P.TALLY_VIEW,
      P.TALLY_RESULTS_VIEW,
      P.TALLY_DISCREPANCY_VIEW,
      P.INCIDENTS_VIEW,
    ],
    mfaRequired: true,
  },
  {
    key: 'OPERATIONS_DIRECTOR',
    name: 'Operations director',
    description: 'Tasks, events, field reporting, readiness and deployment overview.',
    restrictions: 'No access to finance or sensitive case details unless granted.',
    permissions: [...BASE, P.REFERENCE_VIEW, P.INCIDENTS_VIEW, P.INCIDENTS_MANAGE, P.USERS_VIEW],
    mfaRequired: false,
  },
  {
    key: 'DEPARTMENT_LEAD',
    name: 'Department lead',
    description: 'Own department records, tasks, approvals and reports.',
    restrictions: 'Cannot see unrelated departments by default.',
    permissions: [...BASE, P.USERS_VIEW],
    mfaRequired: false,
  },
  {
    key: 'COORDINATOR',
    name: 'Coordinator',
    description: 'Assigned geographic area, team, tasks, activity reports.',
    restrictions: 'Cannot browse all areas or modify master station data.',
    permissions: [...BASE, P.REFERENCE_VIEW, P.INCIDENTS_VIEW, P.INCIDENTS_CREATE],
    mfaRequired: false,
  },
  {
    key: 'POLLING_AGENT',
    name: 'Polling agent',
    description: 'Own assignment, training, incident submission and authorised form uploads.',
    restrictions:
      "Cannot view other agents' personal details or approve own result submission.",
    permissions: [P.NOTIFICATIONS_VIEW, P.TALLY_VIEW, P.TALLY_SUBMIT, P.INCIDENTS_CREATE],
    mfaRequired: false,
  },
  {
    key: 'DATA_ENTRY_CLERK',
    name: 'Data-entry clerk',
    description: 'Form metadata and draft result capture.',
    restrictions: 'Cannot independently verify own entries.',
    permissions: [
      ...BASE,
      P.REFERENCE_VIEW,
      P.FORMS_VIEW,
      P.TALLY_VIEW,
      P.TALLY_SUBMIT,
      P.TALLY_CAPTURE,
      P.TALLY_SOURCE_DOWNLOAD,
      P.TALLY_DISCREPANCY_VIEW,
    ],
    mfaRequired: false,
  },
  {
    key: 'RESULTS_VERIFIER',
    name: 'Results verifier',
    description:
      'Review original image, extracted figures, validations and source comparison.',
    restrictions: 'Cannot modify the original source image or delete submission history.',
    permissions: [
      ...BASE,
      P.REFERENCE_VIEW,
      P.FORMS_VIEW,
      P.TALLY_VIEW,
      P.TALLY_VERIFY,
      P.TALLY_SOURCE_DOWNLOAD,
      P.TALLY_DISCREPANCY_VIEW,
      P.TALLY_DISCREPANCY_MANAGE,
    ],
    mfaRequired: true,
  },
  {
    key: 'TALLY_SUPERVISOR',
    name: 'Tally supervisor',
    description: 'Approve/reject verification outcomes, release internal parallel aggregates.',
    restrictions: 'Cannot declare an official result or issue IEBC certificates.',
    permissions: [
      ...BASE,
      P.REFERENCE_VIEW,
      P.FORMS_VIEW,
      P.TALLY_VIEW,
      P.TALLY_APPROVE,
      P.TALLY_RESULTS_VIEW,
      P.TALLY_SNAPSHOT_CREATE,
      P.TALLY_RELEASE,
      P.TALLY_EXPORT,
      P.TALLY_SOURCE_DOWNLOAD,
      P.TALLY_DISCREPANCY_VIEW,
      P.TALLY_DISCREPANCY_MANAGE,
      P.TALLY_DISCREPANCY_RESOLVE,
      P.TALLY_EXCLUDE,
      P.AUDIT_VIEW,
    ],
    mfaRequired: true,
  },
  {
    key: 'FINANCE_OFFICER',
    name: 'Finance officer',
    description: 'Budgets, transactions, supplier records, finance reports.',
    restrictions: 'Cannot approve own payment request where segregation is required.',
    permissions: [...BASE],
    mfaRequired: true,
  },
  {
    key: 'LEGAL_COMPLIANCE_OFFICER',
    name: 'Legal/compliance officer',
    description: 'Compliance records, incident evidence, document holds and escalations.',
    restrictions: 'Cannot alter source result figures without a separate tally role.',
    permissions: [
      ...BASE,
      P.REFERENCE_VIEW,
      P.FORMS_VIEW,
      P.FORMS_APPROVE,
      P.TALLY_VIEW,
      P.TALLY_RESULTS_VIEW,
      P.TALLY_SOURCE_DOWNLOAD,
      P.TALLY_DISCREPANCY_VIEW,
      P.AUDIT_VIEW,
      P.AUDIT_EXPORT,
      P.INCIDENTS_VIEW,
      P.INCIDENTS_MANAGE,
    ],
    mfaRequired: true,
  },
  {
    key: 'COMMUNICATIONS_EDITOR',
    name: 'Communications editor',
    description: 'Draft and publish approved public or internal content.',
    restrictions:
      'Cannot message users outside configured lawful lists or access voter profiles.',
    permissions: [...BASE],
    mfaRequired: false,
  },

  /* ------------------------- NGAO360 Office (blueprint 9) ------------------------- */
  // Office roles hold no campaign or tally permissions (blueprint 15.2: separate
  // permissions for citizen case submissions and campaign records).
  {
    key: 'OFFICE_ADMINISTRATOR',
    name: 'Office administrator',
    description:
      'Runs the office workspace: correspondence, diary, case triage and closure, institution registry and project verification.',
    restrictions:
      'Cannot verify evidence they uploaded or a completion they reported; cannot close a case they resolved when the office requires a second person.',
    permissions: [
      ...BASE,
      P.USERS_VIEW,
      P.OFFICE_CORRESPONDENCE_VIEW,
      P.OFFICE_CORRESPONDENCE_CREATE,
      P.OFFICE_CORRESPONDENCE_EDIT,
      P.OFFICE_CORRESPONDENCE_CONFIDENTIAL,
      P.OFFICE_APPOINTMENTS_VIEW,
      P.OFFICE_APPOINTMENTS_MANAGE,
      P.OFFICE_MEETINGS_VIEW,
      P.OFFICE_MEETINGS_MANAGE,
      P.OFFICE_CASES_VIEW,
      P.OFFICE_CASES_CREATE,
      P.OFFICE_CASES_MANAGE,
      P.OFFICE_CASES_INTERNAL_NOTES,
      P.OFFICE_CASES_CONTACT_VIEW,
      P.OFFICE_CASES_REFERRAL,
      P.OFFICE_CASES_CLOSE,
      P.OFFICE_CASES_CONFIDENTIAL,
      P.OFFICE_PROJECTS_VIEW,
      P.OFFICE_PROJECTS_VERIFY,
      P.OFFICE_INSTITUTIONS_MANAGE,
    ],
    mfaRequired: true,
  },
  {
    key: 'CASE_OFFICER',
    name: 'Case officer',
    description: 'Handles assigned citizen cases: actions, public updates, internal notes, referrals and proposed resolutions.',
    restrictions: 'Cannot close cases; cannot see correspondence, projects or any campaign data.',
    permissions: [
      ...BASE,
      P.OFFICE_CASES_VIEW,
      P.OFFICE_CASES_CREATE,
      P.OFFICE_CASES_MANAGE,
      P.OFFICE_CASES_INTERNAL_NOTES,
      P.OFFICE_CASES_CONTACT_VIEW,
      P.OFFICE_CASES_REFERRAL,
      P.OFFICE_APPOINTMENTS_VIEW,
    ],
    mfaRequired: false,
  },
  {
    key: 'CORRESPONDENCE_CLERK',
    name: 'Correspondence clerk',
    description: 'Registers incoming and outgoing letters, attaches scans, routes items and keeps the office diary.',
    restrictions: 'Cannot open confidential correspondence or citizen case details.',
    permissions: [
      ...BASE,
      P.OFFICE_CORRESPONDENCE_VIEW,
      P.OFFICE_CORRESPONDENCE_CREATE,
      P.OFFICE_CORRESPONDENCE_EDIT,
      P.OFFICE_APPOINTMENTS_VIEW,
      P.OFFICE_APPOINTMENTS_MANAGE,
      P.OFFICE_MEETINGS_VIEW,
      P.OFFICE_MEETINGS_MANAGE,
    ],
    mfaRequired: false,
  },
  {
    key: 'PROJECTS_OFFICER',
    name: 'Projects officer',
    description: 'Maintains project records, milestones, financial fields and evidence uploads.',
    restrictions: 'Cannot verify evidence or completion, and cannot publish to the public portal.',
    permissions: [...BASE, P.OFFICE_PROJECTS_VIEW, P.OFFICE_PROJECTS_EDIT, P.OFFICE_PROJECTS_EVIDENCE],
    mfaRequired: false,
  },
  {
    key: 'PUBLIC_INFORMATION_EDITOR',
    name: 'Public-information editor',
    description: 'Chooses which approved project fields appear on the public portal and writes the public summary.',
    restrictions:
      'Cannot edit project facts or verification status; the public view always names the responsible institution and source.',
    permissions: [...BASE, P.OFFICE_PROJECTS_VIEW, P.OFFICE_PROJECTS_PUBLISH],
    mfaRequired: true,
  },
];

/** System roles that belong to the NGAO360 Office environment. */
export const OFFICE_ROLE_KEYS: readonly SystemRoleKey[] = [
  'OFFICE_ADMINISTRATOR',
  'CASE_OFFICER',
  'CORRESPONDENCE_CLERK',
  'PROJECTS_OFFICER',
  'PUBLIC_INFORMATION_EDITOR',
];

export function getSystemRole(key: SystemRoleKey): SystemRoleDefinition {
  const role = SYSTEM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown system role ${key}`);
  return role;
}
