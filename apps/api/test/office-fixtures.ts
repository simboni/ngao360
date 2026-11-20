/**
 * Shared fixture for the Office integration suites (test/office-*.spec.ts):
 * two synthetic tenants with Bungoma-like synthetic geography, the office
 * module switched on, personas with chosen permissions (optionally scoped to a
 * ward or constituency) and an HTTP client per persona.
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
import { crc32, deflateSync } from 'node:zlib';
import request from 'supertest';

export const OWNER_URL = process.env.TEST_DATABASE_URL;
export const APP_URL = process.env.TEST_APP_DATABASE_URL;
export const describeDb = OWNER_URL && APP_URL ? describe : describe.skip;
const JWT_SECRET = 'office-suite-access-secret-office-suite-access-secret-01';

export type UnitKey = 'county' | 'k1' | 'k2' | 'w1' | 'w2' | 'w3';

export interface PersonaSpec {
  perms: PermissionKey[];
  /** Scope the grant to one unit (default: organisation-wide). */
  scope?: UnitKey;
  /** Which tenant the persona belongs to (default 'main'). */
  tenant?: 'main' | 'other';
  /** Include a recent re-authentication in the token (default true). */
  reauth?: boolean;
}

export interface OfficeFixture {
  app: INestApplication;
  owner: PrismaClient;
  tenantId: string;
  slug: string;
  otherTenantId: string;
  otherSlug: string;
  units: Record<UnitKey, string>;
  otherUnits: Record<UnitKey, string>;
  users: Record<string, string>;
  portalServiceUserId: string;
  /** Local storage root of this fixture's API (stored originals live under it). */
  storageRoot: string;
  http: (who: string) => Client;
  /** Unauthenticated client presenting a given client IP (X-Forwarded-For; trust proxy is 1). */
  pub: (ip: string) => Client;
  close: () => Promise<void>;
}

export interface Client {
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  put: (path: string) => request.Test;
  patch: (path: string) => request.Test;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A small, decodable synthetic PNG with random pixels (unique each call, so
 * files never deduplicate across tests). `textChunk` adds a tEXt chunk, used to
 * check that metadata is stripped.
 */
export function syntheticPng(textChunk?: string): Buffer {
  const w = 8;
  const h = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(w * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(textChunk ? [pngChunk('tEXt', Buffer.from(`Comment\0${textChunk}`, 'latin1'))] : []),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** A small synthetic PDF. */
export function syntheticPdf(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic office test document\n'), randomBytes(48)]);
}

async function seedPermissions(owner: PrismaClient): Promise<void> {
  for (const p of PERMISSION_DEFINITIONS) {
    await owner.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
      update: { module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
    });
  }
}

async function seedTenant(owner: PrismaClient, tenantId: string, slug: string, opts: { officeEnabled: boolean; config: Record<string, unknown> }) {
  await owner.tenant.create({ data: { id: tenantId, slug, name: `Synthetic Governor Office ${slug}`, type: 'ELECTED_OFFICE' } });
  const cycle = await owner.electionCycle.create({
    data: { tenantId, name: 'Administrative geography (synthetic)', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
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
  await unit('w3', 'WARD', '039-1-2', 'Musikoma ward (synthetic)', k1);
  const svc = await owner.user.create({
    data: { tenantId, email: `portal-service@${slug}.invalid`, displayName: 'Public portal (service account)', status: 'DEACTIVATED', passwordHash: null },
  });
  await owner.tenantModule.create({
    data: {
      tenantId,
      moduleKey: 'office',
      enabled: opts.officeEnabled,
      config: {
        publicPortalEnabled: true,
        publicProjectsEnabled: true,
        portalDisplayName: 'Office of the Governor (synthetic)',
        controllerName: 'Office of the Governor (synthetic)',
        dataProtectionContact: 'dpo@office.example.org',
        portalCountyUnitId: units.county,
        portalServiceUserId: svc.id,
        ...opts.config,
      },
    },
  });
  return { units, portalServiceUserId: svc.id };
}

export async function createOfficeFixture(
  personas: Record<string, PersonaSpec>,
  opts: { config?: Record<string, unknown>; otherOfficeEnabled?: boolean } = {},
): Promise<OfficeFixture> {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ngao-office-suite-'));
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
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    RATE_LIMIT_MAX: '100000',
  });
  const owner = createPrismaClient({ url: OWNER_URL!, log: [] });
  await seedPermissions(owner);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `bungoma-gov-${tenantId.slice(0, 8)}`;
  const otherSlug = `other-gov-${otherTenantId.slice(0, 8)}`;
  const main = await seedTenant(owner, tenantId, slug, { officeEnabled: true, config: opts.config ?? {} });
  const other = await seedTenant(owner, otherTenantId, otherSlug, { officeEnabled: opts.otherOfficeEnabled ?? true, config: {} });

  const jwt = new JwtService();
  const users: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const [name, spec] of Object.entries(personas)) {
    const t = spec.tenant === 'other' ? otherTenantId : tenantId;
    const units = spec.tenant === 'other' ? other.units : main.units;
    const role = await owner.role.create({
      data: { tenantId: t, key: `R_${name.toUpperCase()}_${randomUUID().slice(0, 6)}`, name: `Synthetic ${name}`, permissions: { create: spec.perms.map((k) => ({ tenantId: t, permissionKey: k })) } },
    });
    const user = await owner.user.create({
      data: { tenantId: t, email: `${name.toLowerCase()}@office-suite.example.org`, displayName: `Synthetic officer ${name}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true },
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

  const client = (decorate: (r: request.Test) => request.Test): Client => {
    const agent = request(app.getHttpServer());
    return {
      get: (p) => decorate(agent.get(`/api${p}`)),
      post: (p) => decorate(agent.post(`/api${p}`)),
      put: (p) => decorate(agent.put(`/api${p}`)),
      patch: (p) => decorate(agent.patch(`/api${p}`)),
    };
  };

  return {
    app,
    owner,
    tenantId,
    slug,
    otherTenantId,
    otherSlug,
    units: main.units,
    otherUnits: other.units,
    users,
    portalServiceUserId: main.portalServiceUserId,
    storageRoot,
    http: (who) => {
      if (!tokens[who]) throw new Error(`Unknown persona ${who}`);
      return client((r) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web'));
    },
    pub: (ip) => client((r) => r.set('x-ngao-client', 'web').set('x-forwarded-for', ip)),
    close: async () => {
      await app.close();
      await owner.$disconnect();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Random synthetic client IP for public-portal requests (keeps rate-limit buckets apart). */
export function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]! % 250 + 1}`;
}
