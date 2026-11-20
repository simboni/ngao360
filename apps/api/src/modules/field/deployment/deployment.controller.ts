import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { DeploymentService } from './deployment.service';

/**
 * S14 deployment planner (docs/API_CONTRACT.md §17): list, coverage grid, create, update,
 * replace, cancel, and the agent's own confirm / check-in / check-out.
 * Record routes use { kind: FIELD_GEO_KIND.DEPLOYMENT, from: 'params', key: 'id' }.
 */
@RequireModule('field')
@Controller('field/deployments')
export class DeploymentController {
  constructor(private readonly service: DeploymentService) {}
}
