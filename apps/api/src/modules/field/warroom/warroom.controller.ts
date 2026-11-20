import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { WarRoomService } from './warroom.service';

/**
 * S16 War Room (docs/API_CONTRACT.md §21): overview panels, station status list and
 * manual station status. Every response carries WAR_ROOM_LABEL and completeness;
 * missing stations are never zero. Needs both the field and tally modules.
 */
@RequireModule('field', 'tally')
@Controller('warroom')
export class WarRoomController {
  constructor(private readonly service: WarRoomService) {}
}
