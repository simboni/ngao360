import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FinanceService } from './finance.service';

/**
 * S10 finance ledger (docs/API_CONTRACT.md §27.1–27.5): ledger summary, transactions (request → approve →
 * pay, reversals), documents, accounts, categories, payees, contribution sources, budget lines and the
 * audited, re-authenticated export. finance.* only; operations roles never hold it.
 */
@RequireModule('campaign')
@Controller('finance')
export class FinanceController {
  constructor(private readonly service: FinanceService) {}
}
