import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { AgentsService } from './agents.service';

/**
 * Mobile PWA home (docs/API_CONTRACT.md §16.4): `GET /field/me` and
 * `POST /field/evidence` (FIELD_EVIDENCE uploads used by reports and incidents).
 */
@RequireModule('field')
@Controller('field')
export class FieldMeController {
  constructor(private readonly service: AgentsService) {}
}
