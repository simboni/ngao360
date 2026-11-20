import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  CASE_CATEGORY_LABELS,
  MAX_PUBLIC_PHOTO_BYTES,
  type OfficeModuleConfig,
  PUBLIC_HONEYPOT_FIELD,
  PUBLIC_PHOTO_MIME_TYPES,
  type PublicPortalInfo,
  portalPrivacyNotice,
} from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';

export interface PortalTenant {
  id: string;
  slug: string;
  name: string;
  config: OfficeModuleConfig;
}

/**
 * Resolves the tenant of a public-portal URL. Unknown, suspended or
 * office-disabled tenants and tenants with the portal switched off all answer
 * the same 404, so the portal never reveals which organisations exist.
 */
@Injectable()
export class PublicPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modules: TenantModulesService,
  ) {}

  async resolve(tenantSlug: string, feature: 'portal' | 'projects' = 'portal'): Promise<PortalTenant> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { slug: tenantSlug.toLowerCase() },
      select: { id: true, slug: true, name: true, displayName: true, status: true },
    });
    if (!tenant || tenant.status !== 'ACTIVE') throw AppException.notFound();
    const config = await this.prisma.withTenant(tenant.id, async (tx) => {
      if (!(await this.modules.isEnabled(tx, 'office'))) return null;
      return this.modules.officeConfig(tx);
    });
    if (!config || !config.publicPortalEnabled) throw AppException.notFound();
    if (feature === 'projects' && !config.publicProjectsEnabled) throw AppException.notFound();
    return { id: tenant.id, slug: tenant.slug, name: tenant.displayName ?? tenant.name, config };
  }

  /** Run `fn` in the portal tenant's RLS transaction. */
  withPortalTenant<T>(tenant: PortalTenant, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.withTenant(tenant.id, fn);
  }

  /** GET /public/:tenantSlug/portal (S24 form data and privacy notice). */
  async info(tenantSlug: string): Promise<PublicPortalInfo> {
    const tenant = await this.resolve(tenantSlug);
    const { config } = tenant;
    const geography = await this.withPortalTenant(tenant, async (tx) => {
      if (!config.portalCountyUnitId) return { constituencies: [], wards: [] };
      const constituencies = await tx.geographicUnit.findMany({
        where: { parentId: config.portalCountyUnitId, type: 'CONSTITUENCY' },
        select: { id: true, officialName: true },
        orderBy: { officialName: 'asc' },
      });
      const wards = await tx.geographicUnit.findMany({
        where: { parentId: { in: constituencies.map((c) => c.id) }, type: 'WARD' },
        select: { id: true, officialName: true, parentId: true },
        orderBy: { officialName: 'asc' },
      });
      return {
        constituencies: constituencies.map((c) => ({ id: c.id, name: c.officialName })),
        wards: wards.map((w) => ({ id: w.id, name: w.officialName, constituencyId: w.parentId! })),
      };
    });
    return {
      tenantSlug: tenant.slug,
      displayName: config.portalDisplayName,
      privacyNotice: portalPrivacyNotice({
        controllerName: config.controllerName,
        dataProtectionContact: config.dataProtectionContact,
        caseRetentionMonths: config.caseRetentionMonths,
        contactRetentionMonths: config.contactRetentionMonths,
      }),
      categories: config.portalCaseCategories.map((key) => ({ key, label: CASE_CATEGORY_LABELS[key] })),
      constituencies: geography.constituencies,
      wards: geography.wards,
      captcha: { provider: config.captchaProvider, siteKey: config.captchaSiteKey },
      honeypotField: PUBLIC_HONEYPOT_FIELD,
      maxPhotoBytes: MAX_PUBLIC_PHOTO_BYTES,
      acceptedPhotoTypes: [...PUBLIC_PHOTO_MIME_TYPES],
      projectsEnabled: config.publicProjectsEnabled,
    };
  }
}
