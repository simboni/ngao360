import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { DepartmentsController } from './departments.controller';
import { OrgUsersController } from './org-users.controller';
import { OrgService } from './org.service';
import { TeamsController } from './teams.controller';

@Module({
  imports: [CampaignCommonModule],
  controllers: [DepartmentsController, TeamsController, OrgUsersController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
