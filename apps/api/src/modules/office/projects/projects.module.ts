import { Module } from '@nestjs/common';
import { InstitutionsController } from './institutions.controller';
import { InstitutionsService } from './institutions.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/** Projects (S26/S27) and the institution registry. Owner: projects agent. */
@Module({
  controllers: [ProjectsController, InstitutionsController],
  providers: [ProjectsService, InstitutionsService],
  exports: [ProjectsService, InstitutionsService],
})
export class ProjectsModule {}
