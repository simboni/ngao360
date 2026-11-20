import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { Paginated, TeamDetail, TeamSummary } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CAMPAIGN_GEO_KIND } from '../campaign.constants';
import { AddTeamMembersDto, CampaignIdParamDto, CreateTeamDto, RemoveTeamMemberDto, TeamMemberParamDto, TeamQueryDto, UpdateTeamDto } from '../campaign.dto';
import { OrgService } from './org.service';

/**
 * Teams and members (docs/API_CONTRACT.md §23.2): list, detail, create, update, add members, remove member.
 * Management routes check org.teams.manage against the team's geography (or the coordinator) plus the department scope.
 */
@RequireModule('campaign')
@Controller('org/teams')
export class TeamsController {
  constructor(private readonly service: OrgService) {}

  @RequirePermission('org.teams.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: TeamQueryDto): Promise<Paginated<TeamSummary>> {
    return this.service.listTeams(auth, q);
  }

  @RequirePermission('org.teams.view')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto): Promise<TeamDetail> {
    return this.service.getTeam(auth, p.id);
  }

  @RequirePermission('org.teams.manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateTeamDto): Promise<TeamDetail> {
    return this.service.createTeam(auth, body);
  }

  @RequirePermission('org.teams.manage', { geo: { kind: CAMPAIGN_GEO_KIND.TEAM, from: 'params', key: 'id' } })
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: UpdateTeamDto): Promise<TeamDetail> {
    return this.service.updateTeam(auth, p.id, body);
  }

  /** org.teams.manage inside the team's geography, or the team's coordinator (service). */
  @RequirePermission(['org.teams.manage', 'org.teams.view'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/members')
  addMembers(@CurrentAuth() auth: AuthContext, @Param() p: CampaignIdParamDto, @Body() body: AddTeamMembersDto): Promise<TeamDetail> {
    return this.service.addMembers(auth, p.id, body);
  }

  @RequirePermission(['org.teams.manage', 'org.teams.view'], { anyOf: true })
  @HttpCode(200)
  @Post(':id/members/:memberId/remove')
  removeMember(@CurrentAuth() auth: AuthContext, @Param() p: TeamMemberParamDto, @Body() body: RemoveTeamMemberDto): Promise<TeamDetail> {
    return this.service.removeMember(auth, p.id, p.memberId, body.reason);
  }
}
