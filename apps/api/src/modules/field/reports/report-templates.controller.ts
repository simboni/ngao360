import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ReportsService } from './reports.service';

/**
 * Field report templates (docs/API_CONTRACT.md §19.1): versioned schema JSON,
 * DRAFT → ACTIVE by someone other than the creator, ACTIVE → RETIRED.
 */
@RequireModule('field')
@Controller('field/report-templates')
export class ReportTemplatesController {
  constructor(private readonly service: ReportsService) {}
}
