import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { TasksService } from './tasks.service';

/**
 * S08 task board / list / calendar / workload and task detail (docs/API_CONTRACT.md §24).
 * Visibility: department scope (loadCampaignScope + taskScopeWhere / campaignRecordInScope, 404 outside it).
 */
@RequireModule('campaign')
@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}
}
