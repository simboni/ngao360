import type { PermissionGrant, PermissionKey } from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { assertGrantorCovers } from '../modules/admin/access-policy';
import { submissionScopeWhere } from '../modules/tally/services/scope-where';
import { geographyOf, scopeAllows, scopeFromGrants, stationScopeWhere } from './scope';

const COUNTY = '11111111-1111-4111-8111-111111111111';
const WARD_X = '22222222-2222-4222-8222-222222222222';
const WARD_Y = '33333333-3333-4333-8333-333333333333';
const CYCLE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CYCLE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function grant(permission: PermissionKey, scope: Partial<PermissionGrant> = {}): PermissionGrant {
  return { permission, scopeType: 'ORGANISATION', geographicUnitId: null, pollingStationId: null, electionCycleId: null, expiresAt: null, ...scope };
}

function auth(grants: PermissionGrant[]): AuthContext {
  return {
    userId: 'u1',
    tenantId: '99999999-9999-4999-8999-999999999999',
    sessionId: 's1',
    email: 'u@example.org',
    displayName: 'U',
    mfaVerified: true,
    mfaRequired: false,
    reauthAt: null,
    roles: [],
    permissions: new Set(grants.map((g) => g.permission)),
    grants,
  };
}

describe('election-cycle scoped grants', () => {
  const grants = [grant('tally.capture', { scopeType: 'WARD', geographicUnitId: WARD_X, electionCycleId: CYCLE_A })];

  it('apply only to records of their cycle', () => {
    const scope = scopeFromGrants(grants, 'tally.capture');
    expect(scope.held).toBe(true);
    expect(scopeAllows(scope, { unitIds: [COUNTY, WARD_X], stationId: null, electionCycleId: CYCLE_A })).toBe(true);
    expect(scopeAllows(scope, { unitIds: [COUNTY, WARD_X], stationId: null, electionCycleId: CYCLE_B })).toBe(false);
    expect(scopeAllows(scope, { unitIds: [COUNTY, WARD_Y], stationId: null, electionCycleId: CYCLE_A })).toBe(false);
  });

  it('flatten for one cycle and never count for "every cycle"', () => {
    expect(scopeFromGrants(grants, 'tally.capture', CYCLE_A).unitIds).toEqual([WARD_X]);
    expect(scopeFromGrants(grants, 'tally.capture', CYCLE_B).unitIds).toEqual([]);
    expect(scopeFromGrants(grants, 'tally.capture', null).unitIds).toEqual([]);
  });

  it('an org-wide grant limited to one cycle is not org-wide for list filters', () => {
    const s = scopeFromGrants([grant('tally.view', { electionCycleId: CYCLE_A })], 'tally.view');
    expect(s.orgWide).toBe(false);
    expect(submissionScopeWhere(s)).toEqual({ OR: [{ electionCycleId: CYCLE_A }] });
  });

  it('cycle-limited submission filters combine geography with the cycle', () => {
    const where = submissionScopeWhere(scopeFromGrants(grants, 'tally.capture'));
    expect(where).toEqual({
      OR: [{ AND: [{ electionCycleId: CYCLE_A }, { OR: [{ geographicUnit: { path: { contains: `/${WARD_X}/` } } }] }] }],
    });
  });

  it('count geographically for records that do not belong to a cycle (reference data)', () => {
    const s = scopeFromGrants(grants, 'tally.capture');
    expect(scopeAllows(s, { unitIds: [COUNTY, WARD_X], stationId: null })).toBe(true);
    expect(geographyOf(s).unitIds).toEqual([WARD_X]);
    expect(stationScopeWhere(s)?.OR).toContainEqual({ wardId: { in: [WARD_X] } });
  });
});

describe('grantor scope (roles.assign)', () => {
  const countyAdmin = auth([
    grant('roles.assign', { scopeType: 'COUNTY', geographicUnitId: COUNTY }),
    grant('tally.view', { scopeType: 'COUNTY', geographicUnitId: COUNTY }),
  ]);

  it('a county-scoped administrator cannot grant organisation-wide roles', () => {
    expect(() => assertGrantorCovers(countyAdmin, null, null, ['tally.view'])).toThrow(/organisation-wide/);
  });

  it('a county-scoped administrator cannot grant outside the county', () => {
    expect(() => assertGrantorCovers(countyAdmin, { unitIds: ['other-county', WARD_Y], stationId: null }, null, ['tally.view'])).toThrow(
      /outside the geography/,
    );
  });

  it('a county-scoped administrator can only hand out permissions they hold there', () => {
    const inCounty = { unitIds: [COUNTY, WARD_X], stationId: null };
    expect(() => assertGrantorCovers(countyAdmin, inCounty, null, ['tally.view'])).not.toThrow();
    expect(() => assertGrantorCovers(countyAdmin, inCounty, null, ['tally.view', 'tally.approve', 'roles.configure'])).toThrow(
      /permissions you hold yourself/,
    );
  });

  it('a cycle-limited roles.assign cannot grant for every cycle', () => {
    const a = auth([grant('roles.assign', { electionCycleId: CYCLE_A })]);
    expect(() => assertGrantorCovers(a, null, null, ['tally.view'])).toThrow();
    expect(() => assertGrantorCovers(a, null, CYCLE_A, ['tally.view'])).not.toThrow();
  });

  it('an organisation-wide administrator can grant anywhere', () => {
    const owner = auth([grant('roles.assign')]);
    expect(() => assertGrantorCovers(owner, null, null, ['tally.approve'])).not.toThrow();
  });
});
