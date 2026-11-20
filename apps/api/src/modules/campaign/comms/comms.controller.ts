import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { CommsService } from './comms.service';

/**
 * Communications content workflow (docs/API_CONTRACT.md §26): draft → editorial review → approval →
 * publication → archive, corrections and withdrawal. No recipient lists, no bulk sending.
 */
@RequireModule('campaign')
@Controller('comms/content')
export class CommsController {
  constructor(private readonly service: CommsService) {}
}
