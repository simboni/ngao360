/**
 * Field and War Room navigation gating (presentation only; the API enforces
 * every permission and module). Run with: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSystemRole, hasModuleAccess, PERMISSION_MODULE_TENANT_MODULES, type PermissionKey, type PermissionModule, WAR_ROOM_LABEL } from '@ngao360/shared';
import { visibleNav } from '../../../lib/nav';
import { visibleMobileNav } from '../mobile/mobile-nav';

function navFor(perms: readonly PermissionKey[], modules: string[]) {
  const set = new Set<string>(perms);
  const can = (p: PermissionKey) => set.has(p);
  const canAccessModule = (m: PermissionModule) =>
    hasModuleAccess(set, m) && (PERMISSION_MODULE_TENANT_MODULES[m] ?? []).every((k) => modules.includes(k));
  return visibleNav(can, canAccessModule);
}

describe('field navigation', () => {
  const commander = getSystemRole('WAR_ROOM_COMMANDER').permissions;

  it('shows Field operations and the War Room only when the modules are on', () => {
    const on = navFor(commander, ['tally', 'field']).map((g) => g.label);
    assert.ok(on.includes('Field operations'));
    assert.ok(on.includes('Election day'));
    const noTally = navFor(commander, ['field']).map((g) => g.label);
    assert.ok(noTally.includes('Field operations'));
    assert.ok(!noTally.includes('Election day'), 'War Room needs the tally module too');
    const off = navFor(commander, ['tally']).map((g) => g.label);
    assert.ok(!off.includes('Field operations'));
    assert.ok(!off.includes('Election day'));
  });

  it('a planner sees deployment but not incidents or the War Room', () => {
    const items = navFor(getSystemRole('DEPLOYMENT_PLANNER').permissions, ['tally', 'field']).flatMap((g) => g.items.map((i) => i.href));
    assert.ok(items.includes('/field/deployment'));
    assert.ok(!items.includes('/field/incidents'));
    assert.ok(!items.includes('/warroom'));
  });

  it('a field agent gets the mobile app only, and result forms only with NGAO TALLY', () => {
    const agent = new Set<string>(getSystemRole('POLLING_AGENT').permissions);
    const can = (p: PermissionKey) => agent.has(p);
    const withTally = visibleMobileNav(can, () => true).map((i) => i.href);
    assert.deepEqual(withTally, ['/m', '/m/report', '/m/incident', '/m/checkin', '/m/forms']);
    assert.ok(!visibleMobileNav(can, () => false).some((i) => i.href === '/m/forms'));
    const desktop = navFor(getSystemRole('POLLING_AGENT').permissions, ['tally', 'field']).flatMap((g) => g.items.map((i) => i.href));
    assert.ok(desktop.includes('/m'));
    assert.ok(!desktop.includes('/field/agents'));
  });

  it('War Room wording is unofficial and internal', () => {
    assert.match(WAR_ROOM_LABEL, /Unofficial, internal/);
    assert.doesNotMatch(WAR_ROOM_LABEL, /winner|elected|declared/i);
  });
});
