import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CasesService } from './cases.service';

/**
 * S25 Case workspace. To implement: docs/API_CONTRACT.md §11.
 * Record-level routes use the geo target { kind: 'officeCase', from: 'params', key: 'id' }.
 */
@RequireModule('office')
@Controller('office/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}
}
