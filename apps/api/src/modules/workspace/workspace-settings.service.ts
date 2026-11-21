import { Inject, Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type BackupStatus,
  BACKUP_VERIFICATION_MAX_AGE_DAYS,
  containsSecretKey,
  INTEGRATION_KINDS,
  INTEGRATION_PROVIDERS,
  IntegrationConfigSchemas,
  type IntegrationActivity,
  type IntegrationKind,
  type IntegrationStatus,
  JOB_KEYS,
  type MessageChannel,
  OfficeModuleConfigSchema,
  type RecordBackupVerification,
  type RetentionResponse,
  type UpdateIntegrationSetting,
  type UpdateRetention,
  type UpdateWorkspaceSecurity,
  type WorkspaceSecurityDetail,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { AppConfig } from '../../config/app-config';
import { CaptchaVerifierRegistry } from '../../platform/captcha';
import { MessageProviderRegistry } from '../../platform/messaging/message-provider.registry';
import { MALWARE_SCANNER, type MalwareScanner } from '../../platform/scanning';
import { PrismaService } from '../../prisma/prisma.service';
import { loadMfaPosture } from './mfa-posture';
import { backupIsCurrent, lockTenant, readWorkspaceSettings, retentionChangeNeedsNewNotice, writeSettingsSection } from './workspace-settings';

/**
 * Sign-in does not read the tenant policy yet (docs/CHANGE_REQUESTS.md WA1, owner auth). The S30
 * screen says so instead of implying the policy is enforced.
 */
export const SIGN_IN_ENFORCES_TENANT_POLICY = false;

const CHANNEL_OF: Partial<Record<IntegrationKind, MessageChannel>> = { email: 'EMAIL', sms: 'SMS', push: 'PUSH' };

type UserRef = { id: string; displayName: string };

/**
 * S30 system settings (API contract §33.3): integration status and selection, retention,
 * security policy and summary, backup verification. Vendor secrets live only in the server
 * environment: these endpoints report provider names, configured / available flags and the
 * NAMES of missing variables, never a value.
 */
@Injectable()
export class WorkspaceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly providers: MessageProviderRegistry,
    private readonly captcha: CaptchaVerifierRegistry,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  /* ------------------------------ Integrations ------------------------------ */

  /**
   * Environment variable NAMES the provider needs on this server and that are not set (values are
   * never read out). A provider other than the one the server selected lists the selector too.
   */
  requirements(kind: IntegrationKind, provider: string): { configured: boolean; missingEnv: string[] } {
    const v = this.config.values;
    const need: Array<[boolean, string]> = [];
    const messagingKeys: Array<[boolean, string]> = [
      [!!v.MESSAGING_ENCRYPTION_KEY, 'MESSAGING_ENCRYPTION_KEY'],
      [!!v.MESSAGING_HASH_KEY, 'MESSAGING_HASH_KEY'],
    ];
    if (provider === INTEGRATION_PROVIDERS[kind][0]) return { configured: true, missingEnv: [] };
    switch (`${kind}:${provider}`) {
      case 'email:smtp':
        need.push([v.EMAIL_PROVIDER === 'smtp', 'EMAIL_PROVIDER'], [!!v.SMTP_HOST, 'SMTP_HOST'], [!!v.EMAIL_FROM_ADDRESS, 'EMAIL_FROM_ADDRESS'], ...messagingKeys);
        break;
      case 'sms:africastalking':
        need.push(
          [v.SMS_PROVIDER === 'africastalking', 'SMS_PROVIDER'],
          [!!v.AFRICASTALKING_USERNAME, 'AFRICASTALKING_USERNAME'],
          [!!v.AFRICASTALKING_API_KEY, 'AFRICASTALKING_API_KEY'],
          ...messagingKeys,
        );
        break;
      case 'push:webpush':
        need.push(
          [v.PUSH_PROVIDER === 'webpush', 'PUSH_PROVIDER'],
          [!!v.VAPID_PUBLIC_KEY, 'VAPID_PUBLIC_KEY'],
          [!!v.VAPID_PRIVATE_KEY, 'VAPID_PRIVATE_KEY'],
          [!!v.VAPID_SUBJECT, 'VAPID_SUBJECT'],
          ...messagingKeys,
        );
        break;
      case 'captcha:hcaptcha':
      case 'captcha:turnstile':
        need.push([v.CAPTCHA_PROVIDER === provider, 'CAPTCHA_PROVIDER'], [!!v.CAPTCHA_SITE_KEY, 'CAPTCHA_SITE_KEY'], [!!v.CAPTCHA_SECRET, 'CAPTCHA_SECRET']);
        break;
      case 'scanner:clamd':
        need.push([v.MALWARE_SCANNER === 'clamd', 'MALWARE_SCANNER'], [!!v.CLAMD_HOST, 'CLAMD_HOST']);
        break;
      default:
        return { configured: false, missingEnv: [] };
    }
    const missingEnv = need.filter(([ok]) => !ok).map(([, name]) => name);
    return { configured: missingEnv.length === 0, missingEnv };
  }

  /** The provider instance behind the server's selection is up (no network call: last state only). */
  private async isAvailable(kind: IntegrationKind, provider: string, enabled: boolean, configured: boolean): Promise<boolean> {
    if (!enabled || !configured || provider === INTEGRATION_PROVIDERS[kind][0]) return false;
    const channel = CHANNEL_OF[kind];
    if (channel) return this.providers.isDeliveryConfigured(channel);
    if (kind === 'captcha') return this.captcha.get(provider as 'hcaptcha' | 'turnstile') !== null;
    if (kind === 'scanner') {
      if (!this.scanner.isConfigured()) return false;
      const last = await this.lastPlatformRun(JOB_KEYS.FILES_SCAN_PENDING);
      return !last || last.status !== 'FAILED';
    }
    return false;
  }

  listIntegrations(auth: AuthContext): Promise<{ integrations: IntegrationStatus[] }> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => ({ integrations: await this.integrationStatuses(tx) }));
  }

  private async integrationStatuses(tx: TenantTx): Promise<IntegrationStatus[]> {
    const rows = await tx.tenantIntegrationSetting.findMany({ include: { updatedBy: { select: { id: true, displayName: true } } } });
    const out: IntegrationStatus[] = [];
    for (const kind of INTEGRATION_KINDS) {
      const row = rows.find((r) => r.kind === kind);
      const provider = row?.provider ?? INTEGRATION_PROVIDERS[kind][0];
      const enabled = row?.enabled ?? false;
      const { configured, missingEnv } = this.requirements(kind, provider);
      out.push({
        kind,
        provider,
        enabled,
        config: (row?.config ?? {}) as Record<string, unknown>,
        configured,
        available: await this.isAvailable(kind, provider, enabled, configured),
        missingEnv,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      });
    }
    return out;
  }

  updateIntegration(auth: AuthContext, kind: IntegrationKind, dto: UpdateIntegrationSetting): Promise<IntegrationStatus> {
    const providers = INTEGRATION_PROVIDERS[kind] as readonly string[];
    if (!providers.includes(dto.provider)) {
      throw AppException.validation(`Unknown provider for ${kind}`, [{ path: ['provider'], message: `Choose one of ${providers.join(', ')}` }]);
    }
    if (containsSecretKey(dto.config)) {
      throw AppException.validation('Secrets are configured in the server environment, not here', [{ path: ['config'], message: 'Secret-looking key' }]);
    }
    const parsed = IntegrationConfigSchemas[kind].safeParse(dto.config ?? {});
    if (!parsed.success) throw AppException.validation('Invalid integration configuration', parsed.error.issues);
    const { configured, missingEnv } = this.requirements(kind, dto.provider);
    if (dto.enabled && !configured) {
      throw AppException.conflict('This server is not configured for that provider', { missingEnv });
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const before = await tx.tenantIntegrationSetting.findFirst({ where: { kind } });
      await tx.tenantIntegrationSetting.upsert({
        where: { tenantId_kind: { tenantId: auth.tenantId, kind } },
        create: { tenantId: auth.tenantId, kind, provider: dto.provider, enabled: dto.enabled, config: parsed.data as object, updatedById: auth.userId },
        update: { provider: dto.provider, enabled: dto.enabled, config: parsed.data as object, updatedById: auth.userId },
      });
      if (kind === 'captcha') {
        // The Office portal reads its captcha provider from the module config: keep them in step.
        const office = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' } });
        const cfg = OfficeModuleConfigSchema.parse(office?.config ?? {});
        const captchaProvider = dto.enabled ? (dto.provider as 'none' | 'hcaptcha' | 'turnstile') : 'none';
        const siteKey = (parsed.data as { siteKey?: string }).siteKey ?? null;
        const next = { ...cfg, captchaProvider, captchaSiteKey: dto.enabled ? siteKey : null };
        await tx.tenantModule.upsert({
          where: { tenantId_moduleKey: { tenantId: auth.tenantId, moduleKey: 'office' } },
          create: { tenantId: auth.tenantId, moduleKey: 'office', enabled: false, config: next as object, updatedById: auth.userId },
          update: { config: next as object, updatedById: auth.userId },
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_INTEGRATION_UPDATED,
          entityType: 'TenantIntegrationSetting',
          entityId: kind,
          before: before ? { provider: before.provider, enabled: before.enabled, config: before.config } : null,
          after: { provider: dto.provider, enabled: dto.enabled, config: parsed.data },
        },
        tx,
      );
      return (await this.integrationStatuses(tx)).find((s) => s.kind === kind)!;
    });
  }

  /** Last delivery / scan per kind and 7-day counts by status. Counts only. */
  activity(auth: AuthContext): Promise<{ activity: IntegrationActivity[] }> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const out: IntegrationActivity[] = [];
      for (const kind of INTEGRATION_KINDS) {
        const channel = CHANNEL_OF[kind];
        if (channel) {
          const [last, grouped] = await Promise.all([
            tx.messageOutbox.findFirst({ where: { channel }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, status: true } }),
            tx.messageOutbox.groupBy({ by: ['status'], where: { channel, createdAt: { gte: since } }, _count: { _all: true } }),
          ]);
          out.push({
            kind,
            lastAt: last?.updatedAt.toISOString() ?? null,
            lastStatus: last?.status ?? null,
            last7Days: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
          });
        } else if (kind === 'scanner') {
          const [last, grouped] = await Promise.all([
            tx.storedFile.findFirst({ where: { scannedAt: { not: null } }, orderBy: { scannedAt: 'desc' }, select: { scannedAt: true, malwareScanStatus: true } }),
            tx.storedFile.groupBy({ by: ['malwareScanStatus'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
          ]);
          out.push({
            kind,
            lastAt: last?.scannedAt?.toISOString() ?? null,
            lastStatus: last?.malwareScanStatus ?? null,
            last7Days: Object.fromEntries(grouped.map((g) => [g.malwareScanStatus, g._count._all])),
          });
        } else {
          // Captcha verdicts are not stored (no personal data, no per-request log).
          out.push({ kind, lastAt: null, lastStatus: null, last7Days: {} });
        }
      }
      return { activity: out };
    });
  }

  /* -------------------------------- Retention -------------------------------- */

  getRetention(auth: AuthContext): Promise<RetentionResponse> {
    return this.prisma.withTenant(auth.tenantId, (tx) => this.retention(tx, auth.tenantId));
  }

  async updateRetention(auth: AuthContext, dto: UpdateRetention): Promise<RetentionResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tenant = await lockTenant(tx, auth.tenantId);
      const settings = readWorkspaceSettings(tenant.settings);
      const before = await this.retention(tx, auth.tenantId);
      let raw: unknown = tenant.settings;
      const put = async (key: string, value: unknown) => {
        await writeSettingsSection(tx, auth.tenantId, raw, key, value);
        raw = (await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { settings: true } })).settings;
      };

      let stated = settings.retention.statedUnderNotice;
      if (dto.office) {
        const officeRow = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' } });
        const cfg = OfficeModuleConfigSchema.parse(officeRow?.config ?? {});
        const currentVersion = settings.dataProtection?.privacyNoticeVersion ?? null;
        if (retentionChangeNeedsNewNotice(stated, dto.office)) {
          if (!dto.newNoticeVersion || dto.newNoticeVersion === currentVersion || dto.newNoticeVersion === stated?.noticeVersion) {
            throw AppException.conflict(
              'These periods differ from the ones stated in the current privacy notice. Publish a new notice version that states them and give its version.',
              { reason: 'NOTICE_VERSION_REQUIRED', statedUnderNotice: stated },
            );
          }
        }
        if (dto.newNoticeVersion) {
          if (!settings.dataProtection) throw AppException.conflict('Record the data-protection contact and privacy notice first (workspace setup)');
          await put('dataProtection', { ...settings.dataProtection, privacyNoticeVersion: dto.newNoticeVersion, reviewedById: auth.userId, reviewedAt: new Date().toISOString() });
          stated = { noticeVersion: dto.newNoticeVersion, ...dto.office };
        } else if (!stated && currentVersion) {
          stated = { noticeVersion: currentVersion, ...dto.office };
        }
        const next = { ...cfg, contactRetentionMonths: dto.office.contactRetentionMonths, caseRetentionMonths: dto.office.caseRetentionMonths };
        await tx.tenantModule.upsert({
          where: { tenantId_moduleKey: { tenantId: auth.tenantId, moduleKey: 'office' } },
          create: { tenantId: auth.tenantId, moduleKey: 'office', enabled: false, config: next as object, updatedById: auth.userId },
          update: { config: next as object, updatedById: auth.userId },
        });
      }
      if (dto.retentionProfile) await tx.tenant.update({ where: { id: auth.tenantId }, data: { retentionProfile: dto.retentionProfile } });
      await put('retention', { reviewedById: auth.userId, reviewedAt: new Date().toISOString(), statedUnderNotice: stated });

      const after = await this.retention(tx, auth.tenantId);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_RETENTION_UPDATED,
          entityType: 'Tenant',
          entityId: auth.tenantId,
          before: { retentionProfile: before.retentionProfile, office: before.office, statedUnderNotice: before.statedUnderNotice },
          after: { retentionProfile: after.retentionProfile, office: after.office, statedUnderNotice: after.statedUnderNotice },
          reason: dto.reason,
        },
        tx,
      );
      return after;
    });
  }

  private async retention(tx: TenantTx, tenantId: string): Promise<RetentionResponse> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { retentionProfile: true, settings: true } });
    const s = readWorkspaceSettings(tenant.settings).retention;
    const office = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' } });
    const cfg = office ? OfficeModuleConfigSchema.parse(office.config ?? {}) : null;
    const tenantRun = await tx.jobRun.findFirst({ where: { jobKey: JOB_KEYS.OFFICE_RETENTION }, orderBy: { startedAt: 'desc' } });
    const platformRun = await this.lastPlatformRun(JOB_KEYS.OFFICE_RETENTION);
    const run = [tenantRun, platformRun].filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return {
      retentionProfile: tenant.retentionProfile,
      office: office?.enabled && cfg ? { contactRetentionMonths: cfg.contactRetentionMonths, caseRetentionMonths: cfg.caseRetentionMonths } : null,
      statedUnderNotice: s.statedUnderNotice,
      reviewedBy: await this.userRef(tx, s.reviewedById),
      reviewedAt: s.reviewedAt,
      lastRun: run
        ? {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            counts: (run.counts ?? {}) as Record<string, number>,
          }
        : null,
    };
  }

  /* --------------------------------- Security --------------------------------- */

  getSecurity(auth: AuthContext): Promise<WorkspaceSecurityDetail> {
    return this.prisma.withTenant(auth.tenantId, (tx) => this.security(tx, auth.tenantId));
  }

  updateSecurity(auth: AuthContext, dto: UpdateWorkspaceSecurity): Promise<WorkspaceSecurityDetail> {
    const serverHours = this.config.values.JWT_REFRESH_TTL_SECONDS / 3600;
    if (dto.sessionMaxHours !== null && dto.sessionMaxHours > serverHours) {
      throw AppException.validation(`Sessions cannot be longer than this server allows (${Math.floor(serverHours)} hours)`, [
        { path: ['sessionMaxHours'], message: 'Longer than the server limit' },
      ]);
    }
    if (dto.idleTimeoutMinutes !== null && dto.sessionMaxHours !== null && dto.idleTimeoutMinutes > dto.sessionMaxHours * 60) {
      throw AppException.validation('The idle timeout cannot be longer than the session', [{ path: ['idleTimeoutMinutes'], message: 'Longer than the session' }]);
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tenant = await lockTenant(tx, auth.tenantId);
      const before = readWorkspaceSettings(tenant.settings).security;
      const next = {
        mfaPolicy: dto.mfaPolicy,
        sessionMaxHours: dto.sessionMaxHours,
        idleTimeoutMinutes: dto.idleTimeoutMinutes,
        updatedById: auth.userId,
        updatedAt: new Date().toISOString(),
      };
      await writeSettingsSection(tx, auth.tenantId, tenant.settings, 'security', next);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_PROFILE_UPDATED,
          entityType: 'WorkspaceSecurityPolicy',
          entityId: auth.tenantId,
          before: { mfaPolicy: before.mfaPolicy, sessionMaxHours: before.sessionMaxHours, idleTimeoutMinutes: before.idleTimeoutMinutes },
          after: { mfaPolicy: next.mfaPolicy, sessionMaxHours: next.sessionMaxHours, idleTimeoutMinutes: next.idleTimeoutMinutes },
          reason: dto.reason,
        },
        tx,
      );
      return this.security(tx, auth.tenantId);
    });
  }

  private async security(tx: TenantTx, tenantId: string): Promise<WorkspaceSecurityDetail> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const policy = readWorkspaceSettings(tenant.settings).security;
    const [roles, posture, pendingAccountRecoveries] = await Promise.all([
      tx.role.findMany({ where: { mfaRequired: true }, select: { key: true }, orderBy: { key: 'asc' } }),
      loadMfaPosture(tx, policy.mfaPolicy),
      tx.accountRecoveryRequest.count({ where: { status: { in: ['PENDING', 'APPROVED'] } } }),
    ]);
    const v = this.config.values;
    return {
      mfaRequiredRoleKeys: roles.map((r) => r.key),
      usersWithoutMfa: posture.privilegedWithoutMfa,
      passkeysRegistered: posture.passkeysRegistered,
      administratorsWithoutRecoveryCodes: posture.administratorsWithoutRecoveryCodes,
      pendingAccountRecoveries,
      invitationDelivery: this.providers.isDeliveryConfigured('EMAIL') ? 'OUTBOX' : 'SHOWN_ONCE',
      rateLimitStore: v.RATE_LIMIT_STORE === 'redis' || v.NODE_ENV === 'production' ? 'redis' : 'memory',
      policy: { mfaPolicy: policy.mfaPolicy, sessionMaxHours: policy.sessionMaxHours, idleTimeoutMinutes: policy.idleTimeoutMinutes },
      serverSessionMaxHours: Math.floor(v.JWT_REFRESH_TTL_SECONDS / 3600),
      accessTokenMinutes: Math.floor(v.JWT_ACCESS_TTL_SECONDS / 60),
      policyEnforcedAtSignIn: SIGN_IN_ENFORCES_TENANT_POLICY,
      updatedBy: await this.userRef(tx, policy.updatedById),
      updatedAt: policy.updatedAt,
    };
  }

  /* ---------------------------------- Backup ---------------------------------- */

  getBackup(auth: AuthContext): Promise<BackupStatus> {
    return this.prisma.withTenant(auth.tenantId, (tx) => this.backup(tx, auth.tenantId));
  }

  recordBackup(auth: AuthContext, dto: RecordBackupVerification): Promise<BackupStatus> {
    const tested = Date.parse(`${dto.testedOn}T00:00:00Z`);
    if (Number.isNaN(tested) || tested > Date.now() + 86_400_000) {
      throw AppException.validation('The test date cannot be in the future', [{ path: ['testedOn'], message: 'In the future' }]);
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tenant = await lockTenant(tx, auth.tenantId);
      const before = readWorkspaceSettings(tenant.settings).backup.last;
      const last = { ...dto, recordedById: auth.userId, recordedAt: new Date().toISOString() };
      await writeSettingsSection(tx, auth.tenantId, tenant.settings, 'backup', { last });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_SETUP_ITEM_UPDATED,
          entityType: 'BackupVerification',
          entityId: 'backup.verified',
          before: before ? { testedOn: before.testedOn, outcome: before.outcome, backupReference: before.backupReference } : null,
          after: { testedOn: dto.testedOn, outcome: dto.outcome, backupReference: dto.backupReference },
          reason: dto.note,
        },
        tx,
      );
      return this.backup(tx, auth.tenantId);
    });
  }

  private async backup(tx: TenantTx, tenantId: string): Promise<BackupStatus> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const last = readWorkspaceSettings(tenant.settings).backup.last;
    return {
      last: last
        ? {
            testedOn: last.testedOn,
            backupReference: last.backupReference,
            outcome: last.outcome,
            note: last.note,
            recordedBy: await this.userRef(tx, last.recordedById),
            recordedAt: last.recordedAt,
          }
        : null,
      current: backupIsCurrent(last),
      maxAgeDays: BACKUP_VERIFICATION_MAX_AGE_DAYS,
    };
  }

  /* --------------------------------- Helpers --------------------------------- */

  private async userRef(tx: TenantTx, id: string | null): Promise<UserRef | null> {
    if (!id) return null;
    return tx.user.findFirst({ where: { id }, select: { id: true, displayName: true } });
  }

  /**
   * Latest platform-level run (tenant_id NULL) of a job. Platform rows are visible only on a
   * connection without a tenant setting, so this reads outside any tenant transaction. Status and
   * times only; platform error text is not shown to tenant administrators.
   */
  private async lastPlatformRun(jobKey: string) {
    return this.prisma.client.jobRun.findFirst({
      where: { jobKey, tenantId: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, startedAt: true, finishedAt: true, counts: true },
    });
  }
}
