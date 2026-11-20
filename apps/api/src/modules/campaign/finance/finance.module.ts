import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [CampaignCommonModule],
  controllers: [FinanceController, FinanceSettingsController],
  providers: [FinanceService, FinanceSettingsService],
  exports: [FinanceService, FinanceSettingsService],
})
export class FinanceModule {}
