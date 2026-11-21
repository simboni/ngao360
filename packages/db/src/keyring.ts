/**
 * Key rings for sealed columns and keyed hashes, and the agent personal-data cipher.
 * Server-only: depends on node:crypto. Used by the API, the key-rotation CLI and the seed.
 *
 * Rotation model (docs/RUNBOOKS.md "Key rotation"): the new key goes into the main variable
 * (e.g. AGENT_DATA_KEY) and the old one into `<NAME>_PREVIOUS`. Reads try the current key first,
 * then the previous one; writes always use the current key. Lookups by keyed hash compare against
 * the hash under every configured key until `pnpm ops:rotate-keys` has rewritten every row, after
 * which the previous key is removed.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from './security';

/** HKDF-SHA256 of a base64 32-byte key (or any secret string) for one purpose. */
export function deriveKey(secret: string, label: string): Buffer {
  const ikm = /^[A-Za-z0-9+/]{43}=$/.test(secret) ? Buffer.from(secret, 'base64') : Buffer.from(secret, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from('ngao360'), Buffer.from(label), 32));
}

/** Short, non-reversible identifier of a key (checkpoints, logs). Never the key itself. */
export function keyId(secret: string): string {
  return createHash('sha256').update(`ngao360-key-id:${secret}`).digest('hex').slice(0, 12);
}

function present<T>(values: Array<T | undefined | null>): T[] {
  return values.filter((v): v is T => v !== undefined && v !== null && v !== '');
}

/** AES-256-GCM "iv.tag.ciphertext" values (sealSecret format) under a current key and older keys. */
export class SealKeyring {
  private readonly keys: string[];

  constructor(current: string, previous: Array<string | undefined | null> = []) {
    this.keys = [current, ...present(previous).filter((k) => k !== current)];
  }

  get hasPrevious(): boolean {
    return this.keys.length > 1;
  }

  seal(plaintext: string): string {
    return sealSecret(plaintext, this.keys[0]!);
  }

  /** Plaintext and the index of the key that opened it (0 = current), or null if no key opens it. */
  tryOpen(sealed: string): { plaintext: string; keyIndex: number } | null {
    for (let i = 0; i < this.keys.length; i += 1) {
      try {
        return { plaintext: openSecret(sealed, this.keys[i]!), keyIndex: i };
      } catch {
        // wrong key or tampered value: try the next key
      }
    }
    return null;
  }

  /** Fail closed: throws when no configured key opens the value. */
  open(sealed: string): string {
    const r = this.tryOpen(sealed);
    if (!r) throw new Error('Sealed value cannot be opened with any configured key');
    return r.plaintext;
  }
}

/** HMAC-SHA256 under a current key and older keys (hex, 64 characters). */
export class HmacKeyring {
  private readonly keys: Array<string | Buffer>;

  constructor(current: string | Buffer, previous: Array<string | Buffer | undefined | null> = []) {
    this.keys = [current, ...present(previous).filter((k) => !(typeof k === 'string' && k === current))];
  }

  hash(message: string): string {
    return createHmac('sha256', this.keys[0]!).update(message).digest('hex');
  }

  /** Hashes under every configured key, current first (lookups during a rotation). */
  candidates(message: string): string[] {
    return [...new Set(this.keys.map((k) => createHmac('sha256', k).update(message).digest('hex')))];
  }
}

/* --------------------------- Agent personal data --------------------------- */

export const AGENT_SENSITIVE_FIELDS = ['nationalIdNumber', 'phone', 'mpesaNumber', 'nextOfKinName', 'nextOfKinPhone', 'nextOfKinRelationship'] as const;
export type AgentSensitiveField = (typeof AGENT_SENSITIVE_FIELDS)[number];

/** Prefix of a sealed agent value; the database CHECK constraint requires it on every column. */
export const AGENT_SEALED_PREFIX = 'ag1.';
const AGENT_SEALED_RE = /^ag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function isSealedAgentValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && AGENT_SEALED_RE.test(value);
}

/**
 * Development / test fallback when AGENT_DATA_KEY is not set: a key derived from
 * MFA_ENCRYPTION_KEY, so agent data is still encrypted locally. Production requires AGENT_DATA_KEY.
 */
export function developmentAgentDataKey(mfaKey: string): string {
  return deriveKey(mfaKey, 'ngao360/agent-data/development-fallback').toString('base64');
}

export interface AgentRowRef {
  tenantId: string;
  agentId: string;
}

/** Normalised input of a lookup hash: national ID without spaces / dashes, upper case; phone digits. */
export function normaliseAgentLookup(kind: 'nationalId' | 'phone', value: string): string {
  return kind === 'nationalId' ? value.replace(/[\s-]/g, '').toUpperCase() : value.replace(/[\s()-]/g, '');
}

