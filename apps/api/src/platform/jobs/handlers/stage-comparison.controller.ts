/**
 * "Re-run comparison": compare a verified later-stage form with the verified station aggregate
 * again, on demand (blueprint 8.6; complements the `tally.comparison_retry` job).
 * Owner: platform-infra. Module `tally`; permission `tally.discrepancy.manage` over the
 * submission's geography. Opens a CROSS_STAGE_MISMATCH case with the caller as opener when the
 * figures differ and no such case is open; nothing is overwritten.
 */
import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { AppException } from '../../../common/http/app-exception';
import { StageComparisonService } from '../../../modules/tally/services/stage-comparison.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RequirePermission } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { ModuleRef } from '@nestjs/core';
import { PlatformIdParamDto } from '../../platform.dto';

export interface StageComparisonResponse {
  submissionId: string;
  differences: number;
  /** The case opened by this run, or null (no difference, or a case is already open). */
  caseId: string | null;
}

@Controller('tally/submissions')
@RequireModule('tally')
export class StageComparisonController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Post(':id/stage-comparison')
  @HttpCode(200)
  @RequirePermission('tally.discrepancy.manage', { geo: { kind: 'submission', from: 'params', key: 'id' } })
  async rerun(@CurrentAuth() auth: AuthContext, @Param() p: PlatformIdParamDto): Promise<StageComparisonResponse> {
    const sub = await this.prisma.withTenant(auth.tenantId, (tx) =>
      tx.resultSubmission.findUnique({ where: { id: p.id }, select: { status: true, formTemplate: { select: { formLevel: true } } } }),
    );
    if (!sub) throw AppException.notFound('Submission not found');
    if (sub.status !== 'VERIFIED' || sub.formTemplate.formLevel === 'POLLING_STATION') {
      throw AppException.conflict('Only verified collation or declaration forms are compared with the station aggregate', { status: sub.status });
    }
    const r = await this.moduleRef
      .get(StageComparisonService, { strict: false })
      .compareInTenant({ tenantId: auth.tenantId, userId: auth.userId }, p.id, { trigger: 'MANUAL' });
    return { submissionId: p.id, differences: r.differences, caseId: r.caseId };
  }
}
