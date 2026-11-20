import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionGrant, PermissionKey } from '@ngao360/shared';
import type { AuthContext } from '../auth/auth.types';
import { AuthenticatedOnly, AllowWithoutMfa, Public } from '../common/decorators/auth.decorators';
import { AppException } from '../common/http/app-exception';
import type { AppConfig } from '../config/app-config';
import type { PrismaService } from '../prisma/prisma.service';
import { GeoScopeService } from './geo-scope.service';
import { RbacGuard } from './rbac.guard';
import { RequirePermission, RequireReauth } from './require-permission.decorator';
import { stationScopeWhere, scopeFromGrants } from './scope';

const COUNTY = '11111111-1111-4111-8111-111111111111';
const CONST_NORTH = '22222222-2222-4222-8222-222222222222';
const CONST_SOUTH = '33333333-3333-4333-8333-333333333333';
const STATION_N = '44444444-4444-4444-8444-444444444444';
const STATION_S = '55555555-5555-4555-8555-555555555555';

class TestController {
  @Public() open() {}
  noPolicy() {}
  @AuthenticatedOnly() me() {}
  @RequirePermission('tally.view') view() {}
  @RequirePermission(['tally.verify', 'tally.approve']) both() {}
  @RequirePermission(['tally.verify', 'tally.approve'], { anyOf: true }) either() {}
  @RequirePermission('tally.verify', { geo: { kind: 'pollingStation', from: 'params', key: 'stationId' } })
  verifyStation() {}
  @RequirePermission('users.reset_mfa') @RequireReauth() resetMfa() {}
  @AuthenticatedOnly() @AllowWithoutMfa() enrol() {}
}

function grant(permission: PermissionKey, scope: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    permission,
    scopeType: 'ORGANISATION',
    geographicUnitId: null,
    pollingStationId: null,
    electionCycleId: null,
    expiresAt: null,
    ...scope,
  };
}

function auth(grants: PermissionGrant[], extra: Partial<AuthContext> = {}): AuthContext {
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
    ...extra,
  };
}

function ctx(handler: keyof TestController, a?: AuthContext, params: Record<string, string> = {}): ExecutionContext {
  const req = { auth: a, params, query: {}, body: {} };
  return {
    getType: () => 'http',
    getHandler: () => TestController.prototype[handler],
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RbacGuard', () => {
  const geo = new GeoScopeService();
  // Stub DB: station geography lookups resolved from a fixed map.
  geo.register('pollingStation', async (_tx, id) =>
    id === STATION_N
      ? { unitIds: [COUNTY, CONST_NORTH], stationId: STATION_N }
      : id === STATION_S
        ? { unitIds: [COUNTY, CONST_SOUTH], stationId: STATION_S }
        : null,
  );
  const prisma = { withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn({}) } as unknown as PrismaService;
  const config = { values: { REAUTH_WINDOW_SECONDS: 600 } } as AppConfig;
  const guard = new RbacGuard(new Reflector(), geo, prisma, config);

  const expectCode = async (p: Promise<boolean>, code: string) => {
    await expect(p).rejects.toBeInstanceOf(AppException);
    await p.catch((e: AppException) => expect(e.code).toBe(code));
  };

  it('allows @Public without auth', async () => {
    await expect(guard.canActivate(ctx('open'))).resolves.toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    await expectCode(guard.canActivate(ctx('view')), 'UNAUTHENTICATED');
  });

  it('denies handlers with no declared policy (deny by default)', async () => {
    await expectCode(guard.canActivate(ctx('noPolicy', auth([grant('tally.view')]))), 'FORBIDDEN');
  });

  it('allows @AuthenticatedOnly for any signed-in user', async () => {
    await expect(guard.canActivate(ctx('me', auth([])))).resolves.toBe(true);
  });

  it('requires the declared permission', async () => {
    await expect(guard.canActivate(ctx('view', auth([grant('tally.view')])))).resolves.toBe(true);
    await expectCode(guard.canActivate(ctx('view', auth([grant('dashboard.view')]))), 'FORBIDDEN');
  });

  it('supports AND and anyOf requirements', async () => {
    const a = auth([grant('tally.verify')]);
    await expectCode(guard.canActivate(ctx('both', a)), 'FORBIDDEN');
    await expect(guard.canActivate(ctx('either', a))).resolves.toBe(true);
  });

  it('enforces MFA for privileged users unless the route allows otherwise', async () => {
    const a = auth([grant('tally.view')], { mfaRequired: true, mfaVerified: false });
    await expectCode(guard.canActivate(ctx('view', a)), 'MFA_REQUIRED');
    await expect(guard.canActivate(ctx('enrol', a))).resolves.toBe(true);
  });

  describe('geography scope', () => {
    it('org-wide grant passes for any station', async () => {
      const a = auth([grant('tally.verify')]);
      await expect(guard.canActivate(ctx('verifyStation', a, { stationId: STATION_S }))).resolves.toBe(true);
    });

    it('constituency grant passes inside and fails outside its area', async () => {
      const a = auth([grant('tally.verify', { scopeType: 'CONSTITUENCY', geographicUnitId: CONST_NORTH })]);
      await expect(guard.canActivate(ctx('verifyStation', a, { stationId: STATION_N }))).resolves.toBe(true);
      await expectCode(guard.canActivate(ctx('verifyStation', a, { stationId: STATION_S })), 'OUT_OF_SCOPE');
    });

    it('station grant only covers that station', async () => {
      const a = auth([grant('tally.verify', { scopeType: 'POLLING_STATION', pollingStationId: STATION_N })]);
      await expect(guard.canActivate(ctx('verifyStation', a, { stationId: STATION_N }))).resolves.toBe(true);
      await expectCode(guard.canActivate(ctx('verifyStation', a, { stationId: STATION_S })), 'OUT_OF_SCOPE');
    });

    it('returns NOT_FOUND for unknown targets and OUT_OF_SCOPE when the id is missing', async () => {
      const a = auth([grant('tally.verify', { scopeType: 'COUNTY', geographicUnitId: COUNTY })]);
      await expectCode(guard.canActivate(ctx('verifyStation', a, { stationId: 'nope' })), 'NOT_FOUND');
      await expectCode(guard.canActivate(ctx('verifyStation', a, {})), 'OUT_OF_SCOPE');
    });

    it('builds list filters from grants', () => {
      const scope = scopeFromGrants(
        [grant('tally.view', { scopeType: 'WARD', geographicUnitId: CONST_NORTH })],
        'tally.view',
      );
      expect(scope.orgWide).toBe(false);
      expect(stationScopeWhere(scope)?.OR).toContainEqual({ wardId: { in: [CONST_NORTH] } });
      expect(stationScopeWhere(scopeFromGrants([grant('tally.view')], 'tally.view'))).toBeUndefined();
    });
  });

  it('requires recent re-authentication for @RequireReauth routes', async () => {
    const g = [grant('users.reset_mfa')];
    await expectCode(guard.canActivate(ctx('resetMfa', auth(g))), 'REAUTH_REQUIRED');
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expectCode(guard.canActivate(ctx('resetMfa', auth(g, { reauthAt: stale }))), 'REAUTH_REQUIRED');
    const fresh = Math.floor(Date.now() / 1000) - 10;
    await expect(guard.canActivate(ctx('resetMfa', auth(g, { reauthAt: fresh })))).resolves.toBe(true);
  });
});
