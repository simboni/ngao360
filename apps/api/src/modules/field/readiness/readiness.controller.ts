import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { GenerateReadinessResult, Paginated, ReadinessChecklist, ReadinessSummary } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { type GeoTarget, RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { FIELD_GEO_KIND } from '../field.constants';
import { FieldIdParamDto, GenerateReadinessDto, ReadinessItemParamDto, ReadinessQueryDto, UpdateReadinessItemDto } from '../field.dto';
import { ReadinessService } from './readiness.service';

const CHECKLIST: GeoTarget = { kind: FIELD_GEO_KIND.READINESS_CHECKLIST, from: 'params', key: 'id' };

/** S15 election readiness (docs/API_CONTRACT.md §18). */
@RequireModule('field')
@Controller('field/readiness')
export class ReadinessController {
  constructor(private readonly service: ReadinessService) {}

  @Get('summary')
  @RequirePermission('field.readiness.view')
  summary(@CurrentAuth() auth: AuthContext, @Query() q: ReadinessQueryDto): Promise<ReadinessSummary> {
    return this.service.summary(auth, q);
  }

  @Get()
  @RequirePermission('field.readiness.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ReadinessQueryDto): Promise<Paginated<ReadinessChecklist>> {
    return this.service.list(auth, q);
  }

  @Post('generate')
  @HttpCode(200)
  @RequirePermission('field.readiness.update')
  generate(@CurrentAuth() auth: AuthContext, @Body() body: GenerateReadinessDto): Promise<GenerateReadinessResult> {
    return this.service.generate(auth, body);
  }

  @Get(':id')
  @RequirePermission('field.readiness.view', { geo: CHECKLIST })
  get(@CurrentAuth() auth: AuthContext, @Param() p: FieldIdParamDto): Promise<ReadinessChecklist> {
    return this.service.detail(auth, p.id);
  }

  @Patch(':id/items/:itemId')
  @RequirePermission('field.readiness.update', { geo: CHECKLIST })
  updateItem(@CurrentAuth() auth: AuthContext, @Param() p: ReadinessItemParamDto, @Body() body: UpdateReadinessItemDto): Promise<ReadinessChecklist> {
    return this.service.updateItem(auth, p.id, p.itemId, body);
  }
}
