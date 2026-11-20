import { Module } from '@nestjs/common';
import { CasePortalService } from './case-portal.service';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';

/** Citizen cases (S25) and their public-portal service (submission, tracking, feedback). */
@Module({
  controllers: [CasesController],
  providers: [CasesService, CasePortalService],
  exports: [CasesService, CasePortalService],
})
export class CasesModule {}
