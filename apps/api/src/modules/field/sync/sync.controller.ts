import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { SyncService } from './sync.service';

/**
 * Offline sync (docs/API_CONTRACT.md §22): `POST /field/sync` applies a batch of queued
 * items (each independent) through ClientSubmissionLedger; `GET /field/sync/status`
 * lists what the server recorded for a device (conflicts to review).
 */
@RequireModule('field')
@Controller('field/sync')
export class SyncController {
  constructor(private readonly service: SyncService) {}
}
