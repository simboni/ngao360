/**
 * Unit tests for the Office foundation: module guard, location and scope
 * helpers, public references, the public rate limiter and the abuse check.
 */
import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_REFERENCE_PATTERN } from '@ngao360/shared';
import { Public } from '../../../common/decorators/auth.decorators';
import type { AppConfig } from '../../../config/app-config';
import { scopeFromGrants } from '../../../rbac/scope';
import { ModuleGuard } from '../../../tenant-modules/module.guard';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { moduleDisabled, type TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { officeGeoLocation, officeScopeWhere } from '../common/office-location';
import { hashTrackingCode, publicReferencePrefix, trackingCodeMatches } from '../common/public-reference';
import { PublicAbuseService } from '../public/public-abuse.service';
import { MemoryRateLimitStore } from '../../../platform/ratelimit';
import { PublicRateLimit, PublicRateLimitGuard } from '../public/public-rate-limit';

@RequireModule('office')
@Controller('x')
class OfficeOnly {
  @Get() a() {}
  @Public() @Get('p') b() {}
}
class Untagged {
  a() {}
}
class Limited {
  @PublicRateLimit('submit') submit() {}
}

function httpCtx(cls: object, handler: (...args: unknown[]) => unknown, req: Record<string, unknown>, res: Record<string, unknown> = {}): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('ModuleGuard', () => {
  const prisma = { withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn({}) } as unknown as PrismaService;
  const make = (enabled: boolean) =>
    new ModuleGuard(new Reflector(), prisma, {
      assertEnabled: async () => {
        if (!enabled) throw moduleDisabled('office');
      },
    } as unknown as TenantModulesService);
  const req = { auth: { tenantId: TENANT } };

  it('refuses tagged handlers when the module is off', async () => {
    await expect(make(false).canActivate(httpCtx(OfficeOnly, OfficeOnly.prototype.a, req))).rejects.toMatchObject({ code: 'MODULE_DISABLED' });
  });
  it('allows tagged handlers when the module is on, and untagged or public handlers always', async () => {
    await expect(make(true).canActivate(httpCtx(OfficeOnly, OfficeOnly.prototype.a, req))).resolves.toBe(true);
    await expect(make(false).canActivate(httpCtx(Untagged, Untagged.prototype.a, req))).resolves.toBe(true);
    await expect(make(false).canActivate(httpCtx(OfficeOnly, OfficeOnly.prototype.b, {}))).resolves.toBe(true);
  });
});

describe('office location and scope helpers', () => {
  const grant = (scopeType: 'ORGANISATION' | 'CONSTITUENCY', unit: string | null) => ({
    permission: 'office.cases.view' as const,
    scopeType,
    geographicUnitId: unit,
    pollingStationId: null,
    electionCycleId: null,
    expiresAt: null,
  });
  it('org-wide scope needs no filter; geographic scope filters by county/constituency/ward', () => {
    expect(officeScopeWhere(scopeFromGrants([grant('ORGANISATION', null)], 'office.cases.view'))).toBeUndefined();
    expect(officeScopeWhere(scopeFromGrants([grant('CONSTITUENCY', 'k1')], 'office.cases.view'))).toEqual({
      OR: [{ countyId: { in: ['k1'] } }, { constituencyId: { in: ['k1'] } }, { wardId: { in: ['k1'] } }],
    });
  });
  it('builds a cycle-free geo location from the denormalised columns', () => {
    expect(officeGeoLocation({ geographicUnitId: 'w', countyId: 'c', constituencyId: 'k', wardId: 'w' })).toEqual({
      unitIds: ['c', 'k', 'w'],
      stationId: null,
    });
  });
});

describe('public references', () => {
  it('derives a prefix from the tenant slug', () => {
    expect(publicReferencePrefix('bungoma-governor')).toBe('BG');
    expect(publicReferencePrefix('x')).toBe('REQ');
    expect('BG-7K3F-9Q2X').toMatch(PUBLIC_REFERENCE_PATTERN);
  });
  it('compares tracking codes by hash, case-insensitively', () => {
    const h = hashTrackingCode('ab12cd34');
    expect(trackingCodeMatches('AB12CD34', h)).toBe(true);
    expect(trackingCodeMatches('AB12CD35', h)).toBe(false);
    expect(trackingCodeMatches('AB12CD34', null)).toBe(false);
  });
});

describe('PublicRateLimitGuard', () => {
  const config = {
    values: { PUBLIC_RATE_LIMIT_WINDOW_SECONDS: 60, PUBLIC_SUBMIT_RATE_LIMIT_MAX: 2, PUBLIC_TRACK_RATE_LIMIT_MAX: 5, PUBLIC_READ_RATE_LIMIT_MAX: 100 },
  } as unknown as AppConfig;
  it('limits per IP, tenant and bucket with a Retry-After header', async () => {
    const guard = new PublicRateLimitGuard(new Reflector(), config, new MemoryRateLimitStore());
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    const call = (ip: string, slug = 'bungoma-governor') =>
      guard.canActivate(httpCtx(Limited, Limited.prototype.submit, { ip, params: { tenantSlug: slug } }, res));
    expect(await call('10.0.0.1')).toBe(true);
    expect(await call('10.0.0.1')).toBe(true);
    await expect(call('10.0.0.1')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(headers['Retry-After']).toBeDefined();
    expect(await call('10.0.0.2')).toBe(true);
    expect(await call('10.0.0.1', 'other-office')).toBe(true);
  });

  it('refuses (503) instead of letting traffic through when the store is down', async () => {
    const down = { kind: 'redis' as const, hit: async () => Promise.reject(new Error('ECONNREFUSED')), peek: async () => null, reset: async () => undefined };
    const guard = new PublicRateLimitGuard(new Reflector(), config, down);
    const res = { setHeader: () => undefined };
    await expect(guard.canActivate(httpCtx(Limited, Limited.prototype.submit, { ip: '10.0.0.9', params: { tenantSlug: 'x' } }, res))).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 503 });
  });
});

describe('PublicAbuseService', () => {
  it('rejects a filled honeypot with a generic error', async () => {
    const svc = new PublicAbuseService();
    await expect(svc.check({ website: 'http://spam.example' }, { captchaProvider: 'none' }, null)).rejects.toMatchObject({ code: 'ABUSE_CHECK_FAILED' });
    await expect(svc.check({ website: '' }, { captchaProvider: 'none' }, null)).resolves.toBeUndefined();
  });
  it('fails closed when a captcha provider is configured without a verifier', async () => {
    await expect(new PublicAbuseService().check({ captchaToken: 't' }, { captchaProvider: 'turnstile' }, null)).rejects.toMatchObject({ code: 'ABUSE_CHECK_FAILED' });
    const ok = new PublicAbuseService({ verify: async () => true });
    await expect(ok.check({ captchaToken: 't' }, { captchaProvider: 'turnstile' }, '10.0.0.1')).resolves.toBeUndefined();
    await expect(ok.check({}, { captchaProvider: 'turnstile' }, null)).rejects.toMatchObject({ code: 'ABUSE_CHECK_FAILED' });
  });
});
