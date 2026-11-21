/**
 * Workspace setup (S02), onboarding checklist (S03), system settings (S30) and non-secret
 * integration settings. Owner: workspace-admin. API contract §33.
 *
 * Secrets (SMTP password, SMS API key, VAPID private key, captcha secret) are never stored in the
 * database or returned by the API: they come from the environment. A tenant row only selects the
 * provider and holds public values (sender id, from address, captcha site key). The DB check
 * `tenant_integration_settings_no_secrets_check` refuses secret-looking keys; `containsSecretKey`
 * mirrors it for early validation.
 */
import { z } from 'zod';
import { type TenantType, TenantTypeSchema } from '../enums';
import { type TenantModuleKey, TenantModuleKeySchema } from '../modules';
import { IsoDateTimeSchema, UserRefSchema, UuidSchema } from '../schemas/common';
import { WorkspaceSetupItemStatusSchema } from './enums';

// --- Onboarding checklist (S03) ---------------------------------------------------------------

export interface WorkspaceSetupItemDefinition {
  key: string;
  label: string;
  description: string;
  /** Where the admin does the work. */
  href: string;
  /** Detected automatically from existing data (the admin can still mark it done or skip it). */
  autoDetect: boolean;
}

export const WORKSPACE_SETUP_ITEMS: readonly WorkspaceSetupItemDefinition[] = [
  { key: 'workspace.profile', label: 'Organisation profile', description: 'Name, display name, timezone, logo and data region.', href: '/setup', autoDetect: false },
  { key: 'modules.choose', label: 'Choose modules', description: 'Switch on the modules this organisation uses.', href: '/settings#modules', autoDetect: false },
  { key: 'reference.import', label: 'Import reference data', description: 'Geography and the polling-station registry for the election cycle.', href: '/reference', autoDetect: true },
  { key: 'org.teams', label: 'Add teams', description: 'Departments and teams (campaign module).', href: '/org', autoDetect: true },
  { key: 'users.invite', label: 'Invite users', description: 'Invitations are delivered to the invitee once a delivery channel is configured.', href: '/admin/users', autoDetect: true },
  { key: 'roles.configure', label: 'Configure roles', description: 'Review system roles and grant them with the right geography.', href: '/admin/roles', autoDetect: true },
  // Added by workspace-admin: S03 tracks real completion from data (contract §33.2).
  { key: 'registry.approved', label: 'Approve the station registry', description: 'A second person approves the imported polling-station registry version.', href: '/reference/stations', autoDetect: true },
  { key: 'forms.approved', label: 'Approve form templates', description: 'Result-form templates are approved by someone other than their author.', href: '/reference/forms', autoDetect: true },
  { key: 'security.mfa_enrolled', label: 'MFA for privileged users', description: 'Every active user whose role requires MFA has an authenticator app or a passkey.', href: '/admin/users', autoDetect: true },
  { key: 'privacy.notice_reviewed', label: 'Review the privacy notice', description: 'Data-protection contact and notice versions recorded and reviewed.', href: '/setup#data-protection', autoDetect: true },
  { key: 'retention.set', label: 'Set data retention', description: 'Retention profile and Office retention periods reviewed and saved.', href: '/settings#retention', autoDetect: true },
  { key: 'backup.verified', label: 'Verify a backup restore', description: 'A restore of the latest backup was tested in the last 90 days and recorded.', href: '/settings#backup', autoDetect: true },
  { key: 'integrations.review', label: 'Review integrations', description: 'E-mail, SMS, push, captcha and malware scanning status.', href: '/settings#integrations', autoDetect: false },
  { key: 'security.review', label: 'Review security', description: 'MFA for privileged roles, passkeys and recovery codes for administrators.', href: '/settings#security', autoDetect: false },
] as const;
export const WORKSPACE_SETUP_ITEM_KEYS = WORKSPACE_SETUP_ITEMS.map((i) => i.key);

export const WorkspaceSetupItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  href: z.string(),
  status: WorkspaceSetupItemStatusSchema,
  /** True when existing data shows the step is done although nobody marked it. */
  detected: z.boolean(),
  note: z.string().nullable(),
  completedBy: UserRefSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  /** Completion is read from data; DONE can only be recorded while `detected` (added by workspace-admin). */
  autoDetect: z.boolean().optional(),
  /** Effective completion: auto items detected (or SKIPPED with a note); manual items DONE / SKIPPED. */
  complete: z.boolean().optional(),
  /** What the data shows, e.g. "3 of 4 privileged users have MFA". Counts only, no personal data. */
  evidence: z.string().nullable().optional(),
});
export type WorkspaceSetupItem =z.infer<typeof WorkspaceSetupItemSchema>;

