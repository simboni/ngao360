import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [CampaignCommonModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
