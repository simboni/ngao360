import { Controller } from '@nestjs/common';
import { ReportBuilderService } from './report-builder.service';

/**
 * S28 report builder and standard-report catalogue (docs/API_CONTRACT.md §28): datasets, preview,
 * templates, exports and the export log. No module gate here: each dataset names its own tenant module.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportBuilderService) {}
}
