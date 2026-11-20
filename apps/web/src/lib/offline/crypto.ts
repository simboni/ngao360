/**
 * Encryption of queued records at rest (docs/ARCHITECTURE.md §14.1).
 *
 * Each signed-in user and tenant gets one AES-GCM 256 key, generated on the
 * device when their queue database is first opened and stored in that
 * database as a NON-EXTRACTABLE `CryptoKey`: script on this origin can use it
 * through WebCrypto, but its bytes cannot be read or exported, so copying the
 * browser's files does not reveal queued payloads. Every record is sealed with
 * a fresh random 96-bit IV and bound to its queue entry with additional
 * authenticated data (the idempotency key), so ciphertext cannot be swapped
 * between entries. The key and the database are deleted on sign-out.
 *
 * Known gap: the key is not wrapped with a PIN-derived key, so someone using
 * the unlocked browser profile on the same phone can still open the app and
 * see queued items. A PIN wrap (PBKDF2) is the planned next step.
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

/** New non-extractable AES-GCM key for one user's queue. */
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
