import { Controller, type ExecutionContext, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantModuleKey } from '@ngao360/shared';
import type { PrismaService } from '../../../prisma/prisma.service';
import { scopeFromGrants, stationLineageKey } from '../../../rbac/scope';
import { ModuleGuard } from '../../../tenant-modules/module.guard';
import { moduleDisabled, type TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { REQUIRE_MODULE_KEY } from '../../../tenant-modules/require-module.decorator';
import { agentScopeWhere, fieldGeoLocation, fieldScopeWhere } from '../common/field-location';
import { WarRoomController } from '../warroom/warroom.controller';
import { IncidentsController } from '../incidents/incidents.controller';
import { ClientSubmissionLedger } from '../common/client-submission.ledger';

const TENANT = '99999999-9999-4999-8999-999999999999';
const CYCLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WARD = '22222222-2222-4222-8222-222222222222';

@Controller('x')
class WarRoomLike {
  @Get() a() {}
}
Reflect.defineMetadata(REQUIRE_MODULE_KEY, ['field', 'tally'], WarRoomLike);

function httpCtx(cls: object, handler: (...args: unknown[]) => unknown): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ auth: { tenantId: TENANT } }), getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('field module activation', () => {
  const prisma = { withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn({}) } as unknown as PrismaService;
  const guard = (enabled: TenantModuleKey[]) =>
    new ModuleGuard(new Reflector(), prisma, {
      assertEnabled: async (_tx: unknown, key: TenantModuleKey) => {
        if (!enabled.includes(key)) throw moduleDisabled(key);
      },
    } as unknown as TenantModulesService);

  it('the War Room needs both field and tally', async () => {
    const ctx = httpCtx(WarRoomLike, WarRoomLike.prototype.a);
    await expect(guard(['field']).canActivate(ctx)).rejects.toMatchObject({ code: 'MODULE_DISABLED' });
    await expect(guard(['tally']).canActivate(ctx)).rejects.toMatchObject({ code: 'MODULE_DISABLED' });
    await expect(guard(['field', 'tally']).canActivate(ctx)).resolves.toBe(true);
  });

  it('field controllers are tagged with their tenant modules', () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, WarRoomController)).toEqual(['field', 'tally']);
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, IncidentsController)).toEqual(['field']);
  });
});

describe('field location and scope helpers', () => {
  const row = { electionCycleId: CYCLE, pollingStationCode: 'S1', countyId: 'c', constituencyId: 'k', wardId: WARD, pollingCentreId: null };

  it('builds a GeoLocation with the station lineage key and cycle', () => {
    expect(fieldGeoLocation(row)).toEqual({ unitIds: ['c', 'k', WARD], stationId: null, stationKey: stationLineageKey(CYCLE, 'S1'), electionCycleId: CYCLE });
  });

  it('ward grants filter by unit columns; cycle-limited grants add the cycle; no grant matches nothing', () => {
    const ward = scopeFromGrants([{ permission: 'field.reports.view', scopeType: 'WARD', geographicUnitId: WARD, pollingStationId: null, electionCycleId: CYCLE, expiresAt: null }], 'field.reports.view');
    expect(JSON.stringify(fieldScopeWhere(ward))).toContain(CYCLE);
    expect(JSON.stringify(fieldScopeWhere(ward))).toContain(WARD);
    expect(fieldScopeWhere(scopeFromGrants([], 'field.reports.view'))).toEqual({ id: { in: [] } });
    expect(fieldScopeWhere(scopeFromGrants([{ permission: 'field.reports.view', scopeType: 'ORGANISATION', geographicUnitId: null, pollingStationId: null, electionCycleId: null, expiresAt: null }], 'field.reports.view'))).toBeUndefined();
  });

  it('agents are filtered by home area', () => {
    const ward = scopeFromGrants([{ permission: 'field.agents.view', scopeType: 'WARD', geographicUnitId: WARD, pollingStationId: null, electionCycleId: null, expiresAt: null }], 'field.agents.view');
    expect(agentScopeWhere(ward)).toEqual({ OR: [{ homeCountyId: { in: [WARD] } }, { homeConstituencyId: { in: [WARD] } }, { homeWardId: { in: [WARD] } }] });
  });

  it('payload hashes ignore key order', () => {
    expect(ClientSubmissionLedger.payloadHash({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(ClientSubmissionLedger.payloadHash({ b: [1, { c: 3, d: 2 }], a: 1 }));
  });
});
