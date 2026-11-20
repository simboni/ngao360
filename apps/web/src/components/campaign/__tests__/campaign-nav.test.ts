/**
 * Campaign navigation gating (presentation only; the API enforces every
 * permission and module). Run with: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSystemRole, hasModuleAccess, PERMISSION_MODULE_TENANT_MODULES, type PermissionKey, type PermissionModule, type SystemRoleKey } from '@ngao360/shared';
import { visibleNav } from '../../../lib/nav';

function hrefsFor(role: SystemRoleKey, modules: string[]): string[] {
  const set = new Set<string>(getSystemRole(role).permissions);
  const can = (p: PermissionKey) => set.has(p);
  const canAccessModule = (m: PermissionModule) =>
    hasModuleAccess(set, m) && (PERMISSION_MODULE_TENANT_MODULES[m] ?? []).every((k) => modules.includes(k));
  return visibleNav(can, canAccessModule).flatMap((g) => g.items.map((i) => i.href));
}

describe('campaign navigation', () => {
  it('campaign screens appear only with the campaign module on', () => {
    const on = hrefsFor('CAMPAIGN_MANAGER', ['tally', 'campaign']);
    for (const h of ['/tasks', '/events', '/comms', '/finance', '/org', '/reports', '/notifications']) assert.ok(on.includes(h), h);
    const off = hrefsFor('CAMPAIGN_MANAGER', ['tally']);
    for (const h of ['/tasks', '/events', '/comms', '/finance', '/org']) assert.ok(!off.includes(h), h);
    assert.ok(off.includes('/reports'), 'reports are a platform feature (datasets carry their own module gates)');
  });

  it('operations roles never see finance', () => {
    for (const role of ['OPERATIONS_OFFICER', 'OPERATIONS_DIRECTOR', 'TEAM_COORDINATOR'] as const) {
      const items = hrefsFor(role, ['tally', 'campaign', 'field']);
      assert.ok(!items.includes('/finance'), role);
      assert.ok(!items.includes('/finance/settings'), role);
    }
  });

  it('finance approver gets the ledger and settings; the officer gets the ledger only', () => {
    assert.ok(hrefsFor('FINANCE_APPROVER', ['campaign']).includes('/finance/settings'));
    const officer = hrefsFor('FINANCE_OFFICER', ['campaign']);
    assert.ok(officer.includes('/finance'));
    assert.ok(!officer.includes('/finance/settings'));
    assert.ok(!officer.includes('/tasks'));
  });

  it('the breach register is for the data protection officer, not campaign staff', () => {
    assert.ok(hrefsFor('DATA_PROTECTION_OFFICER', []).includes('/security/breaches'));
    assert.ok(!hrefsFor('CAMPAIGN_MANAGER', ['campaign']).includes('/security/breaches'));
  });
});
