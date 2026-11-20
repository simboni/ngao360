import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { ReportsController } from './reports.controller';
import { ReportTemplatesController } from './report-templates.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [ReportsController, ReportTemplatesController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
