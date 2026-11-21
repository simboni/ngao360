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
import { TenantTypeSchema } from '../enums';
import { TenantModuleKeySchema } from '../modules';
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
});
export type WorkspaceSetupItem = z.infer<typeof WorkspaceSetupItemSchema>;

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
});
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

export const UpdateWorkspaceProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  dataRegion: DataRegionSchema.optional(),
  logoFileId: UuidSchema.nullable().optional(),
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
