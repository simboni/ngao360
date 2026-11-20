/**
 * Shared fixture for the field, War Room and sync integration suites
 * (test/field-*.spec.ts, test/warroom-*.spec.ts, test/sync-*.spec.ts): two
 * synthetic tenants with Bungoma-like synthetic geography, an APPROVED station
 * registry, the field and tally modules switched on, personas with chosen
 * permissions (organisation-wide, scoped to a unit, or to one polling station
 * by station code) and an HTTP client per persona.
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
const JWT_SECRET = 'field-suite-access-secret-field-suite-access-secret-0001';

export type UnitKey = 'county' | 'k1' | 'k2' | 'w1' | 'w2' | 'w3';
/** Stations of the approved registry: code → ward. */
export const STATIONS: Record<string, UnitKey> = {
  'F-001': 'w1',
  'F-002': 'w1',
  'F-003': 'w2',
  'F-004': 'w2',
  'F-005': 'w3',
  'F-006': 'w3',
};

export interface PersonaSpec {
  perms: PermissionKey[];
  /** A unit key, or `station:<code>` for a POLLING_STATION grant. Default organisation-wide. */
  scope?: UnitKey | `station:${string}`;
  tenant?: 'main' | 'other';
  reauth?: boolean;
}

export interface Client {
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  put: (path: string) => request.Test;
  patch: (path: string) => request.Test;
}

export interface FieldFixture {
  app: INestApplication;
  owner: PrismaClient;
  tenantId: string;
  otherTenantId: string;
  cycleId: string;
  otherCycleId: string;
  registryId: string;
  units: Record<UnitKey, string>;
  otherUnits: Record<UnitKey, string>;
  stationIds: Record<string, string>;
  users: Record<string, string>;
  http: (who: string) => Client;
  close: () => Promise<void>;
}

export function syntheticPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < 4; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(12)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Offline metadata for a device-originated write. */
export function offline(deviceId = 'device-synthetic-01', at = new Date()): { clientIdempotencyKey: string; deviceId: string; clientCreatedAt: string; submittedOffline: boolean } {
  return { clientIdempotencyKey: randomUUID(), deviceId, clientCreatedAt: at.toISOString(), submittedOffline: false };
}

