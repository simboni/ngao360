import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { AgentsService } from './agents.service';

/**
 * S13 agent registry and profile (docs/API_CONTRACT.md §16): list, detail, create, update, status,
 * training, accreditation, the audited sensitive-data reveal and the mobile `GET /field/me`.
 * Record routes use { kind: FIELD_GEO_KIND.AGENT, from: 'params', key: 'id' }.
 */
@RequireModule('field')
@Controller('field/agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}
}
