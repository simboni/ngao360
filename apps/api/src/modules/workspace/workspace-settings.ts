/**
 * Workspace sections of `tenants.settings` (JSON) and the pure rules around them. Owner:
 * workspace-admin. Each section is read with a schema so a malformed or older value falls back to
 * safe defaults instead of failing a screen; writers always go through `writeSettingsSection`
 * after locking the tenant row (`lockTenant`).
 *
 *   logoFileId          stored file id of the logo (CLEAN only)
 *   environment         CAMPAIGN | ELECTION | OFFICE (S02 preset)
 *   defaultCountyCode   three-digit county code for the default geography
 *   dataProtection      controller, contact, notice versions, reviewedById / reviewedAt
 *   retention           reviewedById / reviewedAt, statedUnderNotice { noticeVersion, periods }
 *   security            mfaPolicy, sessionMaxHours, idleTimeoutMinutes, updatedById / updatedAt
 *   backup              last { testedOn, backupReference, outcome, note, recordedById, recordedAt }
 */
import type { Tenant, TenantTx } from '@ngao360/db';
import {
  BACKUP_VERIFICATION_MAX_AGE_DAYS,
  DataProtectionInputSchema,
  type MfaPolicy,
  OfficeRetentionSchema,
  RecordBackupVerificationSchema,
  WorkspaceEnvironmentSchema,
  type WorkspaceSecurityPolicy,
  WorkspaceSecurityPolicySchema,
} from '@ngao360/shared';
import { z } from 'zod';

export const StoredDataProtectionSchema = DataProtectionInputSchema.extend({
  contactPhone: z.string().nullable().catch(null),
  staffNoticeVersion: z.string().nullable().catch(null),
  reviewedById: z.string().uuid().nullable().catch(null),
  reviewedAt: z.string().nullable().catch(null),
});
export type StoredDataProtection = z.infer<typeof StoredDataProtectionSchema>;

export const StoredRetentionSchema = z.object({
  reviewedById: z.string().uuid().nullable().catch(null),
  reviewedAt: z.string().nullable().catch(null),
  statedUnderNotice: OfficeRetentionSchema.extend({ noticeVersion: z.string() }).nullable().catch(null),
});
export type StoredRetention = z.infer<typeof StoredRetentionSchema>;

export const StoredSecuritySchema = WorkspaceSecurityPolicySchema.extend({
  updatedById: z.string().uuid().nullable().catch(null),
  updatedAt: z.string().nullable().catch(null),
});
export type StoredSecurity = z.infer<typeof StoredSecuritySchema>;

export const StoredBackupSchema = z.object({
  last: RecordBackupVerificationSchema.extend({ recordedById: z.string().uuid().nullable(), recordedAt: z.string() }).nullable().catch(null),
});
export type StoredBackup = z.infer<typeof StoredBackupSchema>;

export interface WorkspaceSettings {
  logoFileId: string | null;
  environment: z.infer<typeof WorkspaceEnvironmentSchema> | null;
  defaultCountyCode: string | null;
  dataProtection: StoredDataProtection | null;
  retention: StoredRetention;
  security: StoredSecurity;
  backup: StoredBackup;
}

function section<T extends z.ZodTypeAny>(schema: T, raw: unknown, fallback: z.infer<T>): z.infer<T> {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

/** Parse the workspace sections of `tenants.settings` (other keys are left alone by writers). */
export function readWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    logoFileId: typeof s.logoFileId === 'string' && z.string().uuid().safeParse(s.logoFileId).success ? s.logoFileId : null,
    environment: section(WorkspaceEnvironmentSchema.nullable(), s.environment ?? null, null),
    defaultCountyCode: typeof s.defaultCountyCode === 'string' && /^\d{3}$/.test(s.defaultCountyCode) ? s.defaultCountyCode : null,
    dataProtection: section(StoredDataProtectionSchema.nullable(), s.dataProtection ?? null, null),
    retention: section(StoredRetentionSchema, s.retention ?? {}, { reviewedById: null, reviewedAt: null, statedUnderNotice: null }),
    security: section(StoredSecuritySchema, s.security ?? {}, {
      mfaPolicy: 'PRIVILEGED_ROLES',
      sessionMaxHours: null,
      idleTimeoutMinutes: null,
      updatedById: null,
      updatedAt: null,
    }),
    backup: section(StoredBackupSchema, s.backup ?? {}, { last: null }),
  };
}

/** Lock the caller's tenant row for a read-modify-write of `settings` and return it. */
export async function lockTenant(tx: TenantTx, tenantId: string): Promise<Tenant> {
  await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  return tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
}

/** Replace one top-level key of `tenants.settings`, keeping every other key. */
export async function writeSettingsSection(tx: TenantTx, tenantId: string, current: unknown, key: string, value: unknown): Promise<void> {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...base, [key]: value } as object } });
}

/* ------------------------------- Pure rules -------------------------------- */

/**
 * Sign-in rules from the tenant policy, for the auth module (docs/CHANGE_REQUESTS.md WA1).
 * The tenant can only tighten the server: MFA for everyone on top of the role rules, and a
 * session limit shorter than JWT_REFRESH_TTL_SECONDS.
 */
export function effectiveSignInPolicy(
  policy: Pick<WorkspaceSecurityPolicy, 'mfaPolicy' | 'sessionMaxHours' | 'idleTimeoutMinutes'>,
  serverRefreshTtlSeconds: number,
): { mfaForEveryone: boolean; refreshTtlSeconds: number; idleTimeoutSeconds: number | null } {
  const tenantTtl = policy.sessionMaxHours ? policy.sessionMaxHours * 3600 : Number.POSITIVE_INFINITY;
  return {
    mfaForEveryone: policy.mfaPolicy === ('ALL_USERS' satisfies MfaPolicy),
    refreshTtlSeconds: Math.min(serverRefreshTtlSeconds, tenantTtl),
    idleTimeoutSeconds: policy.idleTimeoutMinutes ? policy.idleTimeoutMinutes * 60 : null,
  };
}

/** Read the tenant security policy inside a tenant transaction (for the auth module). */
export async function readSecurityPolicy(tx: TenantTx, tenantId: string): Promise<WorkspaceSecurityPolicy> {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const { mfaPolicy, sessionMaxHours, idleTimeoutMinutes } = readWorkspaceSettings(t?.settings).security;
  return { mfaPolicy, sessionMaxHours, idleTimeoutMinutes };
}

/** A recorded restore test counts when it succeeded and is at most BACKUP_VERIFICATION_MAX_AGE_DAYS old. */
export function backupIsCurrent(last: StoredBackup['last'], now = new Date()): boolean {
  if (!last || last.outcome !== 'RESTORED_OK') return false;
  const tested = Date.parse(`${last.testedOn}T00:00:00Z`);
  if (Number.isNaN(tested)) return false;
  return now.getTime() - tested <= BACKUP_VERIFICATION_MAX_AGE_DAYS * 86_400_000;
}

/**
 * Retention change rule (contract §33.3, stricter): once Office periods are stated under a
 * privacy-notice version, changing them in either direction needs a new notice version. People
 * were told one period; keeping data longer, or deleting it earlier than stated, both contradict
 * the notice they saw.
 */
export function retentionChangeNeedsNewNotice(
  stated: StoredRetention['statedUnderNotice'],
  next: { contactRetentionMonths: number; caseRetentionMonths: number },
): boolean {
  if (!stated) return false;
  return stated.contactRetentionMonths !== next.contactRetentionMonths || stated.caseRetentionMonths !== next.caseRetentionMonths;
}

/** True when `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
