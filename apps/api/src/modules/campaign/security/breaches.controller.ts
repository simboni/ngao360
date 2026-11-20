import { Controller } from '@nestjs/common';
import { BreachesService } from './breaches.service';

/**
 * Data breach register (docs/API_CONTRACT.md §30): list, detail, record, update, timeline entries
 * (detect → contain → preserve → assess → notify → remediate → close) and the re-authenticated timeline export.
 */
@Controller('security/breaches')
export class BreachesController {
  constructor(private readonly service: BreachesService) {}
}
