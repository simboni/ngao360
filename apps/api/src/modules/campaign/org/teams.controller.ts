import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { OrgService } from './org.service';

/**
 * Teams and members (docs/API_CONTRACT.md §23.2): list, detail, create, update, add members, remove member.
 * Management routes use { kind: CAMPAIGN_GEO_KIND.TEAM, from: 'params', key: 'id' } plus the department scope.
 */
@RequireModule('campaign')
@Controller('org/teams')
export class TeamsController {
  constructor(private readonly service: OrgService) {}
}
