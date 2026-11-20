import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CorrespondenceService } from './correspondence.service';

/**
 * S23 Correspondence inbox. To implement: docs/API_CONTRACT.md §9.
 * Every handler declares @RequirePermission('office.correspondence.*').
 */
@RequireModule('office')
@Controller('office/correspondence')
export class CorrespondenceController {
  constructor(private readonly correspondence: CorrespondenceService) {}
}
