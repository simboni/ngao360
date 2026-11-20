import { Module } from '@nestjs/common';
import { ClientSubmissionLedger } from './client-submission.ledger';

/** Shared field providers (idempotency ledger). Location and scope helpers are plain functions in ./field-location. */
@Module({
  providers: [ClientSubmissionLedger],
  exports: [ClientSubmissionLedger],
})
export class FieldCommonModule {}
