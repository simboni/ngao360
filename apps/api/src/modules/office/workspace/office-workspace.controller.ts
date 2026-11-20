import { Controller, Get, Param } from '@nestjs/common';
import type { OfficeGeography, OfficePrivacyNotices, UserRef } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { OFFICE_GEO_KIND } from '../office.constants';
import { OfficeIdParamDto } from '../office.dto';
import { OfficeWorkspaceService } from './office-workspace.service';

const ANY_OFFICE_VIEW = [
  'office.cases.view',
  'office.cases.create',
  'office.projects.view',
  'office.correspondence.view',
  'office.appointments.view',
  'office.meetings.view',
] as const;

/**
 * Office form support (API contract §9a): works with the public portal switched off.
 */
@RequireModule('office')
@Controller('office')
export class OfficeWorkspaceController {
  constructor(private readonly workspace: OfficeWorkspaceService) {}

  @Get('geography')
  @RequirePermission([...ANY_OFFICE_VIEW], { anyOf: true })
  geography(): Promise<OfficeGeography> {
    return this.workspace.geography();
  }

  @Get('privacy-notice')
  @RequirePermission(['office.cases.create', 'office.appointments.manage', 'office.cases.view', 'office.appointments.view'], { anyOf: true })
  privacyNotices(): Promise<OfficePrivacyNotices> {
    return this.workspace.privacyNotices();
  }

  @Get('cases/:id/assignable-officers')
  @RequirePermission('office.cases.manage', { geo: { kind: OFFICE_GEO_KIND.CASE, from: 'params', key: 'id' } })
  assignableOfficers(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<UserRef[]> {
    return this.workspace.assignableOfficers(auth, p.id);
  }
}