/**
 * Column-level encryption of `agent_sensitive` (national ID, phone, M-Pesa number, next of kin).
 *
 * - AES-256-GCM under a key derived from AGENT_DATA_KEY (HKDF "agent-data/v1"); the associated data
 *   binds each value to its tenant, agent and column, so a ciphertext copied to another row or
 *   column does not open. Format: "ag1.<iv>.<tag>.<ciphertext>" (base64url).
 * - Lookup / duplicate hashes: HMAC-SHA256 under a second derived key (HKDF "agent-lookup/v1") over
 *   "<tenantId>:<kind>:<normalised value>". Tenant-scoped; useless without the key.
 * - `AGENT_DATA_KEY_PREVIOUS` is accepted for reading during a rotation.
 */
export class AgentDataCipher {
  private readonly encKeys: Buffer[];
  private readonly lookup: HmacKeyring;
  readonly currentKeyId: string;

  constructor(current: string, previous: Array<string | undefined | null> = []) {
    const all = [current, ...present(previous).filter((k) => k !== current)];
    for (const k of all) if (Buffer.from(k, 'base64').length !== 32) throw new Error('AGENT_DATA_KEY must decode to 32 bytes');
    this.encKeys = all.map((k) => deriveKey(k, 'agent-data/v1'));
    const lookupKeys = all.map((k) => deriveKey(k, 'agent-lookup/v1'));
    this.lookup = new HmacKeyring(lookupKeys[0]!, lookupKeys.slice(1));
    this.currentKeyId = keyId(current);
  }

  private static aad(ref: AgentRowRef, field: AgentSensitiveField): Buffer {
    return Buffer.from(`ngao360:agent_sensitive:${ref.tenantId}:${ref.agentId}:${field}`);
  }

  seal(ref: AgentRowRef, field: AgentSensitiveField, plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKeys[0]!, iv);
    cipher.setAAD(AgentDataCipher.aad(ref, field));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${AGENT_SEALED_PREFIX}${[iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.')}`;
  }

  /**
   * Plaintext and the key index that opened it (0 = current); `legacy` for a value written before
   * column encryption (no "ag1." prefix). Null when no configured key opens a sealed value.
   */
  tryOpen(ref: AgentRowRef, field: AgentSensitiveField, value: string): { plaintext: string; keyIndex: number; legacy: boolean } | null {
    if (!value.startsWith(AGENT_SEALED_PREFIX)) return { plaintext: value, keyIndex: 0, legacy: true };
    const [iv, tag, ct] = value.slice(AGENT_SEALED_PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !ct || iv.length !== 12 || tag.length !== 16) return null;
    for (let i = 0; i < this.encKeys.length; i += 1) {
      try {
        const d = createDecipheriv('aes-256-gcm', this.encKeys[i]!, iv);
        d.setAAD(AgentDataCipher.aad(ref, field));
        d.setAuthTag(tag);
        return { plaintext: Buffer.concat([d.update(ct), d.final()]).toString('utf8'), keyIndex: i, legacy: false };
      } catch {
        // next key
      }
    }
    return null;
  }

  /** Fail closed: a sealed value no configured key opens throws (never returned as text). */
  open(ref: AgentRowRef, field: AgentSensitiveField, value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const r = this.tryOpen(ref, field, value);
    if (!r) throw new Error('Agent personal data cannot be decrypted with the configured AGENT_DATA_KEY');
    return r.plaintext;
  }

  lookupHash(ref: Pick<AgentRowRef, 'tenantId'>, kind: 'nationalId' | 'phone', value: string | null | undefined): string | null {
    if (!value) return null;
    return this.lookup.hash(`${ref.tenantId}:${kind}:${normaliseAgentLookup(kind, value)}`);
  }

  lookupHashes(ref: Pick<AgentRowRef, 'tenantId'>, kind: 'nationalId' | 'phone', value: string): string[] {
    return this.lookup.candidates(`${ref.tenantId}:${kind}:${normaliseAgentLookup(kind, value)}`);
  }

  /** Column values for a full agent_sensitive row: every field sealed, plus both lookup hashes. */
  sealRow(ref: AgentRowRef, plain: Partial<Record<AgentSensitiveField, string | null | undefined>>) {
    const out = {} as Record<AgentSensitiveField, string | null> & { nationalIdHash: string | null; phoneHash: string | null };
    for (const f of AGENT_SENSITIVE_FIELDS) out[f] = this.seal(ref, f, plain[f] ?? null);
    out.nationalIdHash = this.lookupHash(ref, 'nationalId', plain.nationalIdNumber);
    out.phoneHash = this.lookupHash(ref, 'phone', plain.phone);
    return out;
  }

  /** Opens every field of a stored row (fail closed). */
  openRow(ref: AgentRowRef, row: Partial<Record<AgentSensitiveField, string | null>>): Record<AgentSensitiveField, string | null> {
    const out = {} as Record<AgentSensitiveField, string | null>;
    for (const f of AGENT_SENSITIVE_FIELDS) out[f] = this.open(ref, f, row[f] ?? null);
    return out;
  }
}
