import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [CampaignCommonModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
