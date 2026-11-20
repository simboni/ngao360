import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { OrgService } from './org.service';

/**
 * GET /org/assignable-users (docs/API_CONTRACT.md §23.3): active users (name only) for lead, coordinator,
 * owner and reviewer pickers.
 */
@RequireModule('campaign')
@Controller('org/assignable-users')
export class OrgUsersController {
  constructor(private readonly service: OrgService) {}
}
