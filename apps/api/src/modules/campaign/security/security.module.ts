import { Module } from '@nestjs/common';
import { NotificationCenterModule } from '../notifications/notification-center.module';
import { BreachesController } from './breaches.controller';
import { BreachesService } from './breaches.service';

@Module({
  imports: [NotificationCenterModule],
  controllers: [BreachesController],
  providers: [BreachesService],
  exports: [BreachesService],
})
export class SecurityModule {}
