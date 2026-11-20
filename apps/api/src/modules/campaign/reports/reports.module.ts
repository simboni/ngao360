import { Module } from '@nestjs/common';
import { CampaignCommonModule } from '../common/campaign-common.module';
import { ReportBuilderService } from './report-builder.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [CampaignCommonModule],
  controllers: [ReportsController],
  providers: [ReportBuilderService],
  exports: [ReportBuilderService],
})
export class CampaignReportsModule {}
