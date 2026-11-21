'use client';

import type { SubmissionDetail } from '@ngao360/shared';
import { GitCompareArrows } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useTallyActions } from './action-provider';
import { describeError } from './errors';
import { Notice } from './notice';
import { stageComparisonBlock } from './stage-comparison-model';
import { type StageComparisonResult, tallyApi } from './tally-api';

/**
 * Cross-stage comparison (blueprint 8.6): a verified collation or declaration form is compared
 * with the verified station aggregate automatically after verification, and retried by a durable
 * job if that fails. A supervisor can run it again on demand; a difference opens a
 * CROSS_STAGE_MISMATCH case unless one is already open. Nothing is overwritten.
 */
export function StageComparisonPanel({ detail }: { detail: SubmissionDetail }) {
  const { run } = useTallyActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(StageComparisonResult & { openCaseId: string | null }) | null>(null);
  if (detail.formLevel === 'POLLING_STATION') return null;
  const blocked = stageComparisonBlock(detail);

  const rerun = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await run(() => tallyApi.rerunStageComparison(detail.id));
      let openCaseId = r.caseId;
      if (!openCaseId && r.differences > 0) {
        // A case was already open: link to it.
        const open = await tallyApi.discrepancies({ submissionId: detail.id, varianceType: 'CROSS_STAGE_MISMATCH', sort: 'createdAt', order: 'desc', pageSize: 1 });
        openCaseId = open.items[0]?.id ?? null;
      }
      setResult({ ...r, openCaseId });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Comparison with station forms"
        description="Compares this form's figures with the sum of verified station forms for the same area. Differences open a case; nothing is overwritten."
      />
      <CardBody className="space-y-3">
        <Button size="sm" variant="secondary" onClick={() => void rerun()} loading={busy} disabled={blocked !== null} aria-describedby="rerun-comparison-note">
          <GitCompareArrows className="h-4 w-4" aria-hidden /> Re-run comparison
        </Button>
        <p id="rerun-comparison-note" className="text-meta text-slate">
          {blocked ?? 'Runs automatically after verification and is retried if it fails. Use this after station forms were verified or corrected. Recorded in the audit log.'}
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {result ? (
          result.differences === 0 ? (
            <Notice tone="success" title="No differences">
              The figures match the verified station forms counted so far.
            </Notice>
          ) : (
            <Notice tone="warning" title={`${result.differences} figure(s) differ`}>
              {result.caseId ? 'A cross-stage case was opened for review.' : 'A cross-stage case is already open for this form; no second case was opened.'}{' '}
              {result.openCaseId ? (
                <Link className="text-deep-blue underline" href={`/tally/discrepancies/${result.openCaseId}`}>
                  Open the case
                </Link>
              ) : null}
            </Notice>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
