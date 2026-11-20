import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { AuditEvent, IncidentDetail, IncidentEvent, IncidentSubject, IncidentSummary, Paginated, SignedUrlResponse } from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FIELD_GEO_KIND } from '../field.constants';
import {
  AddIncidentEventDto,
  AssignIncidentDto,
  AttachEvidenceDto,
  CloseIncidentDto,
  CreateIncidentDto,
  DownloadQueryDto,
  EscalateIncidentDto,
  FieldIdParamDto,
  FileParamDto,
  IncidentQueryDto,
  RecordIncidentSubjectDto,
  ReopenIncidentDto,
  ResolveIncidentDto,
  TriageIncidentDto,
} from '../field.dto';
import { IncidentsService } from './incidents.service';

const INCIDENT: GeoTarget = { kind: FIELD_GEO_KIND.INCIDENT, from: 'params', key: 'id' };

/**
 * S17 incident intake and the incident desk (docs/API_CONTRACT.md §20;
 * blueprint 7.3 workflow). Reporters read their own incidents; the desk is
 * limited to its geography.
 */
@RequireModule('field')
@Controller('field/incidents')
export class IncidentsController {
  constructor(private readonly service: IncidentsService) {}

  @Get()
  @RequirePermission(['field.incidents.view', 'field.incidents.report'], { anyOf: true })
  list(@CurrentAuth() auth: AuthContext, @Query() q: IncidentQueryDto): Promise<Paginated<IncidentSummary>> {
    return this.service.list(auth, q);
  }

  /** field.incidents.view in scope, or the reporter (checked in the service). */
  @Get(':id')
  @RequirePermission(['field.incidents.view', 'field.incidents.report'], { anyOf: true })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<IncidentDetail> {
    return this.service.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('field.incidents.report')
  async report(@CurrentAuth() auth: AuthContext, @Body() body: CreateIncidentDto, @Res({ passthrough: true }) res: Response): Promise<IncidentDetail> {
    const { replayed, result } = await this.service.report(auth, body);
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result;
  }

  @Post(':id/triage')
  @HttpCode(200)
  @RequirePermission('field.incidents.triage', { geo: INCIDENT })
  triage(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: TriageIncidentDto): Promise<IncidentDetail> {
    return this.service.triage(auth, p.id, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('field.incidents.assign', { geo: INCIDENT })
  assign(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: AssignIncidentDto): Promise<IncidentDetail> {
    return this.service.assign(auth, p.id, body);
  }

  @Post(':id/escalate')
  @HttpCode(200)
  @RequirePermission('field.incidents.escalate', { geo: INCIDENT })
  escalate(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: EscalateIncidentDto): Promise<IncidentDetail> {
    return this.service.escalate(auth, p.id, body);
  }

  /** Triage (geo) for notes; escalate for referrals and holds; the reporter for a CORRECTION (checked in the service). */
  @Post(':id/events')
  @RequirePermission(['field.incidents.triage', 'field.incidents.escalate', 'field.incidents.report'], { anyOf: true })
  addEvent(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: AddIncidentEventDto): Promise<IncidentEvent> {
    return this.service.addEvent(auth, p.id, body);
  }

  @Post(':id/evidence')
  @HttpCode(200)
  @RequirePermission(['field.incidents.triage', 'field.incidents.report'], { anyOf: true })
  addEvidence(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: AttachEvidenceDto): Promise<IncidentDetail> {
    return this.service.addEvidence(auth, p.id, body);
  }

  @Get(':id/evidence/:fileId/url')
  @RequirePermission('field.incidents.view', { geo: INCIDENT })
  evidenceUrl(@CurrentAuth() auth: AuthContext, @Param() p: FileParamDto, @Query() q: DownloadQueryDto): Promise<SignedUrlResponse> {
    return this.service.evidenceUrl(auth, p.id, p.fileId, q.download as unknown as boolean);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission('field.incidents.resolve', { geo: INCIDENT })
  resolve(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: ResolveIncidentDto): Promise<IncidentDetail> {
    return this.service.resolve(auth, p.id, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('field.incidents.close', { geo: INCIDENT })
  close(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: CloseIncidentDto): Promise<IncidentDetail> {
    return this.service.close(auth, p.id, body);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('field.incidents.close', { geo: INCIDENT })
  reopen(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: ReopenIncidentDto): Promise<IncidentDetail> {
    return this.service.reopen(auth, p.id, body);
  }

  @Get(':id/subject')
  @RequirePermission('field.incidents.view_subject', { geo: INCIDENT })
  subjects(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<IncidentSubject[]> {
    return this.service.subjects(auth, p.id);
  }

  @Post(':id/subject')
  @RequirePermission('field.incidents.view_subject', { geo: INCIDENT })
  @RequireReauth()
  recordSubject(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: RecordIncidentSubjectDto): Promise<IncidentSubject> {
    return this.service.recordSubject(auth, p.id, body);
  }

  @Get(':id/history')
  @RequirePermission('field.incidents.view', { geo: INCIDENT })
  history(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<AuditEvent[]> {
    return this.service.history(auth, p.id);
  }
}
