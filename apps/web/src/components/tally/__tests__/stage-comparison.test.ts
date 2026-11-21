/**
 * "Re-run comparison" button rules (PI8): enabled only where the API would accept it.
 * Run with the other tally tests: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stageComparisonBlock } from '../stage-comparison-model';

describe('stage comparison re-run', () => {
  const base = { status: 'VERIFIED', formLevel: 'CONSTITUENCY', allowedActions: ['FLAG_DISCREPANCY'] } as const;

  it('is available to a case manager on a verified collation form', () => {
    assert.equal(stageComparisonBlock({ ...base, allowedActions: [...base.allowedActions] }), null);
  });

  it('explains why it is disabled otherwise', () => {
    assert.match(stageComparisonBlock({ ...base, allowedActions: [] }) ?? '', /permission to manage discrepancy cases/);
    assert.match(stageComparisonBlock({ ...base, status: 'SECOND_REVIEW_PENDING', allowedActions: ['FLAG_DISCREPANCY'] }) ?? '', /Only a verified form/);
    assert.match(stageComparisonBlock({ ...base, formLevel: 'POLLING_STATION', allowedActions: ['FLAG_DISCREPANCY'] }) ?? '', /Polling-station forms/);
  });
});
