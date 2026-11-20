import { Controller, Get, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type FieldEvidenceUpload, type FieldMe, MAX_SOURCE_FILE_BYTES } from '@ngao360/shared';
import type { Response } from 'express';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import type { FieldUpload } from '../common/field-support';
import { AgentsService } from './agents.service';

/**
 * Mobile PWA home (docs/API_CONTRACT.md §16.4): `GET /field/me` and
 * `POST /field/evidence` (FIELD_EVIDENCE uploads used by reports and incidents).
 */
@RequireModule('field')
@Controller('field')
export class FieldMeController {
  constructor(private readonly service: AgentsService) {}

  @Get('me')
  @RequirePermission(['field.reports.submit', 'field.incidents.report', 'field.deployment.checkin'], { anyOf: true })
  me(@CurrentAuth() auth: AuthContext): Promise<FieldMe> {
    return this.service.me(auth);
  }

  @Post('evidence')
  @RequirePermission(['field.reports.submit', 'field.incidents.report', 'field.incidents.triage'], { anyOf: true })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1 } }))
  async evidence(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: FieldUpload | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FieldEvidenceUpload> {
    const result = await this.service.uploadEvidence(auth, file);
    res.status(result.duplicate ? 200 : 201);
    return result;
  }
}
