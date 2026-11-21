/**
 * A software WebAuthn authenticator for tests: ES256 (P-256) keys, attestation "none", minimal
 * CBOR encoder. Produces the RegistrationResponseJSON / AuthenticationResponseJSON a browser
 * would send, with full control over flags, counter, origin and challenge so tests can forge
 * replayed, cloned (counter regression), wrong-origin and no-user-verification responses.
 * Synthetic only; no network.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries: Array<[Cbor, Cbor]> = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  challenge?: string;
  flags?: number;
  counter?: number;
  type?: string;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer = Buffer.from(randomBytes(32));
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  counter = 0;

  constructor(
    readonly rpId = 'localhost',
    readonly origin = 'http://localhost:3000',
    readonly userHandle: string | null = null,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private authData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter, 0);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.cose);
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** RegistrationResponseJSON for `options` from generateRegistrationOptions. */
  register(options: Record<string, unknown>, o: CeremonyOverrides = {}): Record<string, unknown> {
    const challenge = o.challenge ?? String(options.challenge);
    const clientDataJSON = this.clientData(o.type ?? 'webauthn.create', challenge, o.origin ?? this.origin);
    const authData = this.authData(o.rpId ?? this.rpId, o.flags ?? FLAG_UP | FLAG_UV | FLAG_AT, o.counter ?? this.counter, true);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /**
   * AuthenticationResponseJSON for `options` from generateAuthenticationOptions. Increments the
   * internal counter unless `counter` is given (to forge a clone / regression).
   */
  assert(options: Record<string, unknown>, o: CeremonyOverrides = {}): Record<string, unknown> {
    const challenge = o.challenge ?? String(options.challenge);
    const counter = o.counter ?? ++this.counter;
    const clientDataJSON = this.clientData(o.type ?? 'webauthn.get', challenge, o.origin ?? this.origin);
    const authenticatorData = this.authData(o.rpId ?? this.rpId, o.flags ?? FLAG_UP | FLAG_UV, counter, false);
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
    const signature = signer.sign(this.privateKey); // DER-encoded ECDSA, as authenticators produce
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        ...(this.userHandle ? { userHandle: b64u(Buffer.from(this.userHandle, 'utf8')) } : {}),
      },
      clientExtensionResults: {},
    };
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Shared harness for the auth-passkeys and auth-recovery integration suites.                 */
/* ------------------------------------------------------------------------------------------ */

import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createPrismaClient, generateTotpSecret, type PrismaClient, sealSecret, sha256Hex } from '@ngao360/db';
import { PERMISSION_DEFINITIONS, type PermissionKey } from '@ngao360/shared';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

export const OWNER_URL = process.env.TEST_DATABASE_URL;
export const APP_URL = process.env.TEST_APP_DATABASE_URL;
export const JWT_SECRET = 'test-access-secret-test-access-secret-test-access-secret';
export const MFA_KEY = Buffer.alloc(32, 9).toString('base64');
export const PASSWORD = 'Synthetic-Password-2027';
export const ORIGIN = 'http://localhost:3000';

export interface Harness {
  owner: PrismaClient;
  app: INestApplication;
  tenantId: string;
  slug: string;
  users: Record<string, string>;
  secrets: Record<string, string>;
  emailOf: (key: string) => string;
  /** Access token for a fresh MFA-verified, recently re-authenticated session. */
  token: (key: string, opts?: { reauth?: boolean; mfa?: boolean }) => Promise<string>;
  mkUser: (key: string, perms: PermissionKey[], opts?: { mfa?: boolean; roleMfaRequired?: boolean }) => Promise<string>;
  close: () => Promise<void>;
}

export async function bootHarness(prefix: string): Promise<Harness> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: OWNER_URL,
    APP_DATABASE_URL: APP_URL,
    QUEUES_ENABLED: 'false',
    STORAGE_DRIVER: 'local',
    JWT_ACCESS_SECRET: JWT_SECRET,
    JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
    MFA_ENCRYPTION_KEY: MFA_KEY,
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    MFA_MAX_FAILURES: '5',
    WEB_ORIGIN: ORIGIN,
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: ORIGIN,
  });
  const owner = createPrismaClient({ url: OWNER_URL!, log: [] });
  for (const p of PERMISSION_DEFINITIONS) {
    await owner.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, action: p.action, description: p.description, highRisk: !!p.highRisk },
      update: {},
    });
  }
  const tenantId = randomUUID();
  const slug = `${prefix}-${tenantId.slice(0, 8)}`;
  await owner.tenant.create({ data: { id: tenantId, slug, name: `Synthetic ${prefix} tenant`, type: 'CAMPAIGN' } });
  const users: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const jwt = new JwtService();
  const emailOf = (key: string) => `${key.toLowerCase()}@${prefix}.example.org`;

  const mkUser: Harness['mkUser'] = async (key, perms, opts = {}) => {
    const user = await owner.user.create({
      data: {
        tenantId,
        email: emailOf(key),
        displayName: `Synthetic ${key}`,
        status: 'ACTIVE',
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        mfaEnabled: !!opts.mfa,
      },
    });
    const role = await owner.role.create({
      data: {
        tenantId,
        key: `${prefix.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase()}`,
        name: key,
        mfaRequired: !!opts.roleMfaRequired,
        permissions: { create: perms.map((k) => ({ tenantId, permissionKey: k })) },
      },
    });
    await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: role.id, scopeType: 'ORGANISATION' } });
    if (opts.mfa) {
      const secret = generateTotpSecret();
      secrets[key] = secret;
      await owner.mfaFactor.create({
        data: { tenantId, userId: user.id, type: 'TOTP', status: 'ACTIVE', label: 'Synthetic app', secretEncrypted: sealSecret(secret, MFA_KEY), verifiedAt: new Date() },
      });
    }
    users[key] = user.id;
    return user.id;
  };

  const token: Harness['token'] = async (key, opts = {}) => {
    const mfa = opts.mfa ?? true;
    const reauth = opts.reauth ?? true;
    const session = await owner.session.create({
      data: {
        tenantId,
        userId: users[key]!,
        refreshTokenHash: sha256Hex(randomUUID()),
        mfaVerifiedAt: mfa ? new Date() : null,
        reauthAt: reauth ? new Date() : null,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return jwt.sign(
      { sub: users[key], tid: tenantId, sid: session.id, mfa, ...(reauth ? { rat: Math.floor(Date.now() / 1000) } : {}), typ: 'access' },
      { secret: JWT_SECRET, expiresIn: 3600 },
    );
  };

  const { createApp } = await import('../src/main');
  const app = await createApp();
  await app.init();

  return {
    owner,
    app,
    tenantId,
    slug,
    users,
    secrets,
    emailOf,
    token,
    mkUser,
    close: async () => {
      await app.close();
      await owner.$disconnect();
    },
  };
}

/** Request helpers: bearer-authenticated JSON calls with the CSRF header the web client sends. */
export function api(app: INestApplication, bearer?: string) {
  const s = () => request(app.getHttpServer());
  const wrap = (r: request.Test) => {
    const withCsrf = r.set('x-ngao-client', 'web');
    return bearer ? withCsrf.set('authorization', `Bearer ${bearer}`) : withCsrf;
  };
  return {
    get: (p: string) => wrap(s().get(`/api${p}`)),
    post: (p: string, body: object = {}) => wrap(s().post(`/api${p}`)).send(body),
    patch: (p: string, body: object = {}) => wrap(s().patch(`/api${p}`)).send(body),
    del: (p: string) => wrap(s().delete(`/api${p}`)),
  };
}
