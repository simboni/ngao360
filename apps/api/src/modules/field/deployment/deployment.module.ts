import { Module } from '@nestjs/common';
import { FieldCommonModule } from '../common/field-common.module';
import { DeploymentController } from './deployment.controller';
import { DeploymentService } from './deployment.service';

@Module({
  imports: [FieldCommonModule],
  controllers: [DeploymentController],
  providers: [DeploymentService],
  exports: [DeploymentService],
})
export class DeploymentModule {}
