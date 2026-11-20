import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { EventsService } from './events.service';

/**
 * S09 events: list, detail, create, update, status, agenda, logistics, attendance (contact via the audited
 * endpoint), documents and the after-action report (docs/API_CONTRACT.md §25).
 */
@RequireModule('campaign')
@Controller('events')
export class EventsController {
  constructor(private readonly service: EventsService) {}
}
