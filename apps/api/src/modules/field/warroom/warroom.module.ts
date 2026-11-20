import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { WarRoomController } from './warroom.controller';
import { WarRoomService } from './warroom.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [WarRoomController],
  providers: [WarRoomService],
  exports: [WarRoomService],
})
export class WarRoomModule {}
