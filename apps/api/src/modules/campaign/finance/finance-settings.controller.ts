import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FinanceSettingsService } from './finance-settings.service';

/**
 * Finance limit settings (docs/API_CONTRACT.md §27.6): single-source cap, spending limits and reporting
 * deadlines with effective dates, legal source note, verified flag and enforcement. finance.settings.manage + re-auth.
 */
@RequireModule('campaign')
@Controller('finance/settings')
export class FinanceSettingsController {
  constructor(private readonly service: FinanceSettingsService) {}
}