export const OnboardingResponseSchema = z.object({
  items: z.array(WorkspaceSetupItemSchema),
  completed: z.number().int(),
  total: z.number().int(),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;

export const UpdateSetupItemSchema = z.object({
  status: WorkspaceSetupItemStatusSchema,
  note: z.string().trim().max(1000).optional(),
});
export type UpdateSetupItem = z.infer<typeof UpdateSetupItemSchema>;

// --- Workspace profile and setup wizard (S02) -------------------------------------------------

export const DATA_REGIONS = ['ke', 'eu', 'other'] as const;
export const DataRegionSchema = z.enum(DATA_REGIONS);

export const WorkspaceProfileSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  type: TenantTypeSchema,
  timezone: z.string(),
  locale: z.string(),
  dataRegion: z.string(),
  logoFileId: UuidSchema.nullable(),
  historicalDemo: z.boolean(),
  createdAt: IsoDateTimeSchema,
  // Added by workspace-admin (S02):
  environment: z.lazy(() => WorkspaceEnvironmentSchema).nullable().optional(),
  defaultCountyCode: z.string().nullable().optional(),
  dataProtection: z.lazy(() => DataProtectionSettingsSchema).nullable().optional(),
  /** Scan state of the logo file (only CLEAN files can be set as the logo). */
  logoScanStatus: z.string().nullable().optional(),
});
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

export const UpdateWorkspaceProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  dataRegion: DataRegionSchema.optional(),
  logoFileId: UuidSchema.nullable().optional(),
  // Added by workspace-admin (S02):
  defaultCountyCode: z.string().trim().regex(/^\d{3}$/).nullable().optional(),
  /** Records the data-protection contact and notice versions; marks them reviewed by the caller. */
  dataProtection: z.lazy(() => DataProtectionInputSchema).optional(),
  reason: z.string().trim().max(1000).optional(),
});
export type UpdateWorkspaceProfile = z.infer<typeof UpdateWorkspaceProfileSchema>;

/**
 * S02: a platform operator creates an organisation and its first administrator. The administrator
 * receives an invitation through the outbox (never shown to the operator in production once a
 * delivery channel is configured). Historical-demo organisations are created only by the demo CLI.
 */
export const CreateWorkspaceSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120).optional(),
  type: TenantTypeSchema.refine((t) => t !== 'PLATFORM', 'Choose an organisation type'),
  timezone: z.string().trim().min(3).max(64).default('Africa/Nairobi'),
  dataRegion: DataRegionSchema.default('ke'),
  modules: z.array(TenantModuleKeySchema).default([]),
  defaultCountyCode: z.string().trim().regex(/^\d{3}$/).optional(),
  admin: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: z.string().trim().min(2).max(120),
  }),
  // Added by workspace-admin (S02):
  /** Campaign / Election / Office preset; must match `type` (WORKSPACE_ENVIRONMENTS). */
  environment: z.lazy(() => WorkspaceEnvironmentSchema).optional(),
  /** Further first administrators (organisation owner role), each invited separately. */
  additionalAdmins: z
    .array(z.object({ email: z.string().trim().toLowerCase().email().max(254), displayName: z.string().trim().min(2).max(120) }))
    .max(4)
    .optional(),
  dataProtection: z.lazy(() => DataProtectionInputSchema).optional(),
  reason: z.string().trim().max(1000).optional(),
});
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;

// --- Integration settings (S30) ---------------------------------------------------------------

export const INTEGRATION_KINDS = ['email', 'sms', 'push', 'captcha', 'scanner'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const IntegrationKindSchema = z.enum(INTEGRATION_KINDS);

/** Providers per kind. The first is the default: nothing is sent / checked / scanned by a vendor. */
export const INTEGRATION_PROVIDERS = {
  email: ['log', 'smtp'],
  sms: ['log', 'africastalking'],
  push: ['log', 'webpush'],
  captcha: ['none', 'hcaptcha', 'turnstile'],
  scanner: ['none', 'clamd'],
} as const satisfies Record<IntegrationKind, readonly [string, ...string[]]>;

const SECRET_KEY_RE = /(secret|password|passwd|api[_-]?key|token|private[_-]?key|credential|auth[_-]?key)/i;

/** True if any object key at any depth looks like a secret (mirrors the DB check). */
export function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => SECRET_KEY_RE.test(k) || containsSecretKey(v));
  }
  return false;
}

