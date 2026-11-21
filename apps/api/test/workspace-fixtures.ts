/**
 * Harness for the workspace-admin integration suite: one PLATFORM organisation (operator) and two
 * ordinary organisations, users with custom roles holding exactly the permissions a test needs,
 * and MFA-verified, recently re-authenticated access tokens. Synthetic data only; nothing leaves
 * the process (QUEUES_ENABLED=false, log message providers).
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, type PrismaClient, sha256Hex } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

export const OWNER_URL = process.env.TEST_DATABASE_URL;
export const APP_URL = process.env.TEST_APP_DATABASE_URL;
const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';
export const PASSWORD = 'Synthetic-Password-2027';

export interface WsTenant {
  id: string;
  slug: string;
}

export interface WsHarness {
  owner: PrismaClient;
  app: INestApplication;
  platform: WsTenant;
  a: WsTenant;
  b: WsTenant;
  users: Record<string, { id: string; tenantId: string }>;
  mkUser: (key: string, tenant: WsTenant, perms: PermissionKey[], opts?: { mfa?: boolean; roleMfaRequired?: boolean; status?: 'ACTIVE' | 'INVITED' }) => Promise<string>;
  token: (key: string, opts?: { reauth?: boolean }) => Promise<string>;
  close: () => Promise<void>;
}

export async function bootWorkspaceHarness(prefix: string): Promise<WsHarness> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: OWNER_URL,
    APP_DATABASE_URL: APP_URL,
    QUEUES_ENABLED: 'false',
    STORAGE_DRIVER: 'local',
    JWT_ACCESS_SECRET: JWT_SECRET,
    JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    EMAIL_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
    PUSH_PROVIDER: 'log',
    MALWARE_SCANNER: 'none',
    CAPTCHA_PROVIDER: 'none',
  });
  const owner = createPrismaClient({ url: OWNER_URL!, log: [] });
  for (const p of PERMISSION_DEFINITIONS) {
    await owner.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
      update: {},
    });
  }
  const mkTenant = async (kind: string, type: 'PLATFORM' | 'CAMPAIGN' | 'ELECTED_OFFICE'): Promise<WsTenant> => {
    const id = randomUUID();
    const slug = `${prefix}-${kind}-${id.slice(0, 8)}`;
    await owner.tenant.create({ data: { id, slug, name: `Synthetic ${kind} (${prefix})`, type } });
    return { id, slug };
  };
  const platform = await mkTenant('platform', 'PLATFORM');
  const a = await mkTenant('a', 'CAMPAIGN');
  const b = await mkTenant('b', 'CAMPAIGN');
  const users: WsHarness['users'] = {};
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const jwt = new JwtService();

  const mkUser: WsHarness['mkUser'] = async (key, tenant, perms, opts = {}) => {
    const user = await owner.user.create({
      data: {
        tenantId: tenant.id,
        email: `${key.toLowerCase()}@${prefix}.example.org`,
        displayName: `Synthetic ${key}`,
        status: opts.status ?? 'ACTIVE',
        passwordHash: opts.status === 'INVITED' ? null : hash,
        mfaEnabled: !!opts.mfa,
      },
    });
    const role = await owner.role.create({
      data: {
        tenantId: tenant.id,
        key: `${prefix.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase()}`,
        name: key,
        mfaRequired: !!opts.roleMfaRequired,
        permissions: { create: perms.map((k) => ({ tenantId: tenant.id, permissionKey: k })) },
      },
    });
    await owner.roleAssignment.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, scopeType: 'ORGANISATION' } });
    users[key] = { id: user.id, tenantId: tenant.id };
    return user.id;
  };

  const token: WsHarness['token'] = async (key, opts = {}) => {
    const reauth = opts.reauth ?? true;
    const u = users[key]!;
    const session = await owner.session.create({
      data: {
        tenantId: u.tenantId,
        userId: u.id,
        refreshTokenHash: sha256Hex(randomUUID()),
        mfaVerifiedAt: new Date(),
        reauthAt: reauth ? new Date() : null,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return jwt.sign(
      { sub: u.id, tid: u.tenantId, sid: session.id, mfa: true, ...(reauth ? { rat: Math.floor(Date.now() / 1000) } : {}), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  };

  const { createApp } = await import('../src/main');
  const app = await createApp();
  await app.init();

  return {
    owner,
    app,
    platform,
    a,
    b,
    users,
    mkUser,
    token,
    close: async () => {
      await app.close();
      await owner.$disconnect();
    },
  };
}

/** Bearer-authenticated JSON calls with the CSRF header the web client sends. */
export function wsApi(app: INestApplication, bearer?: string) {
  const s = () => request(app.getHttpServer());
  const wrap = (r: request.Test) => {
    const withCsrf = r.set('x-ngao-client', 'web');
    return bearer ? withCsrf.set('authorization', `Bearer ${bearer}`) : withCsrf;
  };
  return {
    get: (p: string) => wrap(s().get(`/api${p}`)),
    post: (p: string, body: object = {}) => wrap(s().post(`/api${p}`)).send(body),
    patch: (p: string, body: object = {}) => wrap(s().patch(`/api${p}`)).send(body),
    put: (p: string, body: object = {}) => wrap(s().put(`/api${p}`)).send(body),
    upload: (p: string, field: string, buf: Buffer, filename: string, contentType: string) =>
      wrap(s().post(`/api${p}`)).attach(field, buf, { filename, contentType }),
  };
}
