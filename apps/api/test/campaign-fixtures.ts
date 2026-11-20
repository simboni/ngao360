/**
 * Shared fixture for the campaign integration suites (test/campaign-*.spec.ts,
 * finance-*, reports-*, notifications-*): two synthetic tenants with
 * Bungoma-like synthetic geography, the campaign module switched on, personas
 * with chosen permissions (optionally scoped to a constituency or ward) and an
 * HTTP client per persona.
 *
 * Requires TEST_DATABASE_URL (owner) and TEST_APP_DATABASE_URL (ngao_app).
 * All names and data are synthetic.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, sha256Hex } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

export const OWNER_URL = process.env.TEST_DATABASE_URL;
export const APP_URL = process.env.TEST_APP_DATABASE_URL;
export const describeDb = OWNER_URL && APP_URL ? describe : describe.skip;
const JWT_SECRET = 'campaign-suite-access-secret-campaign-suite-access-01';

export type UnitKey = 'county' | 'k1' | 'k2' | 'w1' | 'w2';

export interface PersonaSpec {
  perms: PermissionKey[];
  scope?: UnitKey;
  tenant?: 'main' | 'other';
  /** Recent re-authentication in the token (default true). */
  reauth?: boolean;
  roleKey?: string;
}

export interface Client {
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  put: (path: string) => request.Test;
  patch: (path: string) => request.Test;
  delete: (path: string) => request.Test;
}

export interface CampaignFixture {
  app: INestApplication;
  owner: PrismaClient;
  tenantId: string;
  otherTenantId: string;
  units: Record<UnitKey, string>;
  otherUnits: Record<UnitKey, string>;
  cycleId: string;
  users: Record<string, string>;
  roleKeys: Record<string, string>;
  http: (who: string) => Client;
  close: () => Promise<void>;
}

/** A small synthetic PDF (unique each call so files never deduplicate across tests). */
export function syntheticPdf(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic campaign test document\n'), randomBytes(48)]);
}

