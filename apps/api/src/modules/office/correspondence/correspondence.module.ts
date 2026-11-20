import { Module } from '@nestjs/common';
import { CorrespondenceController } from './correspondence.controller';
import { CorrespondenceService } from './correspondence.service';

/** Office correspondence (S23). Owner: correspondence/appointments agent. */
@Module({
  controllers: [CorrespondenceController],
  providers: [CorrespondenceService],
  exports: [CorrespondenceService],
})
export class CorrespondenceModule {}
