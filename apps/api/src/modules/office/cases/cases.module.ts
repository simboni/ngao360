import { Module } from '@nestjs/common';
import { CasePortalService } from './case-portal.service';
import { CaseRetentionService } from './case-retention.service';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';

/** Citizen cases (S25), their public-portal service (submission, tracking, feedback) and the retention job. */
@Module({
  controllers: [CasesController],
  providers: [CasesService, CasePortalService, CaseRetentionService],
  exports: [CasesService, CasePortalService, CaseRetentionService],
})
export class CasesModule {}