/** Non-secret config per kind. Unknown keys are refused (strict). */
export const IntegrationConfigSchemas = {
  email: z.object({ fromAddress: z.string().email().max(254).optional(), fromName: z.string().max(120).optional() }).strict(),
  sms: z.object({ senderId: z.string().regex(/^[A-Za-z0-9 ]{3,11}$/, 'Sender ID: 3–11 letters or digits').optional() }).strict(),
  push: z.object({}).strict(),
  captcha: z.object({ siteKey: z.string().max(200).optional() }).strict(),
  scanner: z.object({}).strict(),
} as const satisfies Record<IntegrationKind, z.ZodTypeAny>;

export const UpdateIntegrationSettingSchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
    enabled: z.boolean(),
    config: z.record(z.unknown()).default({}),
  })
  .refine((v) => !containsSecretKey(v.config), { message: 'Secrets are configured in the server environment, not here', path: ['config'] });
export type UpdateIntegrationSetting = z.infer<typeof UpdateIntegrationSettingSchema>;

export const IntegrationStatusSchema = z.object({
  kind: IntegrationKindSchema,
  provider: z.string(),
  enabled: z.boolean(),
  config: z.record(z.unknown()),
  /** The server environment has what this provider needs (never which values). */
  configured: z.boolean(),
  /** Enabled, configured and last health check passed. A configured but failing captcha refuses submissions. */
  available: z.boolean(),
  /** Environment variable NAMES the provider needs that are missing (never values). */
  missingEnv: z.array(z.string()),
  updatedBy: UserRefSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const IntegrationsResponseSchema = z.object({ integrations: z.array(IntegrationStatusSchema) });
export type IntegrationsResponse = z.infer<typeof IntegrationsResponseSchema>;

/** S30 security summary (read-only; changes happen on the owning screens). */
export const SecuritySettingsResponseSchema = z.object({
  mfaRequiredRoleKeys: z.array(z.string()),
  usersWithoutMfa: z.number().int(),
  passkeysRegistered: z.number().int(),
  administratorsWithoutRecoveryCodes: z.number().int(),
  pendingAccountRecoveries: z.number().int(),
  invitationDelivery: z.enum(['OUTBOX', 'SHOWN_ONCE']),
  rateLimitStore: z.enum(['memory', 'redis']),
});
export type SecuritySettingsResponse = z.infer<typeof SecuritySettingsResponseSchema>;

// =============================================================================================
// Added by workspace-admin: S02 environments and data protection, S30 security policy,
// retention, backup verification and integration activity (API contract §33).
// =============================================================================================

/** S02 environment presets. The tenant type must be one the preset allows. */
export const WORKSPACE_ENVIRONMENTS = ['CAMPAIGN', 'ELECTION', 'OFFICE'] as const;
export type WorkspaceEnvironment = (typeof WORKSPACE_ENVIRONMENTS)[number];
export const WorkspaceEnvironmentSchema = z.enum(WORKSPACE_ENVIRONMENTS);

export interface WorkspaceEnvironmentDefinition {
  key: WorkspaceEnvironment;
  label: string;
  description: string;
  tenantTypes: readonly TenantType[];
  /** Modules switched on when the wizard does not name any. */
  defaultModules: readonly TenantModuleKey[];
}

export const WORKSPACE_ENVIRONMENT_DEFINITIONS: readonly WorkspaceEnvironmentDefinition[] = [
  {
    key: 'CAMPAIGN',
    label: 'Campaign',
    description: 'A candidate or party campaign: organisation, tasks, events, communications workflow and finance, with field operations and the internal parallel tally.',
    tenantTypes: ['CAMPAIGN', 'POLITICAL_PARTY'],
    defaultModules: ['campaign', 'field', 'tally'],
  },
  {
    key: 'ELECTION',
    label: 'Election operations',
    description: 'Election-day agents, readiness, incidents, the War Room and the internal parallel tally (never official results).',
    tenantTypes: ['POLITICAL_PARTY', 'OBSERVER_ORGANISATION', 'CAMPAIGN'],
    defaultModules: ['field', 'tally'],
  },
  {
    key: 'OFFICE',
    label: 'Office',
    description: 'An elected office: correspondence, appointments, citizen cases, projects and the public portal.',
    tenantTypes: ['ELECTED_OFFICE'],
    defaultModules: ['office'],
  },
];

export function environmentDefinition(key: WorkspaceEnvironment): WorkspaceEnvironmentDefinition {
  const def = WORKSPACE_ENVIRONMENT_DEFINITIONS.find((e) => e.key === key);
  if (!def) throw new Error(`Unknown workspace environment ${key}`);
  return def;
}

/** Notice version labels chosen by the organisation, e.g. "2026-11-v1". */
export const NoticeVersionSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'Use letters, digits, dots, dashes or underscores (max 40)');

/** S02 data-protection contact and notice versions (blueprint 15.2). Stored in `tenants.settings.dataProtection`. */
export const DataProtectionInputSchema = z.object({
  /** Data controller named in notices, e.g. "Office of the Governor, Bungoma County". */
  controllerName: z.string().trim().min(2).max(200),
  /** Role or office, not necessarily a named person (e.g. "Data Protection Officer"). */
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().toLowerCase().email().max(254),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  /** Version of the privacy notice for people whose data the organisation holds. */
  privacyNoticeVersion: NoticeVersionSchema,
  /** Version of the staff / volunteer notice, when separate. */
  staffNoticeVersion: NoticeVersionSchema.nullable().optional(),
});
export type DataProtectionInput = z.infer<typeof DataProtectionInputSchema>;

export const DataProtectionSettingsSchema = DataProtectionInputSchema.extend({
  contactPhone: z.string().nullable(),
  staffNoticeVersion: z.string().nullable(),
  reviewedBy: UserRefSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
});
export type DataProtectionSettings = z.infer<typeof DataProtectionSettingsSchema>;

/** First administrator invitation in a POST /platform/workspaces response (contract §32.4 rule). */
export const WorkspaceAdminInvitationSchema = z.object({
  userId: UuidSchema,
  email: z.string(),
  expiresAt: IsoDateTimeSchema,
  delivery: z.enum(['OUTBOX', 'SHOWN_ONCE']),
  /** OUTBOX only. */
  messageId: UuidSchema.nullable(),
  /** SHOWN_ONCE only (no delivery channel configured): the one-time link path. Never with OUTBOX. */
  acceptPath: z.string().nullable(),
});
export type WorkspaceAdminInvitation = z.infer<typeof WorkspaceAdminInvitationSchema>;

export const CreateWorkspaceResponseSchema = z.object({
  workspace: WorkspaceProfileSchema,
  adminInvitation: WorkspaceAdminInvitationSchema,
  additionalInvitations: z.array(WorkspaceAdminInvitationSchema),
});
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;

/** Organisations visible to a platform operator (GET /platform/workspaces). */
export const PlatformWorkspaceSummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  type: TenantTypeSchema,
  status: z.string(),
  historicalDemo: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type PlatformWorkspaceSummary = z.infer<typeof PlatformWorkspaceSummarySchema>;

// --- Security policy (S30) --------------------------------------------------------------------

/**
 * PRIVILEGED_ROLES: MFA for roles that require it and MFA-requiring permissions (the default and
 * the minimum). ALL_USERS: every user signs in with a second factor. A tenant can only tighten
 * the server limits, never loosen them.
 */
export const MFA_POLICIES = ['PRIVILEGED_ROLES', 'ALL_USERS'] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];
export const MfaPolicySchema = z.enum(MFA_POLICIES);

