import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [ReadinessController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class ReadinessModule {}
