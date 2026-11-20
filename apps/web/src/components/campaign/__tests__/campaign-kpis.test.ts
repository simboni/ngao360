/**
 * Dashboard campaign / finance tiles (presentation only; the API enforces every
 * permission and scope). Run with: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSystemRole, type PermissionKey, type SystemRoleKey } from '@ngao360/shared';
import { CAMPAIGN_KPIS, visibleCampaignKpis } from '../campaign-kpis';

function keysFor(role: SystemRoleKey, campaignOn = true): string[] {
  const set = new Set<string>(getSystemRole(role).permissions);
  return visibleCampaignKpis(campaignOn, (p: PermissionKey) => set.has(p)).map((k) => k.key);
}

describe('campaign dashboard tiles', () => {
  it('finance tiles need finance.view; operations roles never see them', () => {
    for (const k of CAMPAIGN_KPIS.filter((x) => x.group === 'finance')) assert.deepEqual(k.anyOf, ['finance.view']);
    for (const role of ['OPERATIONS_OFFICER', 'TEAM_COORDINATOR', 'COMMUNICATIONS_EDITOR'] as const) {
      assert.ok(!keysFor(role).some((k) => k.startsWith('finance_')), role);
    }
    assert.ok(keysFor('FINANCE_OFFICER').includes('finance_awaiting_approval'));
    assert.ok(keysFor('FINANCE_APPROVER').includes('finance_limit_findings'));
  });

  it('campaign tiles follow the role and the module switch', () => {
    const manager = keysFor('CAMPAIGN_MANAGER');
    assert.ok(manager.includes('tasks_overdue'));
    assert.ok(manager.includes('events_upcoming'));
    assert.ok(manager.includes('tasks_review'));
    assert.ok(keysFor('COMMUNICATIONS_APPROVER').includes('comms_awaiting_me'));
    assert.ok(!keysFor('FINANCE_OFFICER').includes('tasks_overdue'));
    assert.deepEqual(
      keysFor('CAMPAIGN_MANAGER', false).filter((k) => k !== 'alerts_awaiting_ack'),
      [],
      'campaign tiles disappear with the module off',
    );
  });
});
