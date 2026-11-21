import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type DisplayHoldSummary, MAX_SOURCE_FILE_BYTES, type Paginated, type SignedUrlResponse } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ConfirmDeclaredRedactionDto, DisplayHoldQueryDto, HoldIdParamDto } from '../dto';
import { DisplayHoldsHttpService } from '../services/display-holds-http.service';
import type { UploadedSourceFile } from '../services/submissions.service';

/**
 * Display holds and redacted copies over HTTP (API contract §35), alongside `pnpm demo:redact-34a`.
 * Geography and election cycle come from the linked submission and are checked in the service
 * for the permission in play. The original is never served while held and never altered; releases
 * refuse the uploader and the declarer (separation of duties) and need a fresh re-authentication.
 */
@Controller('tally/sources/holds')
@RequireModule('tally')
export class DisplayHoldsController {
  constructor(private readonly holds: DisplayHoldsHttpService) {}

  @Get()
  @RequirePermission('tally.source.download')
  list(@CurrentAuth() auth: AuthContext, @Query() q: DisplayHoldQueryDto): Promise<Paginated<DisplayHoldSummary>> {
    return this.holds.list(auth, q);
  }

  @Get(':holdId')
  @RequirePermission('tally.source.download')
  get(@CurrentAuth() auth: AuthContext, @Param() p: HoldIdParamDto): Promise<DisplayHoldSummary> {
    return this.holds.get(auth, p.holdId);
  }

  @Get(':holdId/redacted/url')
  @RequirePermission('tally.source.download')
  redactedUrl(@CurrentAuth() auth: AuthContext, @Param() p: HoldIdParamDto): Promise<SignedUrlResponse> {
    return this.holds.redactedUrl(auth, p.holdId);
  }

  @Post(':holdId/redacted-copy')
  @HttpCode(200)
  @RequirePermission('tally.approve')
  @RequireReauth()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1 } }))
  attach(
    @CurrentAuth() auth: AuthContext,
    @Param() p: HoldIdParamDto,
    @UploadedFile() file: UploadedSourceFile | undefined,
    @Body('reason') reason: unknown,
  ): Promise<DisplayHoldSummary> {
    return this.holds.attach(auth, p.holdId, file, typeof reason === 'string' ? reason : undefined);
  }

  @Post(':holdId/confirm')
  @HttpCode(200)
  @RequirePermission('tally.approve')
  @RequireReauth()
  confirm(@CurrentAuth() auth: AuthContext, @Param() p: HoldIdParamDto, @Body() body: ConfirmDeclaredRedactionDto): Promise<DisplayHoldSummary> {
    return this.holds.confirm(auth, p.holdId, body.reason);
  }
}
