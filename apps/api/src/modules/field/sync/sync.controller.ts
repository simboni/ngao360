import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { SyncResponse, SyncStatus } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { SyncRequestDto, SyncStatusQueryDto } from '../field.dto';
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

  @Post()
  @HttpCode(200)
  @RequirePermission(['field.reports.submit', 'field.incidents.report', 'field.deployment.checkin'], { anyOf: true })
  sync(@CurrentAuth() auth: AuthContext, @Body() body: SyncRequestDto): Promise<SyncResponse> {
    return this.service.sync(auth, body);
  }

  @Get('status')
  @RequirePermission(['field.reports.submit', 'field.incidents.report', 'field.deployment.checkin'], { anyOf: true })
  status(@CurrentAuth() auth: AuthContext, @Query() q: SyncStatusQueryDto): Promise<SyncStatus> {
    return this.service.status(auth, q.deviceId);
  }
}
