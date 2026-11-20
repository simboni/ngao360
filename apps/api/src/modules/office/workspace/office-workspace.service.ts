import { Injectable } from '@nestjs/common';
import {
  type PrivacyNotice,
  type UserRef,
  appointmentPrivacyNotice,
  portalPrivacyNotice,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { scopeAllows, scopeFromGrants } from '../../../rbac/scope';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { officeGeoLocation } from '../common';

/** Office geography for forms and filters (the county the office serves). */
export interface OfficeGeography {
  county: { id: string; name: string } | null;
  constituencies: Array<{ id: string; name: string }>;
  wards: Array<{ id: string; name: string; constituencyId: string }>;
}

/** Current privacy notices with the tenant's controller, contact and retention settings. */
export interface OfficePrivacyNotices {
  portal: PrivacyNotice;
  appointment: PrivacyNotice;
}

/**
 * Small read endpoints the Office screens need regardless of the public portal
 * (proposed in docs/CHANGE_REQUESTS.md, Office): geography, privacy notices and
 * officers a case can be assigned to.
 */
@Injectable()
export class OfficeWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modules: TenantModulesService,
    private readonly permissions: PermissionService,
  ) {}

  geography(): Promise<OfficeGeography> {
    return this.prisma.tenantTx(async (tx) => {
      const config = await this.modules.officeConfig(tx);
      const county = config.portalCountyUnitId
        ? await tx.geographicUnit.findUnique({ where: { id: config.portalCountyUnitId }, select: { id: true, officialName: true } })
        : await tx.geographicUnit.findFirst({ where: { type: 'COUNTY' }, select: { id: true, officialName: true }, orderBy: { officialName: 'asc' } });
      if (!county) return { county: null, constituencies: [], wards: [] };
      const constituencies = await tx.geographicUnit.findMany({
        where: { parentId: county.id, type: 'CONSTITUENCY' },
        select: { id: true, officialName: true },
        orderBy: { officialName: 'asc' },
      });
      const wards = await tx.geographicUnit.findMany({
        where: { parentId: { in: constituencies.map((c) => c.id) }, type: 'WARD' },
        select: { id: true, officialName: true, parentId: true },
        orderBy: { officialName: 'asc' },
      });
      return {
        county: { id: county.id, name: county.officialName },
        constituencies: constituencies.map((c) => ({ id: c.id, name: c.officialName })),
        wards: wards.map((w) => ({ id: w.id, name: w.officialName, constituencyId: w.parentId! })),
      };
    });
  }

  privacyNotices(): Promise<OfficePrivacyNotices> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await this.modules.officeConfig(tx);
      const ctx = {
        controllerName: c.controllerName,
        dataProtectionContact: c.dataProtectionContact,
        caseRetentionMonths: c.caseRetentionMonths,
        contactRetentionMonths: c.contactRetentionMonths,
      };
      return { portal: portalPrivacyNotice(ctx), appointment: appointmentPrivacyNotice(ctx) };
    });
  }

  /** Active users holding office.cases.manage over the case location (the API re-checks on assign). */
  assignableOfficers(_auth: AuthContext, caseId: string): Promise<UserRef[]> {
    return this.prisma.tenantTx(async (tx) => {
      const c = await tx.citizenCase.findUnique({
        where: { id: caseId },
        select: { geographicUnitId: true, countyId: true, constituencyId: true, wardId: true },
      });
      if (!c) throw AppException.notFound('Case not found');
      const now = new Date();
      const candidates = await tx.user.findMany({
        where: {
          status: 'ACTIVE',
          roleAssignments: {
            some: {
              revokedAt: null,
              validFrom: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              role: { permissions: { some: { permissionKey: 'office.cases.manage' } } },
            },
          },
        },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
        take: 500,
      });
      const location = officeGeoLocation(c);
      const out: UserRef[] = [];
      for (const u of candidates) {
        const { grants } = await this.permissions.loadGrants(tx, u.id, now);
        if (scopeAllows(scopeFromGrants(grants, 'office.cases.manage'), location)) out.push(u);
      }
      return out;
    });
  }
}
