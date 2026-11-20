import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ProjectsService } from './projects.service';

/**
 * S26 Project register and S27 Project detail. To implement: docs/API_CONTRACT.md §12.
 * Record-level routes use the geo target { kind: 'officeProject', from: 'params', key: 'id' }.
 */
@RequireModule('office')
@Controller('office/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}
}
