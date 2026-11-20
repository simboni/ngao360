import { Module } from '@nestjs/common';
import { ContestsService } from './contests.service';
import { ElectionCyclesService } from './election-cycles.service';
import { FormTemplatesController } from './form-templates.controller';
import { FormTemplatesService } from './form-templates.service';
import { GeographyService } from './geography.service';
import { PollingStationsService } from './polling-stations.service';
import { ReferenceController } from './reference.controller';
import { RegistryImportProcessor } from './registry-import.processor';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';
import { TallyCentresService } from './tally-centres.service';

/** Same switch as QueueModule: the worker only exists when BullMQ is registered. */
function queuesEnabled(): boolean {
  const v = process.env.QUEUES_ENABLED;
  return v === undefined || ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * REFERENCE module: election cycles, geography (county → constituency → ward →
 * polling centre → station), versioned registry imports, tally centres,
 * contests, candidate references and the form-template registry.
 * Endpoints: docs/API_CONTRACT.md §4. Prisma, audit, RBAC and storage are global.
 */
@Module({
  controllers: [ReferenceController, RegistryController, FormTemplatesController],
  providers: [
    ElectionCyclesService,
    GeographyService,
    RegistryService,
    PollingStationsService,
    TallyCentresService,
    ContestsService,
    FormTemplatesService,
    ...(queuesEnabled() ? [RegistryImportProcessor] : []),
  ],
  exports: [ElectionCyclesService, GeographyService, RegistryService, PollingStationsService, ContestsService, FormTemplatesService],
})
export class ReferenceModule {}
