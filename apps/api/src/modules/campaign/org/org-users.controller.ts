import { Controller, Get, Query } from '@nestjs/common';
import type { AssignableUser } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { AssignableUserQueryDto } from '../campaign.dto';
import { OrgService } from './org.service';

/**
 * GET /org/assignable-users (docs/API_CONTRACT.md §23.3): active users (name only) for lead, coordinator,
 * owner and reviewer pickers, and (display names only) for the task board and event filters of viewers.
 */
@RequireModule('campaign')
@Controller('org/assignable-users')
export class OrgUsersController {
  constructor(private readonly service: OrgService) {}

  @RequirePermission(['org.departments.manage', 'org.teams.manage', 'tasks.create', 'tasks.assign', 'tasks.view', 'events.create', 'events.manage', 'events.view'], { anyOf: true })
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: AssignableUserQueryDto): Promise<AssignableUser[]> {
    return this.service.assignableUsers(auth, q);
  }
}
