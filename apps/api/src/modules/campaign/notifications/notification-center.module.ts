import { Module } from '@nestjs/common';
import { NotificationCenterController } from './notification-center.controller';
import { NotificationCenterService } from './notification-center.service';
import { defaultChannelProviders, NOTIFICATION_CHANNEL_PROVIDERS } from './providers/notification-provider';

@Module({
  controllers: [NotificationCenterController],
  providers: [NotificationCenterService, { provide: NOTIFICATION_CHANNEL_PROVIDERS, useFactory: defaultChannelProviders }],
  exports: [NotificationCenterService],
})
export class NotificationCenterModule {}
