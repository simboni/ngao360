import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AgentAccreditation,
  type AgentDetail,
  type AgentSensitiveReveal,
  type AgentSummary,
  type AgentTraining,
  type AuditEvent,
  MAX_SOURCE_FILE_BYTES,
  type Paginated,
} from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import type { FieldUpload } from '../common/field-support';
import { FIELD_GEO_KIND } from '../field.constants';
import {
  AgentQueryDto,
  AgentStatusChangeDto,
  CreateAgentDto,
  FieldIdParamDto,
  LinkAgentUserDto,
  RecordTrainingDto,
  RevealAgentSensitiveDto,
  SetAccreditationDto,
  TrainingParamDto,
  UpdateAgentDto,
  UpdateAgentSensitiveDto,
  UpdateTrainingDto,
} from '../field.dto';
import { AgentsService } from './agents.service';

const AGENT: GeoTarget = { kind: FIELD_GEO_KIND.AGENT, from: 'params', key: 'id' };
const AGENT_PERSONAL: GeoTarget = { kind: FIELD_GEO_KIND.AGENT_PERSONAL, from: 'params', key: 'id' };

/**
 * S13 agent registry and profile (docs/API_CONTRACT.md §16): list, detail, create, update, status,
 * training, accreditation and the audited sensitive-data reveal.
 */
@RequireModule('field')
@Controller('field/agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Get()
  @RequirePermission('field.agents.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: AgentQueryDto): Promise<Paginated<AgentSummary>> {
    return this.service.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('field.agents.view', { geo: AGENT })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<AgentDetail> {
    return this.service.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('field.agents.create')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateAgentDto): Promise<AgentDetail> {
    return this.service.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('field.agents.edit', { geo: AGENT })
  update(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: UpdateAgentDto): Promise<AgentDetail> {
    return this.service.update(auth, p.id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('field.agents.edit', { geo: AGENT })
  status(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: AgentStatusChangeDto): Promise<AgentDetail> {
    return this.service.changeStatus(auth, p.id, body);
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('field.agents.reveal_sensitive', { geo: AGENT_PERSONAL })
  @RequireReauth()
  reveal(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: RevealAgentSensitiveDto): Promise<AgentSensitiveReveal> {
    return this.service.reveal(auth, p.id, body);
  }

  @Put(':id/sensitive')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('field.agents.reveal_sensitive', { geo: AGENT_PERSONAL })
  @RequireReauth()
  updateSensitive(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: UpdateAgentSensitiveDto): Promise<AgentDetail> {
    return this.service.updateSensitive(auth, p.id, body);
  }

  @Post(':id/trainings')
  @RequirePermission('field.agents.training', { geo: AGENT })
  recordTraining(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: RecordTrainingDto): Promise<AgentTraining> {
    return this.service.recordTraining(auth, p.id, body);
  }

  @Patch(':id/trainings/:trainingId')
  @RequirePermission('field.agents.training', { geo: AGENT })
  updateTraining(@CurrentAuth() auth: AuthContext, @Param() p: TrainingParamDto, @Body() body: UpdateTrainingDto): Promise<AgentTraining> {
    return this.service.updateTraining(auth, p.id, p.trainingId, body);
  }

  @Put(':id/accreditation')
  @RequirePermission('field.agents.accreditation', { geo: AGENT })
  setAccreditation(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: SetAccreditationDto): Promise<AgentAccreditation> {
    return this.service.setAccreditation(auth, p.id, body);
  }

  @Post(':id/accreditation/evidence')
  @HttpCode(200)
  @RequirePermission('field.agents.accreditation', { geo: AGENT })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1 } }))
  accreditationEvidence(
    @CurrentAuth() auth: AuthContext,
    @Param() p: FieldIdParamDto,
    @UploadedFile() file: FieldUpload | undefined,
    @Body('metadata') metadata: unknown,
  ): Promise<AgentAccreditation> {
    return this.service.accreditationEvidence(auth, p.id, metadata, file);
  }

  @Post(':id/user')
  @HttpCode(200)
  @RequirePermission('field.agents.edit', { geo: AGENT })
  linkUser(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: LinkAgentUserDto): Promise<AgentDetail> {
    return this.service.linkUser(auth, p.id, body);
  }

  @Get(':id/history')
  @RequirePermission('field.agents.view', { geo: AGENT })
  history(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<AuditEvent[]> {
    return this.service.history(auth, p.id);
  }
}
