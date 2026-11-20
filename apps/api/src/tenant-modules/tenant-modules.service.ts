import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  type FieldModuleConfig,
  FieldModuleConfigSchema,
  AUDIT_ACTIONS,
  ERROR_CODES,
  effectiveModules,
  moduleDefinition,
  type OfficeModuleConfig,
  OfficeModuleConfigSchema,
  TENANT_MODULES,
  type TenantModuleKey,
  type TenantModuleState,
  type UpdateTenantModule,
} from '@ngao360/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { AppException } from '../common/http/app-exception';
import { PrismaService } from '../prisma/prisma.service';

/** Email of the non-login service account that owns public-portal uploads. */
export function portalServiceEmail(tenantSlug: string): string {
  return `portal-service@${tenantSlug}.invalid`;
}

/**
 * Tenant module activation (packages/shared/src/modules.ts). Module state is
 * read inside the caller's tenant transaction, so RLS applies.
 */
@Injectable()
export class TenantModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Effective enabled modules for the tenant of `tx`. */
  async enabledModules(tx: TenantTx): Promise<TenantModuleKey[]> {
    const rows = await tx.tenantModule.findMany({ select: { moduleKey: true, enabled: true } });
    return effectiveModules(rows);
  }

  async isEnabled(tx: TenantTx, key: TenantModuleKey): Promise<boolean> {
    const row = await tx.tenantModule.findFirst({ where: { moduleKey: key }, select: { enabled: true } });
    return row ? row.enabled : moduleDefinition(key).defaultEnabled;
  }

  /** Throws 403 MODULE_DISABLED when the module is off for the tenant of `tx`. */
  async assertEnabled(tx: TenantTx, key: TenantModuleKey): Promise<void> {
    if (!(await this.isEnabled(tx, key))) throw moduleDisabled(key);
  }

  /** Field-operations configuration with defaults applied (works when no row exists). */
  async fieldConfig(tx: TenantTx): Promise<FieldModuleConfig> {
    const row = await tx.tenantModule.findFirst({ where: { moduleKey: 'field' }, select: { config: true } });
    return FieldModuleConfigSchema.parse(row?.config ?? {});
  }

  /** Office configuration with defaults applied (works when no row exists). */
  async officeConfig(tx: TenantTx): Promise<OfficeModuleConfig> {
    const row = await tx.tenantModule.findFirst({ where: { moduleKey: 'office' }, select: { config: true } });
    return OfficeModuleConfigSchema.parse(row?.config ?? {});
  }

  list(auth: AuthContext): Promise<TenantModuleState[]> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.tenantModule.findMany({
        include: { updatedBy: { select: { id: true, displayName: true } } },
      });
      return TENANT_MODULES.map((def) => {
        const row = rows.find((r) => r.moduleKey === def.key);
        return {
          key: def.key,
          label: def.label,
          description: def.description,
          enabled: row ? row.enabled : def.defaultEnabled,
          isDefault: !row,
          config: this.configFor(def.key, row?.config),
          updatedAt: row ? row.updatedAt.toISOString() : null,
          updatedBy: row?.updatedBy ?? null,
        };
      });
    });
  }

  /**
   * Switch a module on or off and/or replace its configuration. Enabling
   * `office` creates the portal service account (no password, no roles,
   * DEACTIVATED) the first time. Audit: MODULE_UPDATED.
   */
  update(auth: AuthContext, key: TenantModuleKey, dto: UpdateTenantModule): Promise<TenantModuleState[]> {
    return this.prisma
      .withTenant(auth.tenantId, async (tx) => {
        const before = await tx.tenantModule.findFirst({ where: { moduleKey: key } });
        let config = this.configFor(key, dto.config ?? before?.config);
        if (key === 'office' && dto.enabled) {
          const office = OfficeModuleConfigSchema.parse(config);
          if (!office.portalServiceUserId) {
            office.portalServiceUserId = await this.ensurePortalServiceUser(tx, auth.tenantId);
          }
          config = office;
        }
        const after = await tx.tenantModule.upsert({
          where: { tenantId_moduleKey: { tenantId: auth.tenantId, moduleKey: key } },
          create: { tenantId: auth.tenantId, moduleKey: key, enabled: dto.enabled, config: config as object, updatedById: auth.userId },
          update: { enabled: dto.enabled, config: config as object, updatedById: auth.userId },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.MODULE_UPDATED,
            entityType: 'TenantModule',
            entityId: key,
            before: before ? { enabled: before.enabled, config: before.config } : null,
            after: { enabled: after.enabled, config: after.config },
            reason: dto.reason,
          },
          tx,
        );
      })
      .then(() => this.list(auth));
  }

  private configFor(key: TenantModuleKey, raw: unknown): Record<string, unknown> {
    if (key === 'field') {
      const parsed = FieldModuleConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw AppException.validation('Invalid field module configuration', parsed.error.issues);
      return parsed.data;
    }
    if (key !== 'office') return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const parsed = OfficeModuleConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) throw AppException.validation('Invalid office module configuration', parsed.error.issues);
    return parsed.data;
  }

  private async ensurePortalServiceUser(tx: TenantTx, tenantId: string): Promise<string> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
    const email = portalServiceEmail(tenant.slug);
    const existing = await tx.user.findFirst({ where: { email }, select: { id: true } });
    if (existing) return existing.id;
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        tenantId,
        email,
        displayName: 'Public portal (system account)',
        status: 'DEACTIVATED',
        passwordHash: null,
      },
      select: { id: true },
    });
    return user.id;
  }
}

export function moduleDisabled(key: TenantModuleKey): AppException {
  return new AppException(ERROR_CODES.MODULE_DISABLED, HttpStatus.FORBIDDEN, `${moduleDefinition(key).label} is not enabled for this organisation`);
}
