import { Injectable, Logger } from '@nestjs/common';
import type { AuthContext } from '../../../auth/auth.types';
import { PrismaService } from '../../../prisma/prisma.service';
import { compareStages } from '../domain/stage-comparison';
import { ResultsService } from './results.service';
import { TallyWorkflowService } from './tally-workflow.service';

/**
 * Compares a verified collation/declaration form (e.g. 37B, 37C) with the
 * verified station-level aggregate for the same area and opens a
 * CROSS_STAGE_MISMATCH variance case with both source records when they
 * differ (blueprint 8.5, 8.6). Nothing is overwritten.
 */
@Injectable()
export class StageComparisonService {
  private readonly logger = new Logger(StageComparisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly results: ResultsService,
    private readonly workflow: TallyWorkflowService,
  ) {}

  async compareSubmission(auth: AuthContext, submissionId: string): Promise<{ caseId: string | null; differences: number }> {
    return this.prisma.tenantTx(async (tx) => {
      const sub = await tx.resultSubmission.findUnique({
        where: { id: submissionId },
        select: {
          id: true,
          reference: true,
          status: true,
          isCanonical: true,
          electionCycleId: true,
          contestId: true,
          formNumber: true,
          tallyCentre: { select: { geographicUnitId: true, name: true } },
          values: { select: { fieldKey: true, candidateReferenceId: true, numericValue: true } },
        },
      });
      if (!sub || !sub.tallyCentre?.geographicUnitId || sub.status !== 'VERIFIED') return { caseId: null, differences: 0 };

      const c = await this.results.compute(tx, {
        electionCycleId: sub.electionCycleId,
        contestId: sub.contestId,
        geographicUnitId: sub.tallyCentre.geographicUnitId,
      });
      const a = c.aggregate;
      const cmp = compareStages({
        aggregateByCandidate: new Map(a.candidates.map((x) => [x.candidateReferenceId, x.verifiedVotes] as const)),
        aggregateTotalValid: a.totalVerifiedValidVotes,
        collationValues: sub.values,
        includedStations: a.includedStationCount,
        expectedStations: a.coverage.expectedStations,
      });
      if (cmp.differences.length === 0) return { caseId: null, differences: 0 };
      if (await this.workflow.findOpenCase(tx, sub.id, 'CROSS_STAGE_MISMATCH')) {
        return { caseId: null, differences: cmp.differences.length };
      }
      const created = await this.workflow.openCase(tx, {
        tenantId: auth.tenantId,
        electionCycleId: sub.electionCycleId,
        contestId: sub.contestId,
        varianceType: 'CROSS_STAGE_MISMATCH',
        severity: cmp.completeCoverage ? 'HIGH' : 'LOW',
        title: `Form ${sub.formNumber} (${sub.tallyCentre.name}) differs from verified ${c.stationFormNumber} records`,
        description: cmp.completeCoverage
          ? `All ${cmp.expectedStations} expected stations are verified, and ${cmp.differences.length} figure(s) on ${sub.reference} differ from their sum. Review both source records; nothing has been overwritten.`
          : `${cmp.includedStations} of ${cmp.expectedStations} expected stations are verified, so some difference is expected until coverage is complete. ${cmp.differences.length} figure(s) on ${sub.reference} differ. Nothing has been overwritten.`,
        details: {
          collationSubmissionId: sub.id,
          stationFormNumber: c.stationFormNumber,
          comparison: cmp.differences,
          includedStations: cmp.includedStations,
          expectedStations: cmp.expectedStations,
          completeCoverage: cmp.completeCoverage,
          calculationVersion: a.calculationVersion,
        },
        links: [
          { submissionId: sub.id, role: 'SOURCE_B' },
          ...a.includedSubmissionIds.map((id) => ({ submissionId: id, role: 'SOURCE_A' as const })),
        ],
        openedById: auth.userId,
      });
      this.logger.log(`Cross-stage variance case ${created.reference} opened for ${sub.reference}`);
      return { caseId: created.id, differences: cmp.differences.length };
    });
  }
}