export const WorkspaceSecurityPolicySchema = z.object({
  mfaPolicy: MfaPolicySchema.default('PRIVILEGED_ROLES'),
  /** Longest a sign-in lasts before the person signs in again; null = the server limit. */
  sessionMaxHours: z.number().int().min(1).max(720).nullable().default(null),
  /** Sign-out after this much inactivity; null = only the session limit applies. */
  idleTimeoutMinutes: z.number().int().min(5).max(1440).nullable().default(null),
});
export type WorkspaceSecurityPolicy = z.infer<typeof WorkspaceSecurityPolicySchema>;

export const UpdateWorkspaceSecuritySchema = z.object({
  mfaPolicy: MfaPolicySchema,
  sessionMaxHours: z.number().int().min(1).max(720).nullable(),
  idleTimeoutMinutes: z.number().int().min(5).max(1440).nullable(),
  reason: z.string().trim().min(3).max(1000),
});
export type UpdateWorkspaceSecurity = z.infer<typeof UpdateWorkspaceSecuritySchema>;

export const WorkspaceSecurityDetailSchema = SecuritySettingsResponseSchema.extend({
  policy: WorkspaceSecurityPolicySchema,
  /** Server limits from the environment (the tenant policy can only be shorter). */
  serverSessionMaxHours: z.number(),
  accessTokenMinutes: z.number(),
  /** False until sign-in reads the tenant policy (docs/CHANGE_REQUESTS.md WA1). */
  policyEnforcedAtSignIn: z.boolean(),
  updatedBy: UserRefSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type WorkspaceSecurityDetail = z.infer<typeof WorkspaceSecurityDetailSchema>;

// --- Retention (S30) --------------------------------------------------------------------------

export const RETENTION_PROFILES = ['minimal', 'standard', 'extended'] as const;
export type RetentionProfile = (typeof RETENTION_PROFILES)[number];
export const RetentionProfileSchema = z.enum(RETENTION_PROFILES);

export const OfficeRetentionSchema = z.object({
  contactRetentionMonths: z.number().int().min(1).max(120),
  caseRetentionMonths: z.number().int().min(1).max(240),
});
export type OfficeRetention = z.infer<typeof OfficeRetentionSchema>;

export const UpdateRetentionSchema = z.object({
  retentionProfile: RetentionProfileSchema.optional(),
  office: OfficeRetentionSchema.optional(),
  /**
   * Required when the Office periods differ from those stated under the current privacy notice
   * version: the new notice version that states them (must differ from the current one).
   */
  newNoticeVersion: NoticeVersionSchema.optional(),
  reason: z.string().trim().min(3).max(1000),
});
export type UpdateRetention = z.infer<typeof UpdateRetentionSchema>;

export const RetentionResponseSchema = z.object({
  retentionProfile: z.string(),
  office: OfficeRetentionSchema.nullable(),
  /** Periods stated under the current privacy notice version (null until a notice is recorded). */
  statedUnderNotice: OfficeRetentionSchema.extend({ noticeVersion: z.string() }).nullable(),
  reviewedBy: UserRefSchema.nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  lastRun: z
    .object({ id: UuidSchema, status: z.string(), startedAt: IsoDateTimeSchema, finishedAt: IsoDateTimeSchema.nullable(), counts: z.record(z.number()) })
    .nullable(),
});
export type RetentionResponse = z.infer<typeof RetentionResponseSchema>;

// --- Backup verification (S03 / S30) ----------------------------------------------------------

export const BACKUP_VERIFICATION_MAX_AGE_DAYS = 90;

export const RecordBackupVerificationSchema = z.object({
  /** Day the restore was tested (YYYY-MM-DD, not in the future). */
  testedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Which backup was restored and where (no credentials). */
  backupReference: z.string().trim().min(3).max(200),
  outcome: z.enum(['RESTORED_OK', 'RESTORED_WITH_ISSUES', 'FAILED']),
  note: z.string().trim().min(3).max(2000),
});
export type RecordBackupVerification = z.infer<typeof RecordBackupVerificationSchema>;

export const BackupStatusSchema = z.object({
  last: RecordBackupVerificationSchema.extend({ recordedBy: UserRefSchema.nullable(), recordedAt: IsoDateTimeSchema }).nullable(),
  /** Last test passed (RESTORED_OK) within BACKUP_VERIFICATION_MAX_AGE_DAYS. */
  current: z.boolean(),
  maxAgeDays: z.number().int(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

// --- Integration activity (S30) ---------------------------------------------------------------

/** Last delivery / scan per integration kind, counts only (no addresses, no file names). */
export const IntegrationActivitySchema = z.object({
  kind: IntegrationKindSchema,
  lastAt: IsoDateTimeSchema.nullable(),
  lastStatus: z.string().nullable(),
  /** e.g. { SENT: 3, SKIPPED: 12 } over the last 7 days, or { CLEAN: 4, PENDING: 2 } for files. */
  last7Days: z.record(z.number()),
});
export type IntegrationActivity = z.infer<typeof IntegrationActivitySchema>;

export const IntegrationActivityResponseSchema = z.object({ activity: z.array(IntegrationActivitySchema) });
export type IntegrationActivityResponse = z.infer<typeof IntegrationActivityResponseSchema>;
