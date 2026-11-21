import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { AgentsController } from './agents.controller';
import { FieldMeController } from './field-me.controller';
import { AgentsService } from './agents.service';
import { AgentRetentionService } from './agent-retention.service';
import { AgentDataCrypto, AgentDataMigration } from './agent-data-crypto';

@Module({
  imports: [FieldCommonModule],
  controllers: [AgentsController, FieldMeController],
  providers: [AgentsService, AgentRetentionService, AgentDataCrypto, AgentDataMigration],
  exports: [AgentsService, AgentRetentionService, AgentDataCrypto, AgentDataMigration],
})
export class AgentsModule {}
