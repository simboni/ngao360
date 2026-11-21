/**
 * Encryption of queued records in IndexedDB (docs/ARCHITECTURE.md §14.1).
 *
 * Key hierarchy (API contract §36):
 * - Queue key: one AES-GCM 256 key per signed-in user and tenant, generated on
 *   the device. Every record is sealed under it with a fresh random 96-bit IV
 *   and bound to its queue entry with additional authenticated data, so
 *   ciphertext cannot be swapped between entries.
 * - Wrapping key: derived from the person's device PIN with PBKDF2-SHA-256
 *   (600 000 iterations, random 128-bit salt per user and device). Only the
 *   queue key WRAPPED under it (AES-GCM, bound to the database name and the
 *   KDF parameters) and the salt are stored; the unwrapped queue key lives
 *   only in memory, as a non-extractable CryptoKey, while the queue is
 *   unlocked (`pin.ts`).
 *
 * What this protects: a copy of the browser profile or of the IndexedDB files
 * holds ciphertext and the wrapped key, not the queue key; opening `/m` on the
 * phone shows nothing until the PIN is entered; the in-app attempt limit
 * (`pin.ts`) stops guessing on the phone itself.
 * What it does NOT protect: a PIN is short. Someone who copies the profile can
 * try every PIN offline, outside the app's attempt limit; PBKDF2 only makes
 * each guess slow. It does not protect a phone that is unlocked and in use,
 * or a compromised browser.
 */

export interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available on this device');
  return c.subtle;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** New non-extractable AES-GCM key (in-memory queues without IndexedDB, tests). */
export function generateQueueKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

export function isCryptoAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle);
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects SharedArrayBuffer views under strict typing). */
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

export async function sealBytes(key: CryptoKey, plain: ArrayBuffer | Uint8Array, aad: string): Promise<Sealed> {
  const iv = bytes(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  const input = plain instanceof Uint8Array ? bytes(plain) : new Uint8Array(plain.slice(0));
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, input);
  return { iv, data };
}

export async function openBytes(key: CryptoKey, sealed: Sealed, aad: string): Promise<ArrayBuffer> {
  return subtle().decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: enc.encode(aad) }, key, sealed.data);
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  return sealBytes(key, enc.encode(JSON.stringify(value)), aad);
}

export async function openJson<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  return JSON.parse(dec.decode(await openBytes(key, sealed, aad))) as T;
}

/* ----------------------------- Associated data ----------------------------- */

/** Associated data binding each sealed value to its place in the queue. */
export const AAD = {
  body: (key: string) => `entry:${key}`,
  attachment: (key: string, id: string) => `attachment:${key}:${id}`,
  server: (key: string) => `server:${key}`,
  meta: (name: string) => `meta:${name}`,
} as const;

/* ---------------------------- PIN-wrapped queue key ------------------------- */

export const PIN_KDF = 'PBKDF2-SHA-256' as const;
/** PBKDF2 iterations for the PIN (OWASP 2023 figure for PBKDF2-HMAC-SHA256). */
export const PIN_KDF_ITERATIONS = 600_000;

/** What is stored for the queue key: never the key itself. */
export interface WrappedQueueKey {
  v: 1;
  kdf: typeof PIN_KDF;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  wrapped: ArrayBuffer;
  createdAt: string;
}

function wrapAad(binding: string, iterations: number): Uint8Array<ArrayBuffer> {
  return bytes(enc.encode(`ngao360-queue-key:v1:${PIN_KDF}:${iterations}:${binding}`));
}

/** Wrapping key from a PIN (PBKDF2-SHA-256); never extractable. */
export async function derivePinKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', bytes(enc.encode(pin)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Wrap a queue key under a PIN. `queueKey` must be extractable (it is only
 * while it is being wrapped); callers drop it afterwards.
 */
export async function wrapQueueKey(
  queueKey: CryptoKey,
  pin: string,
  binding: string,
  opts: { iterations?: number; now?: Date } = {},
): Promise<WrappedQueueKey> {
  const iterations = opts.iterations ?? PIN_KDF_ITERATIONS;
  const salt = bytes(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const iv = bytes(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  const kek = await derivePinKey(pin, salt, iterations);
  const wrapped = await subtle().wrapKey('raw', queueKey, kek, { name: 'AES-GCM', iv, additionalData: wrapAad(binding, iterations) });
  return { v: 1, kdf: PIN_KDF, iterations, salt, iv, wrapped, createdAt: (opts.now ?? new Date()).toISOString() };
}

/**
 * Unwrap the queue key with a PIN. A wrong PIN (or a record moved to another
 * database) fails AES-GCM authentication and throws. The result is
 * non-extractable unless `extractable` is set (only to re-wrap under a new PIN).
 */
export async function unwrapQueueKey(record: WrappedQueueKey, pin: string, binding: string, extractable = false): Promise<CryptoKey> {
  if (record.v !== 1 || record.kdf !== PIN_KDF) throw new Error('Unknown queue key format');
  const kek = await derivePinKey(pin, record.salt, record.iterations);
  return subtle().unwrapKey(
    'raw',
    record.wrapped,
    kek,
    { name: 'AES-GCM', iv: bytes(record.iv), additionalData: wrapAad(binding, record.iterations) },
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** New EXTRACTABLE queue key, only to be wrapped at once (see `wrapQueueKey`). */
export function generateWrappableQueueKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** Same key, non-extractable, for use in memory (the raw copy is overwritten). */
export async function toNonExtractable(key: CryptoKey): Promise<CryptoKey> {
  if (!key.extractable) return key;
  const raw = new Uint8Array(await subtle().exportKey('raw', key));
  try {
    return (await subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])) as CryptoKey;
  } finally {
    raw.fill(0);
  }
}