async function seedTenant(owner: PrismaClient, tenantId: string, slug: string, config: Record<string, unknown>) {
  await owner.tenant.create({ data: { id: tenantId, slug, name: `Synthetic Campaign ${slug}`, type: 'CAMPAIGN' } });
  const cycle = await owner.electionCycle.create({
    data: { tenantId, name: 'Synthetic 2027 cycle', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
  });
  const units = {} as Record<UnitKey, string>;
  const unit = async (key: UnitKey, type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, name: string, parent?: { id: string; path: string }) => {
    const id = randomUUID();
    const path = `${parent?.path ?? '/'}${id}/`;
    await owner.geographicUnit.create({
      data: { id, tenantId, electionCycleId: cycle.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: name, path, sourceVersion: 'synthetic-v1' },
    });
    units[key] = id;
    return { id, path };
  };
  const county = await unit('county', 'COUNTY', '039', 'Bungoma (synthetic)');
  const k1 = await unit('k1', 'CONSTITUENCY', '039-1', 'Kanduyi (synthetic)', county);
  const k2 = await unit('k2', 'CONSTITUENCY', '039-2', 'Webuye East (synthetic)', county);
  await unit('w1', 'WARD', '039-1-1', 'Township ward (synthetic)', k1);
  await unit('w2', 'WARD', '039-2-1', 'Mihuu ward (synthetic)', k2);
  await owner.tenantModule.create({ data: { tenantId, moduleKey: 'campaign', enabled: true, config: config as object } });
  return { units, cycleId: cycle.id };
}

export async function createCampaignFixture(personas: Record<string, PersonaSpec>, opts: { config?: Record<string, unknown> } = {}): Promise<CampaignFixture> {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ngao-campaign-suite-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: OWNER_URL,
    APP_DATABASE_URL: APP_URL,
    QUEUES_ENABLED: 'false',
    OFFICE_RETENTION_INTERVAL_MINUTES: '0',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: storageRoot,
    JWT_ACCESS_SECRET: JWT_SECRET,
    JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    RATE_LIMIT_MAX: '100000',
  });
  const owner = createPrismaClient({ url: OWNER_URL!, log: [] });
  for (const p of PERMISSION_DEFINITIONS) {
    await owner.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
      update: { module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
    });
  }
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const main = await seedTenant(owner, tenantId, `bungoma-campaign-${tenantId.slice(0, 8)}`, opts.config ?? {});
  const other = await seedTenant(owner, otherTenantId, `other-campaign-${otherTenantId.slice(0, 8)}`, {});

  const jwt = new JwtService();
  const users: Record<string, string> = {};
  const roleKeys: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const [name, spec] of Object.entries(personas)) {
    const t = spec.tenant === 'other' ? otherTenantId : tenantId;
    const units = spec.tenant === 'other' ? other.units : main.units;
    const key = spec.roleKey ?? `R_${name.toUpperCase()}_${randomUUID().slice(0, 6)}`;
    let role = await owner.role.findFirst({ where: { tenantId: t, key } });
    if (!role) {
      role = await owner.role.create({ data: { tenantId: t, key, name: `Synthetic ${name}`, permissions: { create: spec.perms.map((k) => ({ tenantId: t, permissionKey: k })) } } });
    }
    roleKeys[name] = key;
    const user = await owner.user.create({
      data: { tenantId: t, email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@campaign-suite.example.org`, displayName: `Synthetic ${name}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true },
    });
    const scopeId = spec.scope ? units[spec.scope] : null;
    const scopeType = !spec.scope ? 'ORGANISATION' : spec.scope === 'county' ? 'COUNTY' : spec.scope.startsWith('k') ? 'CONSTITUENCY' : 'WARD';
    await owner.roleAssignment.create({ data: { tenantId: t, userId: user.id, roleId: role.id, scopeType, geographicUnitId: scopeId, reason: 'fixture' } });
    const session = await owner.session.create({
      data: { tenantId: t, userId: user.id, refreshTokenHash: sha256Hex(randomUUID()), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    users[name] = user.id;
    tokens[name] = jwt.sign(
      { sub: user.id, tid: t, sid: session.id, mfa: true, ...(spec.reauth === false ? {} : { rat: Math.floor(Date.now() / 1000) }), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  }

  const { createApp } = await import('../src/main');
  const app = await createApp();
  await app.init();
  const agent = request(app.getHttpServer());
  const client = (token: string): Client => {
    const d = (r: request.Test) => r.set('authorization', `Bearer ${token}`).set('x-ngao-client', 'web');
    return {
      get: (p) => d(agent.get(`/api${p}`)),
      post: (p) => d(agent.post(`/api${p}`)),
      put: (p) => d(agent.put(`/api${p}`)),
      patch: (p) => d(agent.patch(`/api${p}`)),
      delete: (p) => d(agent.delete(`/api${p}`)),
    };
  };
  return {
    app,
    owner,
    tenantId,
    otherTenantId,
    units: main.units,
    otherUnits: other.units,
    cycleId: main.cycleId,
    users,
    roleKeys,
    http: (who) => {
      if (!tokens[who]) throw new Error(`Unknown persona ${who}`);
      return client(tokens[who]!);
    },
    close: async () => {
      await app.close();
      await owner.$disconnect();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Department created directly (synthetic) with an optional lead. */
export async function seedDepartment(f: CampaignFixture, code: string, name: string, opts: { leadUserId?: string; parent?: { id: string; path: string; depth: number }; tenantId?: string } = {}) {
  const id = randomUUID();
  const tenantId = opts.tenantId ?? f.tenantId;
  const creator = Object.values(f.users)[0]!;
  const path = `${opts.parent?.path ?? '/'}${id}/`;
  await f.owner.department.create({
    data: { id, tenantId, code, name, path, depth: opts.parent ? opts.parent.depth + 1 : 0, parentId: opts.parent?.id ?? null, leadUserId: opts.leadUserId ?? null, createdById: creator },
  });
  return { id, path, depth: opts.parent ? opts.parent.depth + 1 : 0 };
}

/** Poll until `fn` returns a truthy value (async notification dispatch). */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let last: T = await fn();
  while (!last && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}
