import { Module, type OnModuleInit } from '@nestjs/common';
import { GeoScopeService } from '../../rbac/geo-scope.service';
import { DisplayHoldsController } from './controllers/display-holds.controller';
import { SubmissionsController } from './controllers/submissions.controller';
import {
  DiscrepanciesController,
  ExportsController,
  ResultsController,
  SnapshotsController,
  VerificationsController,
} from './controllers/tally.controllers';
import { createOcrProvider, OCR_PROVIDER } from './ocr/ocr-provider';
import { TallyOcrService } from './ocr/ocr.service';
import { CaptureService } from './services/capture.service';
import { DiscrepancyService } from './services/discrepancy.service';
import { DisplayHoldsHttpService } from './services/display-holds-http.service';
import { DisplayHoldsService } from './services/display-holds.service';
import { ExportsService } from './services/exports.service';
import { ResultsService } from './services/results.service';
import { StageComparisonService } from './services/stage-comparison.service';
import { SubmissionsService } from './services/submissions.service';
import { TallyWorkflowService } from './services/tally-workflow.service';
import { ValidationService } from './services/validation.service';
import { VerificationService } from './services/verification.service';

/**
 * NGAO TALLY: independent parallel record-keeping and verification
 * (blueprint section 8; API contract §5). Submissions keep their original file
 * immutably; values are captured by people with full change history; a second,
 * different person verifies; only verified canonical records enter the
 * internal aggregate; snapshots are immutable; exports carry the non-official
 * disclaimer. It never labels an outcome official, and never uses
 * winner/elected/declared language.
 */
@Module({
  controllers: [
    SubmissionsController,
    VerificationsController,
    DiscrepanciesController,
    ResultsController,
    SnapshotsController,
    ExportsController,
    DisplayHoldsController,
  ],
  providers: [
    { provide: OCR_PROVIDER, useFactory: () => createOcrProvider() },
    TallyWorkflowService,
    ValidationService,
    TallyOcrService,
    DisplayHoldsService,
    DisplayHoldsHttpService,
    SubmissionsService,
    CaptureService,
    ResultsService,
    StageComparisonService,
    VerificationService,
    DiscrepancyService,
    ExportsService,
  ],
  exports: [TallyOcrService, ResultsService, DisplayHoldsService],
})
export class TallyModule implements OnModuleInit {
  constructor(
    private readonly geo: GeoScopeService,
    private readonly workflow: TallyWorkflowService,
  ) {}

  onModuleInit(): void {
    this.geo.register('submission', (tx, id) => this.workflow.submissionLocation(tx, id));
    this.geo.register('discrepancy', (tx, id) => this.workflow.caseLocation(tx, id));
  }
}
