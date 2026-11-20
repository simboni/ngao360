import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import type { StationStatusDetail, StationStatusList, WarRoomOverview } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { SetStationStatusDto, StationCodeParamDto, StationStatusParamQueryDto, StationStatusQueryDto, WarRoomQueryDto } from '../field.dto';
import { WarRoomService } from './warroom.service';

/**
 * S16 War Room (docs/API_CONTRACT.md §21): overview panels, station status list and
 * manual station status. Every response carries WAR_ROOM_LABEL and completeness;
 * missing stations are never zero. Needs both the field and tally modules.
 * Station routes are scoped by station code in the service (404 outside scope).
 */
@RequireModule('field', 'tally')
@Controller('warroom')
export class WarRoomController {
  constructor(private readonly service: WarRoomService) {}

  @Get('overview')
  @RequirePermission('warroom.view')
  overview(@CurrentAuth() auth: AuthContext, @Query() q: WarRoomQueryDto): Promise<WarRoomOverview> {
    return this.service.overview(auth, q);
  }

  @Get('stations')
  @RequirePermission('warroom.view')
  stations(@CurrentAuth() auth: AuthContext, @Query() q: StationStatusQueryDto): Promise<StationStatusList> {
    return this.service.stations(auth, q);
  }

  @Get('stations/:code')
  @RequirePermission('warroom.view')
  station(@CurrentAuth() auth: AuthContext, @Param() p: StationCodeParamDto, @Query() q: StationStatusParamQueryDto): Promise<StationStatusDetail> {
    return this.service.station(auth, p.code, q.electionCycleId);
  }

  @Put('stations/:code/status')
  @RequirePermission('warroom.command')
  @RequireReauth()
  setStatus(@CurrentAuth() auth: AuthContext, @Param() p: StationCodeParamDto, @Body() body: SetStationStatusDto): Promise<StationStatusDetail> {
    return this.service.setStatus(auth, p.code, body);
  }
}