async function seedTenant(owner: PrismaClient, tenantId: string, slug: string, opts: { fieldConfig: Record<string, unknown> }) {
  await owner.tenant.create({ data: { id: tenantId, slug, name: `Synthetic campaign ${slug}`, type: 'CAMPAIGN' } });
  const cycle = await owner.electionCycle.create({
    data: { tenantId, name: 'Synthetic 2027 general election', electionDate: new Date('2027-08-10'), legalConfigVersion: 'test', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
  });
  const reg = await owner.registryVersion.create({ data: { tenantId, electionCycleId: cycle.id, version: 'synthetic-v1', source: 'synthetic', status: 'DRAFT', stationCount: Object.keys(STATIONS).length } });
  const units = {} as Record<UnitKey, string>;
  const paths = {} as Record<UnitKey, string>;
  const unit = async (key: UnitKey, type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, name: string, parent?: UnitKey) => {
    const id = randomUUID();
    const path = `${parent ? paths[parent] : '/'}${id}/`;
    await owner.geographicUnit.create({
      data: { id, tenantId, electionCycleId: cycle.id, registryVersionId: reg.id, type, parentId: parent ? units[parent] : null, officialCode: code, officialName: name, path, sourceVersion: 'synthetic-v1' },
    });
    units[key] = id;
    paths[key] = path;
  };
  await unit('county', 'COUNTY', '039', 'Bungoma (synthetic)');
  await unit('k1', 'CONSTITUENCY', '039-1', 'Kanduyi (synthetic)', 'county');
  await unit('k2', 'CONSTITUENCY', '039-2', 'Webuye East (synthetic)', 'county');
  await unit('w1', 'WARD', '039-1-1', 'Township ward (synthetic)', 'k1');
  await unit('w2', 'WARD', '039-2-1', 'Mihuu ward (synthetic)', 'k2');
  await unit('w3', 'WARD', '039-1-2', 'Musikoma ward (synthetic)', 'k1');
  const wardParent: Record<string, UnitKey> = { w1: 'k1', w2: 'k2', w3: 'k1' };
  const stationIds: Record<string, string> = {};
  for (const [code, ward] of Object.entries(STATIONS)) {
    const s = await owner.pollingStation.create({
      data: {
        tenantId,
        electionCycleId: cycle.id,
        registryVersionId: reg.id,
        geographicUnitId: units[ward],
        countyId: units.county,
        constituencyId: units[wardParent[ward]!],
        wardId: units[ward],
        code,
        name: `Synthetic Primary School ${code}`,
      },
    });
    stationIds[code] = s.id;
  }
  await owner.registryVersion.update({ where: { id: reg.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
  await owner.tenantModule.createMany({
    data: [
      { tenantId, moduleKey: 'field', enabled: true, config: { electionCycleId: cycle.id, ...opts.fieldConfig } },
      { tenantId, moduleKey: 'tally', enabled: true, config: {} },
    ],
  });
  return { cycleId: cycle.id, registryId: reg.id, units, stationIds };
}

export async function createFieldFixture(personas: Record<string, PersonaSpec>, opts: { fieldConfig?: Record<string, unknown> } = {}): Promise<FieldFixture> {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ngao-field-suite-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: OWNER_URL,
    APP_DATABASE_URL: APP_URL,
    QUEUES_ENABLED: 'false',
    OFFICE_RETENTION_INTERVAL_MINUTES: '0',
    FIELD_WARROOM_CACHE_SECONDS: '0',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: storageRoot,
    JWT_ACCESS_SECRET: JWT_SECRET,
    JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
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
  const main = await seedTenant(owner, tenantId, `bungoma-field-${tenantId.slice(0, 8)}`, { fieldConfig: opts.fieldConfig ?? {} });
  const other = await seedTenant(owner, otherTenantId, `other-field-${otherTenantId.slice(0, 8)}`, { fieldConfig: {} });

  const jwt = new JwtService();
  const users: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const [name, spec] of Object.entries(personas)) {
    const t = spec.tenant === 'other' ? otherTenantId : tenantId;
    const seed = spec.tenant === 'other' ? other : main;
    const role = await owner.role.create({
      data: { tenantId: t, key: `R_${name.toUpperCase()}_${randomUUID().slice(0, 6)}`, name: `Synthetic ${name}`, permissions: { create: spec.perms.map((k) => ({ tenantId: t, permissionKey: k })) } },
    });
    const user = await owner.user.create({
      data: { tenantId: t, email: `${name.toLowerCase()}-${t.slice(0, 6)}@field-suite.example.org`, displayName: `Synthetic ${name}`, status: 'ACTIVE', passwordHash: 'x', mfaEnabled: true },
    });
    let assignment: Record<string, unknown> = { scopeType: 'ORGANISATION' };
    if (spec.scope?.startsWith('station:')) {
      assignment = { scopeType: 'POLLING_STATION', pollingStationId: seed.stationIds[spec.scope.slice('station:'.length)] };
    } else if (spec.scope) {
      const key = spec.scope as UnitKey;
      assignment = { scopeType: key === 'county' ? 'COUNTY' : key.startsWith('k') ? 'CONSTITUENCY' : 'WARD', geographicUnitId: seed.units[key] };
    }
    await owner.roleAssignment.create({ data: { tenantId: t, userId: user.id, roleId: role.id, reason: 'fixture', ...assignment } });
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
  const http = (who: string): Client => {
    if (!tokens[who]) throw new Error(`Unknown persona ${who}`);
    const agent = request(app.getHttpServer());
    const d = (r: request.Test) => r.set('authorization', `Bearer ${tokens[who]}`).set('x-ngao-client', 'web');
    return { get: (p) => d(agent.get(`/api${p}`)), post: (p) => d(agent.post(`/api${p}`)), put: (p) => d(agent.put(`/api${p}`)), patch: (p) => d(agent.patch(`/api${p}`)) };
  };
  return {
    app,
    owner,
    tenantId,
    otherTenantId,
    cycleId: main.cycleId,
    otherCycleId: other.cycleId,
    registryId: main.registryId,
    units: main.units,
    otherUnits: other.units,
    stationIds: main.stationIds,
    users,
    http,
    close: async () => {
      await app.close();
      await owner.$disconnect();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Synthetic field report template (factual questions only), activated by a second person. */
export const OPENING_TEMPLATE = {
  key: 'opening-of-polls',
  name: 'Opening of polls (synthetic)',
  reportType: 'OPENING_OF_POLLS',
  schema: {
    sections: [
      {
        key: 'opening',
        title: 'Opening',
        questions: [
          { key: 'opened_on_time', label: 'Did the station open on time?', type: 'YES_NO', required: true },
          { key: 'opening_time', label: 'Time the first voter was served', type: 'TIME' },
          { key: 'queue_estimate', label: 'Approximate number of people queueing', type: 'NUMBER', min: 0, max: 5000 },
        ],
      },
    ],
    allowEvidence: true,
  },
};
