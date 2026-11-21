import { HttpStatus, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { provisionSystemRoles, type Tenant, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type CreateWorkspace,
  type CreateWorkspaceResponse,
  environmentDefinition,
  ERROR_CODES,
  isScanClean,
  MESSAGE_TEMPLATE_KEYS,
  OfficeModuleConfigSchema,
  type PlatformWorkspaceSummary,
  TENANT_MODULES,
  type TenantModuleKey,
  type UpdateWorkspaceProfile,
  WORKSPACE_SETUP_ITEMS,
  type WorkspaceAdminInvitation,
  type WorkspaceProfile,
} from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { AuthService } from '../../auth/auth.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { MESSAGE_OUTBOX, type MessageOutboxPort } from '../../platform/messaging/outbox.types';
import { MessageProviderRegistry } from '../../platform/messaging/message-provider.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { portalServiceEmail } from '../../tenant-modules/tenant-modules.service';
import { OnboardingService } from './onboarding.service';
import { isValidTimeZone, lockTenant, readWorkspaceSettings, writeSettingsSection } from './workspace-settings';

/** Logo uploads: small images only (re-encoded without metadata by StorageService). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface LogoUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

type TenantRow = Tenant;

/**
 * S02 workspace setup and profile (API contract §33.1).
 *
 * Creation runs in ONE transaction: it starts under the operator's PLATFORM tenant (the only place
 * `ngao_provision_workspace` accepts a call), audits there, then switches the transaction's tenant
 * setting to the new organisation so roles, modules, setup items, the first administrators,
 * their invitations (outbox) and the new tenant's audit trail are written under its own RLS. If
 * any step fails nothing is left behind.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly storage: StorageService,
    private readonly onboarding: OnboardingService,
    private readonly providers: MessageProviderRegistry,
    @Optional() @Inject(MESSAGE_OUTBOX) private readonly outbox?: MessageOutboxPort,
  ) {}

  /* ------------------------------- Profile -------------------------------- */

  getProfile(auth: AuthContext): Promise<WorkspaceProfile> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => this.toProfile(tx, await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } })));
  }

  updateProfile(auth: AuthContext, dto: UpdateWorkspaceProfile): Promise<WorkspaceProfile> {
    if (dto.timezone && !isValidTimeZone(dto.timezone)) throw AppException.validation('Unknown time zone', [{ path: ['timezone'], message: 'Unknown time zone' }]);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tenant = await lockTenant(tx, auth.tenantId);
      const settings = readWorkspaceSettings(tenant.settings);
      const before = this.profileSnapshot(tenant);

      if (dto.logoFileId) {
        const file = await tx.storedFile.findFirst({ where: { id: dto.logoFileId }, select: { mimeType: true, malwareScanStatus: true } });
        if (!file) throw AppException.notFound('Logo file not found');
        if (!LOGO_MIME_TYPES.has(file.mimeType)) throw AppException.validation('The logo must be a PNG, JPEG or WebP image');
        if (!isScanClean(file.malwareScanStatus)) {
          throw new AppException(ERROR_CODES.FILE_NOT_CLEAN, HttpStatus.CONFLICT, 'The logo can be used once the malware scan has recorded it as clean', {
            scanStatus: file.malwareScanStatus,
          });
        }
      }

      await tx.tenant.update({
        where: { id: auth.tenantId },
        data: {
          ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
          ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
          ...(dto.dataRegion !== undefined ? { dataRegion: dto.dataRegion } : {}),
        },
      });
      let raw = (await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { settings: true } })).settings;
      const put = async (key: string, value: unknown) => {
        await writeSettingsSection(tx, auth.tenantId, raw, key, value);
        raw = (await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { settings: true } })).settings;
      };
      if (dto.logoFileId !== undefined) await put('logoFileId', dto.logoFileId);
      if (dto.defaultCountyCode !== undefined) await put('defaultCountyCode', dto.defaultCountyCode);
      if (dto.dataProtection) {
        const dp = dto.dataProtection;
        const now = new Date().toISOString();
        await put('dataProtection', {
          controllerName: dp.controllerName,
          contactName: dp.contactName,
          contactEmail: dp.contactEmail,
          contactPhone: dp.contactPhone ?? null,
          privacyNoticeVersion: dp.privacyNoticeVersion,
          staffNoticeVersion: dp.staffNoticeVersion ?? null,
          reviewedById: auth.userId,
          reviewedAt: now,
        });
        // The Office periods in force are what this notice version states from now on (§33.3).
        const stated = settings.retention.statedUnderNotice;
        if (!stated || stated.noticeVersion !== dp.privacyNoticeVersion) {
          const office = await this.officePeriods(tx);
          await put('retention', { ...settings.retention, statedUnderNotice: office ? { noticeVersion: dp.privacyNoticeVersion, ...office } : null });
        }
      }

      const after = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_PROFILE_UPDATED,
          entityType: 'Tenant',
          entityId: auth.tenantId,
          before,
          after: this.profileSnapshot(after),
          reason: dto.reason ?? null,
        },
        tx,
      );
      await this.onboarding.markDone(tx, auth.tenantId, auth.userId, 'workspace.profile');
      return this.toProfile(tx, after);
    });
  }

  /** Store a logo image (PENDING until the scanner records it CLEAN); returns the file id and scan state. */
  uploadLogo(auth: AuthContext, file: LogoUpload | undefined): Promise<{ fileId: string; scanStatus: string; sha256: string }> {
    if (!file) throw AppException.validation('Attach an image file');
    if (file.size > MAX_LOGO_BYTES) throw AppException.validation('The logo must be 2 MB or smaller');
    if (!LOGO_MIME_TYPES.has(file.mimetype)) throw AppException.validation('The logo must be a PNG, JPEG or WebP image');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const { file: stored } = await this.storage.storeImmutable(
        {
          tenantId: auth.tenantId,
          uploadedById: auth.userId,
          buffer: file.buffer,
          declaredMimeType: file.mimetype,
          originalFilename: file.originalname || 'logo',
          purpose: 'OTHER',
          stripImageMetadata: true,
        },
        tx,
      );
      return { fileId: stored.id, scanStatus: stored.malwareScanStatus, sha256: stored.sha256 };
    });
  }

  /* --------------------------- Platform provisioning --------------------------- */

  listWorkspaces(auth: AuthContext): Promise<PlatformWorkspaceSummary[]> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.assertPlatformTenant(tx, auth.tenantId);
      const rows = await tx.tenant.findMany({ where: { type: { not: 'PLATFORM' } }, orderBy: { createdAt: 'desc' }, take: 500 });
      return rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        type: t.type,
        status: t.status,
        historicalDemo: t.historicalDemo,
        createdAt: t.createdAt.toISOString(),
      }));
    });
  }

  async createWorkspace(auth: AuthContext, dto: CreateWorkspace): Promise<CreateWorkspaceResponse> {
    if (!isValidTimeZone(dto.timezone)) throw AppException.validation('Unknown time zone', [{ path: ['timezone'], message: 'Unknown time zone' }]);
    let modules: TenantModuleKey[] = [...new Set(dto.modules)];
    if (dto.environment) {
      const env = environmentDefinition(dto.environment);
      if (!env.tenantTypes.includes(dto.type)) {
        throw AppException.validation(`A ${env.label.toLowerCase()} workspace cannot be of type ${dto.type}`, [{ path: ['type'], message: 'Type does not match the environment' }]);
      }
      if (modules.length === 0) modules = [...env.defaultModules];
    }
    const admins = [dto.admin, ...(dto.additionalAdmins ?? [])];
    if (new Set(admins.map((a) => a.email)).size !== admins.length) throw AppException.validation('Each administrator needs a different e-mail address');

    const deliverByEmail = this.providers.isDeliveryConfigured('EMAIL');
    // Fail closed: with e-mail configured the link must never reach the operator, so without the
    // outbox nothing is created at all.
    if (deliverByEmail && !this.outbox) throw new ServiceUnavailableException('Invitation delivery is not available; try again later');

    const newId = randomUUID();
    const settings: Record<string, unknown> = {
      ...(dto.environment ? { environment: dto.environment } : {}),
      ...(dto.defaultCountyCode ? { defaultCountyCode: dto.defaultCountyCode } : {}),
      ...(dto.dataProtection
        ? {
            // Recorded by the operator; the organisation still reviews it (S03 privacy.notice_reviewed).
            dataProtection: {
              ...dto.dataProtection,
              contactPhone: dto.dataProtection.contactPhone ?? null,
              staffNoticeVersion: dto.dataProtection.staffNoticeVersion ?? null,
              reviewedById: null,
              reviewedAt: null,
            },
          }
        : {}),
    };

    const result = await this.prisma.withTenant(
      auth.tenantId,
      async (tx) => {
        await this.assertPlatformTenant(tx, auth.tenantId);
        const taken = await tx.tenant.findUnique({ where: { slug: dto.slug }, select: { id: true } });
        if (taken) throw AppException.conflict('An organisation with this code already exists');
        try {
          await tx.$queryRaw`SELECT ngao_provision_workspace(${newId}::uuid, ${dto.slug}, ${dto.name}, ${dto.displayName ?? dto.name},
            ${dto.type}::"TenantType", ${dto.timezone}, ${'en-KE'}, ${dto.dataRegion}, ${JSON.stringify(settings)}::jsonb)::text AS id`;
        } catch (err) {
          throw this.mapProvisioningError(err);
        }
        const summary = { tenantId: newId, slug: dto.slug, type: dto.type, environment: dto.environment ?? null, modules, administrators: admins.length };
        await this.audit.record(
          { tenantId: auth.tenantId, action: AUDIT_ACTIONS.WORKSPACE_CREATED, entityType: 'Tenant', entityId: newId, after: summary, reason: dto.reason ?? null },
          tx,
        );

        // From here on the transaction acts for the new organisation (RLS setting switched).
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${newId}, true)`;
        const actor = { actorId: auth.userId, actorType: 'PLATFORM_SUPPORT' as const };
        const roleIds = await provisionSystemRoles(tx as Parameters<typeof provisionSystemRoles>[0], newId);
        await this.audit.record({ tenantId: newId, ...actor, action: AUDIT_ACTIONS.WORKSPACE_CREATED, entityType: 'Tenant', entityId: newId, after: summary, reason: dto.reason ?? null }, tx);

        for (const def of TENANT_MODULES) {
          const enabled = modules.includes(def.key);
          let config: Record<string, unknown> = {};
          if (def.key === 'office' && enabled) {
            config = OfficeModuleConfigSchema.parse({ portalServiceUserId: await this.createPortalServiceUser(tx, newId, dto.slug) });
          }
          await tx.tenantModule.create({ data: { tenantId: newId, moduleKey: def.key, enabled, config: config as object } });
        }
        await tx.workspaceSetupItem.createMany({ data: WORKSPACE_SETUP_ITEMS.map((i) => ({ tenantId: newId, itemKey: i.key })), skipDuplicates: true });

        const ownerRoleId = roleIds.ORGANISATION_OWNER;
        if (!ownerRoleId) throw new Error('ORGANISATION_OWNER role was not provisioned');
        const invitations: WorkspaceAdminInvitation[] = [];
        for (const admin of admins) {
          invitations.push(await this.inviteAdministrator(tx, newId, dto, admin, ownerRoleId, actor, deliverByEmail));
        }
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: newId } });
        return { workspace: await this.toProfile(tx, tenant), invitations };
      },
      { timeout: 60_000 },
    );
    const [adminInvitation, ...additionalInvitations] = result.invitations;
    return { workspace: result.workspace, adminInvitation: adminInvitation!, additionalInvitations };
  }

  /* -------------------------------- Helpers -------------------------------- */

  private async inviteAdministrator(
    tx: TenantTx,
    tenantId: string,
    dto: CreateWorkspace,
    admin: { email: string; displayName: string },
    ownerRoleId: string,
    actor: { actorId: string; actorType: 'PLATFORM_SUPPORT' },
    deliverByEmail: boolean,
  ): Promise<WorkspaceAdminInvitation> {
    const invitation = this.authService.newInvitation();
    const user = await tx.user.create({
      data: {
        tenantId,
        email: admin.email,
        displayName: admin.displayName,
        passwordHash: null,
        status: 'INVITED',
        invitationTokenHash: invitation.tokenHash,
        invitationExpiresAt: invitation.expiresAt,
      },
    });
    await this.audit.record(
      {
        tenantId,
        ...actor,
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: 'User',
        entityId: user.id,
        after: { id: user.id, displayName: user.displayName, status: user.status, invitationExpiresAt: invitation.expiresAt.toISOString(), firstAdministrator: true },
        reason: 'First administrator (workspace setup)',
      },
      tx,
    );
    const assignment = await tx.roleAssignment.create({
      data: { tenantId, userId: user.id, roleId: ownerRoleId, scopeType: 'ORGANISATION', reason: 'First administrator (workspace setup)' },
    });
    await this.audit.record(
      {
        tenantId,
        ...actor,
        action: AUDIT_ACTIONS.ROLE_ASSIGNED,
        entityType: 'RoleAssignment',
        entityId: assignment.id,
        after: { userId: user.id, roleKey: 'ORGANISATION_OWNER', scopeType: 'ORGANISATION' },
        reason: 'First administrator (workspace setup)',
      },
      tx,
    );

    if (deliverByEmail) {
      // Contract §32.4: the token goes only into the sealed secret payload; never returned.
      const queued = await this.outbox!.enqueueInTx(tx, {
        tenantId,
        channel: 'EMAIL',
        templateKey: MESSAGE_TEMPLATE_KEYS.AUTH_INVITATION,
        recipientUserId: user.id,
        addressOverride: admin.email,
        payload: { organisationName: dto.displayName ?? dto.name, tenantSlug: dto.slug, expiresAt: invitation.expiresAt.toISOString() },
        secretPayload: { token: invitation.token },
        idempotencyKey: `invitation:${user.id}:${invitation.tokenHash.slice(0, 16)}`,
        createdById: null,
      });
      return { userId: user.id, email: admin.email, expiresAt: invitation.expiresAt.toISOString(), delivery: 'OUTBOX', messageId: queued.messageId, acceptPath: null };
    }
    return {
      userId: user.id,
      email: admin.email,
      expiresAt: invitation.expiresAt.toISOString(),
      delivery: 'SHOWN_ONCE',
      messageId: null,
      acceptPath: `/accept-invitation#token=${invitation.token}`,
    };
  }

  private async createPortalServiceUser(tx: TenantTx, tenantId: string, slug: string): Promise<string> {
    const user = await tx.user.create({
      data: { id: randomUUID(), tenantId, email: portalServiceEmail(slug), displayName: 'Public portal (system account)', status: 'DEACTIVATED', passwordHash: null },
      select: { id: true },
    });
    return user.id;
  }

  private async assertPlatformTenant(tx: TenantTx, tenantId: string): Promise<void> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { type: true } });
    if (t?.type !== 'PLATFORM') throw AppException.forbidden('Organisations are created from the platform organisation only');
  }

  private mapProvisioningError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('WORKSPACE_PROVISIONING_FORBIDDEN')) return AppException.forbidden('Organisations are created from the platform organisation only');
    if (msg.includes('WORKSPACE_PROVISIONING_INVALID')) return AppException.validation('The organisation details are not valid');
    if (msg.includes('tenants_slug_key') || msg.includes('23505')) return AppException.conflict('An organisation with this code already exists');
    this.logger.error(`Workspace provisioning failed: ${msg.split('\n')[0]}`);
    return err instanceof Error ? err : new Error(msg);
  }

  private async officePeriods(tx: TenantTx): Promise<{ contactRetentionMonths: number; caseRetentionMonths: number } | null> {
    const row = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' }, select: { config: true, enabled: true } });
    if (!row?.enabled) return null;
    const cfg = OfficeModuleConfigSchema.parse(row.config ?? {});
    return { contactRetentionMonths: cfg.contactRetentionMonths, caseRetentionMonths: cfg.caseRetentionMonths };
  }

  private profileSnapshot(t: TenantRow) {
    const s = readWorkspaceSettings(t.settings);
    return {
      displayName: t.displayName,
      timezone: t.timezone,
      locale: t.locale,
      dataRegion: t.dataRegion,
      logoFileId: s.logoFileId,
      defaultCountyCode: s.defaultCountyCode,
      dataProtection: s.dataProtection
        ? {
            controllerName: s.dataProtection.controllerName,
            contactName: s.dataProtection.contactName,
            contactEmail: s.dataProtection.contactEmail,
            privacyNoticeVersion: s.dataProtection.privacyNoticeVersion,
            staffNoticeVersion: s.dataProtection.staffNoticeVersion,
          }
        : null,
    };
  }

  async toProfile(tx: TenantTx, t: TenantRow): Promise<WorkspaceProfile> {
    const s = readWorkspaceSettings(t.settings);
    const reviewer = s.dataProtection?.reviewedById
      ? await tx.user.findFirst({ where: { id: s.dataProtection.reviewedById }, select: { id: true, displayName: true } })
      : null;
    const logo = s.logoFileId ? await tx.storedFile.findFirst({ where: { id: s.logoFileId }, select: { malwareScanStatus: true } }) : null;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      displayName: t.displayName,
      type: t.type,
      timezone: t.timezone,
      locale: t.locale,
      dataRegion: t.dataRegion,
      logoFileId: s.logoFileId,
      historicalDemo: t.historicalDemo,
      createdAt: t.createdAt.toISOString(),
      environment: s.environment,
      defaultCountyCode: s.defaultCountyCode,
      logoScanStatus: logo?.malwareScanStatus ?? null,
      dataProtection: s.dataProtection
        ? {
            controllerName: s.dataProtection.controllerName,
            contactName: s.dataProtection.contactName,
            contactEmail: s.dataProtection.contactEmail,
            contactPhone: s.dataProtection.contactPhone,
            privacyNoticeVersion: s.dataProtection.privacyNoticeVersion,
            staffNoticeVersion: s.dataProtection.staffNoticeVersion,
            reviewedBy: reviewer,
            reviewedAt: s.dataProtection.reviewedAt,
          }
        : null,
    };
  }
}
