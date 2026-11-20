import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { ReportsModule } from '../reports/reports.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  // Sync applies items through the owning services (no duplicated domain logic).
  imports: [FieldCommonModule, ReportsModule, IncidentsModule, DeploymentModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
