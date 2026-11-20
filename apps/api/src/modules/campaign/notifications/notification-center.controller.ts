import { Controller } from '@nestjs/common';
import { NotificationCenterService } from './notification-center.service';

/**
 * Notification centre additions (docs/API_CONTRACT.md §29): counts, preferences, critical-alert
 * acknowledgement and the caller's delivery log. The list and read endpoints stay in the admin
 * DashboardController (§7) and return the extended NotificationCenterItem shape.
 */
@Controller('notifications')
export class NotificationCenterController {
  constructor(private readonly service: NotificationCenterService) {}
}
