import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { OrgService } from './org.service';

/**
 * S05 organisation tree (docs/API_CONTRACT.md §23.1): GET /org/departments/tree, GET /org/departments/:id,
 * POST /org/departments, PATCH /org/departments/:id. org.departments.view / org.departments.manage.
 */
@RequireModule('campaign')
@Controller('org/departments')
export class DepartmentsController {
  constructor(private readonly service: OrgService) {}
}
