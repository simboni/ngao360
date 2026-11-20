import { Module } from '@nestjs/common';

/**
 * NGAO TALLY module (owned by the tally module agent; edit only within
 * apps/api/src/modules/tally/).
 *
 * Scope: submissions (upload + immutable original via StorageService), capture
 * (ResultValue + ResultValueChange history), validation engine (form-template
 * rules), two-person verification with separation of duties, discrepancy cases,
 * immutable snapshots, exports with disclaimer. Endpoints: docs/API_CONTRACT.md §5.
 *
 * Register geo resolvers (e.g. 'submission') with GeoScopeService in onModuleInit.
 * Enqueue OCR with OcrQueueService (stub). Never use winner/elected/declared language.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class TallyModule {}
