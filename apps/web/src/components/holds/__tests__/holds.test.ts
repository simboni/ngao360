/** Display-hold release rules shown before the API enforces them. Run with: pnpm --filter @ngao360/web test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DisplayHoldSummary } from '@ngao360/shared';
import { releaseBlock } from '../holds-model';

const hold = (over: Partial<DisplayHoldSummary> = {}): DisplayHoldSummary => ({
  id: '00000000-0000-4000-8000-000000000001',
  storedFileId: '00000000-0000-4000-8000-000000000002',
  submissionId: null,
  submissionReference: 'SUB-2022-000001',
  pollingStationCode: '039001001',
  state: 'AWAITING_REDACTION',
  reason: 'Real result-form scan',
  createdBy: { id: 'declarer', displayName: 'Declarer' },
  createdAt: '2026-11-21T08:00:00Z',
  redactedBy: null,
  redactedAt: null,
  redactedSha256: null,
  dataLabel: null,
  ...over,
});

describe('display holds', () => {
  it('the person who declared or placed a hold cannot release it', () => {
    assert.match(releaseBlock(hold({ state: 'DECLARED_REDACTED' }), 'declarer', true)!, /different person/);
    assert.match(releaseBlock(hold(), 'declarer', true)!, /different person/);
  });

  it('a second person with tally.approve may release; others may not', () => {
    assert.equal(releaseBlock(hold({ state: 'DECLARED_REDACTED' }), 'reviewer', true), null);
    assert.match(releaseBlock(hold(), 'reviewer', false)!, /tally\.approve/);
  });

  it('a released hold never changes again', () => {
    assert.match(releaseBlock(hold({ state: 'REDACTED_COPY_ATTACHED' }), 'reviewer', true)!, /only once/);
  });
});
