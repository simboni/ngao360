/**
 * Public case references. They are random (not sequential), so a reference
 * reveals nothing about case volume and cannot be enumerated; tracking also
 * needs the separate tracking code. Both use Crockford base32 without the
 * easily confused letters I, L, O and U.
 */
export const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(bytes: Uint8Array, length: number): string {
  if (bytes.length < length) throw new Error(`Need at least ${length} random bytes`);
  let out = '';
  for (let i = 0; i < length; i++) out += REFERENCE_ALPHABET[bytes[i]! % 32];
  return out;
}

/**
 * "<PREFIX>-XXXX-XXXX" from 8 random bytes (40 bits), e.g. "BGM-7K3F-9Q2X".
 * The prefix is a short tenant code (2–5 uppercase letters).
 */
export function formatPublicReference(prefix: string, randomBytes: Uint8Array): string {
  if (!/^[A-Z]{2,5}$/.test(prefix)) throw new Error('Public reference prefix must be 2–5 uppercase letters');
  const body = encode(randomBytes, 8);
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** 8-character tracking code from 8 random bytes (40 bits). Only its SHA-256 is stored. */
export function formatTrackingCode(randomBytes: Uint8Array): string {
  return encode(randomBytes, 8);
}

export const PUBLIC_REFERENCE_PATTERN = /^[A-Z]{2,5}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
