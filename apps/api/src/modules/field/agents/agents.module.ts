import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { AgentsController } from './agents.controller';
import { FieldMeController } from './field-me.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [AgentsController, FieldMeController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
