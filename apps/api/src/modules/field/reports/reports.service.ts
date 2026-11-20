import { Injectable } from '@nestjs/common';

/**
 * Field reports answer one template version. Submitted content is immutable (DB trigger);
 * review is accept / return / escalate / close, never by the author. Submissions go through
 * ClientSubmissionLedger so an online submit and an offline replay are recorded once.
 */
@Injectable()
export class ReportsService {}
