import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { DeploymentCoverage, DeploymentDetail, DeploymentSummary, Paginated, ReplaceDeploymentResult, SignedUrlResponse } from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FIELD_GEO_KIND } from '../field.constants';
import {
  BulkCreateDeploymentDto,
  CancelDeploymentDto,
  CheckInDto,
  CheckOutDto,
  ConfirmDeploymentDto,
  CreateDeploymentDto,
  DeploymentCoverageQueryDto,
  DeploymentQueryDto,
  FieldIdParamDto,
  ReplaceDeploymentDto,
  RosterExportDto,
  UpdateDeploymentDto,
} from '../field.dto';
import { type BulkDeploymentResult, DeploymentService } from './deployment.service';

const DEPLOYMENT: GeoTarget = { kind: FIELD_GEO_KIND.DEPLOYMENT, from: 'params', key: 'id' };

/**
 * S14 deployment planner and the agent's own confirmation, check-in and
 * check-out (docs/API_CONTRACT.md §17).
 */
@RequireModule('field')
@Controller('field/deployments')
export class DeploymentController {
  constructor(private readonly service: DeploymentService) {}

  @Get()
  @RequirePermission('field.deployment.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: DeploymentQueryDto): Promise<Paginated<DeploymentSummary>> {
    return this.service.list(auth, q);
  }

  @Get('coverage')
  @RequirePermission('field.deployment.view')
  coverage(@CurrentAuth() auth: AuthContext, @Query() q: DeploymentCoverageQueryDto): Promise<DeploymentCoverage> {
    return this.service.coverage(auth, q);
  }

  @Post('roster-export')
  @HttpCode(200)
  @RequirePermission('field.deployment.plan')
  @RequireReauth()
  rosterExport(@CurrentAuth() auth: AuthContext, @Body() body: RosterExportDto): Promise<SignedUrlResponse> {
    return this.service.rosterExport(auth, body);
  }

  /** Bulk assignment (proposed contract addition, docs/CHANGE_REQUESTS.md). */
  @Post('bulk')
  @HttpCode(200)
  @RequirePermission('field.deployment.plan')
  bulk(@CurrentAuth() auth: AuthContext, @Body() body: BulkCreateDeploymentDto): Promise<BulkDeploymentResult> {
    return this.service.bulkCreate(auth, body);
  }

  @Get(':id')
  @RequirePermission('field.deployment.view', { geo: DEPLOYMENT })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<DeploymentDetail> {
    return this.service.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('field.deployment.plan')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateDeploymentDto): Promise<DeploymentDetail> {
    return this.service.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('field.deployment.plan', { geo: DEPLOYMENT })
  update(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: UpdateDeploymentDto): Promise<DeploymentDetail> {
    return this.service.update(auth, p.id, body);
  }

  @Post(':id/replace')
  @HttpCode(200)
  @RequirePermission('field.deployment.plan', { geo: DEPLOYMENT })
  replace(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: ReplaceDeploymentDto): Promise<ReplaceDeploymentResult> {
    return this.service.replace(auth, p.id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('field.deployment.plan', { geo: DEPLOYMENT })
  cancel(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: CancelDeploymentDto): Promise<DeploymentDetail> {
    return this.service.cancel(auth, p.id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('field.deployment.checkin', { geo: DEPLOYMENT })
  async confirm(
    @CurrentAuth() auth: AuthContext,
    @Param() p: FieldIdParamDto,
    @Body() body: ConfirmDeploymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeploymentDetail> {
    const { replayed, result } = await this.service.confirm(auth, p.id, body);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return result;
  }

  @Post(':id/check-in')
  @HttpCode(200)
  @RequirePermission('field.deployment.checkin', { geo: DEPLOYMENT })
  async checkIn(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: CheckInDto, @Res({ passthrough: true }) res: Response): Promise<DeploymentDetail> {
    const { replayed, result } = await this.service.checkIn(auth, p.id, body);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return result;
  }

  @Post(':id/check-out')
  @HttpCode(200)
  @RequirePermission('field.deployment.checkin', { geo: DEPLOYMENT })
  checkOut(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto, @Body() body: CheckOutDto): Promise<DeploymentDetail> {
    return this.service.checkOut(auth, p.id, body);
  }
}
