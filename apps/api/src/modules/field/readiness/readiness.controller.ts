import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ReadinessService } from './readiness.service';

/**
 * S15 election readiness (docs/API_CONTRACT.md §18): summary cards, checklists, generation
 * and item updates. Record routes use { kind: FIELD_GEO_KIND.READINESS_CHECKLIST, from: 'params', key: 'id' }.
 */
@RequireModule('field')
@Controller('field/readiness')
export class ReadinessController {
  constructor(private readonly service: ReadinessService) {}
}
