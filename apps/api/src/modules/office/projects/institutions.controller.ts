import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { InstitutionsService } from './institutions.service';

/** Institution registry (responsible bodies). To implement: docs/API_CONTRACT.md §12.5. */
@RequireModule('office')
@Controller('office/institutions')
export class InstitutionsController {
  constructor(private readonly institutions: InstitutionsService) {}
}
