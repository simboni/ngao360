import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { NotificationCenterModule } from '../notifications/notification-center.module';
import { TasksModule } from '../tasks/tasks.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [CampaignCommonModule, NotificationCenterModule, TasksModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
