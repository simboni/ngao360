import { Body, Controller, HttpCode, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_PUBLIC_PHOTO_BYTES,
  type PublicCaseReceipt,
  type PublicCaseStatus,
  PublicCaseSubmissionSchema,
} from '@ngao360/shared';
import type { Request } from 'express';
import { Public } from '../../../common/decorators/auth.decorators';
import { CasePortalService } from '../cases/case-portal.service';
import { type OfficeUpload, parseJsonField } from '../common';
import { PublicCitizenFeedbackDto, PublicTenantParamDto, PublicTrackRequestDto } from '../office.dto';
import { PublicAbuseService } from './public-abuse.service';
import { PublicPortalService } from './public-portal.service';
import { PublicRateLimit, PublicRateLimitGuard } from './public-rate-limit';

/**
 * Public case submission, tracking and citizen feedback (S24; API contract
 * §13.2–13.3). No account. Per-IP rate limits, honeypot/captcha hook, strict
 * multipart size limits. Responses carry no internal notes, staff names,
 * contact details or other requesters' data.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('public/:tenantSlug')
export class PublicCasesController {
  constructor(
    private readonly portal: PublicPortalService,
    private readonly abuse: PublicAbuseService,
    private readonly cases: CasePortalService,
  ) {}

  @Post('requests')
  @PublicRateLimit('submit')
  @UseInterceptors(
    FileInterceptor('photo', {
      // One optional photo plus the JSON payload; anything bigger or extra is refused by the parser.
      limits: { fileSize: MAX_PUBLIC_PHOTO_BYTES, files: 1, fields: 4, fieldSize: 32 * 1024, parts: 6 },
    }),
  )
  async submit(
    @Param() p: PublicTenantParamDto,
    @UploadedFile() photo: OfficeUpload | undefined,
    @Body('payload') payload: unknown,
    @Req() req: Request,
  ): Promise<PublicCaseReceipt> {
    const tenant = await this.portal.resolve(p.tenantSlug);
    const dto = parseJsonField(payload, PublicCaseSubmissionSchema, 'payload');
    await this.abuse.check(dto, tenant.config, req.ip ?? null);
    return this.cases.submitParsed(tenant, dto, photo);
  }

  /** POST so the tracking code never appears in URLs or access logs. */
  @Post('track')
  @HttpCode(200)
  @PublicRateLimit('track')
  async track(@Param() p: PublicTenantParamDto, @Body() body: PublicTrackRequestDto, @Req() req: Request): Promise<PublicCaseStatus> {
    const tenant = await this.portal.resolve(p.tenantSlug);
    await this.abuse.check(body, tenant.config, req.ip ?? null);
    return this.cases.track(tenant, body);
  }

  @Post('track/feedback')
  @HttpCode(200)
  @PublicRateLimit('submit')
  async feedback(@Param() p: PublicTenantParamDto, @Body() body: PublicCitizenFeedbackDto, @Req() req: Request): Promise<PublicCaseStatus> {
    const tenant = await this.portal.resolve(p.tenantSlug);
    await this.abuse.check(body, tenant.config, req.ip ?? null);
    return this.cases.feedback(tenant, body);
  }
}
