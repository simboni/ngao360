import { Body, Controller, Get, HttpStatus, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Paginated, RegistryVersion } from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentAuth } from '../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../rbac/require-permission.decorator';
import { CreateRegistryVersionDto, IdParamDto, ReasonBodyDto, RegistryVersionListQueryDto } from './reference.dto';
import { RegistryImportOptionsSchema, type RegistryImportOutcome } from '@ngao360/shared';
import { RegistryService, type UploadedCsv } from './registry.service';

/** CSV uploads up to 25 MB (~55k stations is ~6 MB). */
const MAX_REGISTRY_CSV_BYTES = 25 * 1024 * 1024;

/** Station-registry versions and CSV import (docs/API_CONTRACT.md §4.3). */
@Controller('reference/registry-versions')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @RequirePermission('reference.view')
  @Get()
  list(@Query() q: RegistryVersionListQueryDto): Promise<Paginated<RegistryVersion>> {
    return this.registry.list(q);
  }

  @RequirePermission('reference.import')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateRegistryVersionDto): Promise<RegistryVersion> {
    return this.registry.create(auth.tenantId, dto);
  }

  /**
   * multipart/form-data: `file` (CSV) plus optional text fields `dryRun`,
   * `publicationDate`, `sourceUrl`, `changeNotes` (RegistryImportOptionsSchema).
   * 201 when imported, 202 when queued, 200 for a dry run.
   */
  @RequirePermission('reference.import')
  @Post(':id/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_REGISTRY_CSV_BYTES, files: 1 } }))
  async import(
    @CurrentAuth() auth: AuthContext,
    @Param() p: IdParamDto,
    @UploadedFile() file: UploadedCsv | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegistryImportOutcome> {
    const options = RegistryImportOptionsSchema.parse(body ?? {});
    const outcome = await this.registry.import(auth, p.id, file, options);
    res.status(outcome.dryRun ? HttpStatus.OK : outcome.status === 'QUEUED' ? HttpStatus.ACCEPTED : HttpStatus.CREATED);
    return outcome;
  }

  @RequirePermission('reference.view')
  @Get(':id/import-status')
  importStatus(@Param() p: IdParamDto): Promise<RegistryImportOutcome> {
    return this.registry.importStatus(p.id);
  }

  @RequirePermission('reference.approve')
  @RequireReauth()
  @Post(':id/approve')
  approve(@CurrentAuth() auth: AuthContext, @Param() p: IdParamDto, @Body() body: ReasonBodyDto): Promise<RegistryVersion> {
    return this.registry.approve(auth, p.id, body.reason);
  }
}
