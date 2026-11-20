import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { StationStatusRecorderService } from './station-status-recorder.service';
import { WarRoomController } from './warroom.controller';
import { WarRoomService } from './warroom.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [WarRoomController],
  providers: [WarRoomService, StationStatusRecorderService],
  exports: [WarRoomService, StationStatusRecorderService],
})
export class WarRoomModule {}
