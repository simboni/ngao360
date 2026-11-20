import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { IncidentsService } from './incidents.service';

/**
 * S17 incident intake and the incident desk (docs/API_CONTRACT.md §20).
 * Record routes use { kind: FIELD_GEO_KIND.INCIDENT, from: 'params', key: 'id' }.
 */
@RequireModule('field')
@Controller('field/incidents')
export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}
}
