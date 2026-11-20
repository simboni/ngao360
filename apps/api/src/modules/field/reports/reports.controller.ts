import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ReportsService } from './reports.service';

/**
 * S11 field reports and report templates (docs/API_CONTRACT.md §19).
 * Record routes use { kind: FIELD_GEO_KIND.FIELD_REPORT, from: 'params', key: 'id' }.
 * Templates are served by a second controller at `field/report-templates`.
 */
@RequireModule('field')
@Controller('field/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}
}
