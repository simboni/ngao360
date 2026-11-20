/**
 * Server-side security primitives shared by the API and seed scripts:
 * canonical JSON hashing, AES-256-GCM secret boxing, RFC 6238 TOTP.
 * Server-only: depends on node:crypto.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/* ------------------------------ Canonical JSON ----------------------------- */

/** Deterministic JSON: object keys sorted recursively; Dates as ISO; BigInt as string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    // Prisma.Decimal and similar expose toJSON
    const maybe = value as { toJSON?: () => unknown };
    if (typeof maybe.toJSON === 'function' && !(value.constructor === Object)) {
      return normalise(maybe.toJSON());
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of canonical JSON, or null for null/undefined input. */
export function hashJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return sha256Hex(canonicalJson(value));
}

/* ------------------------------- Secret box -------------------------------- */

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

/** AES-256-GCM encrypt; output "iv.tag.ciphertext" (base64url parts). */
export function sealSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(base64Key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function openSecret(sealed: string, base64Key: string): string {
  const [iv, tag, ct] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('Malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(base64Key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/* ---------------------------------- TOTP ----------------------------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function totpAt(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function currentTotpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Verify a TOTP code within ±window steps. Returns the matched step (for replay
 * protection: reject steps <= lastUsedStep) or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { window?: number; nowMs?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const window = opts.window ?? 1;
  const now = currentTotpStep(opts.nowMs);
  for (let i = -window; i <= window; i++) {
    const step = now + i;
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;
    const expected = Buffer.from(totpAt(secretBase32, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(params: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const q = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/* ------------------------- Identifier fingerprints ------------------------- */

/**
 * Keyed fingerprint of a personal identifier (contributor ID / registration
 * number, payee tax PIN) for duplicate detection without storing the value:
 * HMAC-SHA256(key, "<tenantId>:<normalised value>"), hex. Normalisation drops
 * spaces, dashes and case. The API and seed pass the server secret
 * (MFA_ENCRYPTION_KEY); only masked values are ever stored next to it.
 */
export function identifierFingerprint(tenantId: string, value: string, key: string): string {
  const normalised = value.replace(/[\s-]/g, '').toUpperCase();
  return createHmac('sha256', key).update(`${tenantId}:${normalised}`).digest('hex');
}
