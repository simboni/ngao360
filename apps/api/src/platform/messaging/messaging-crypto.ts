/**
 * Sealing, keyed hashing and masking of message addresses (e-mail, phone, push endpoint).
 * Owner: platform-infra.
 *
 * - `seal` / `open`: AES-256-GCM with MESSAGING_ENCRYPTION_KEY (same box as MFA secrets).
 * - `hash`: HMAC-SHA256 with MESSAGING_HASH_KEY over "<kind>:<normalised address>". Not tenant
 *   scoped on purpose: an inbound STOP reply only carries the phone number, so the webhook must find
 *   every tenant's contact for it (through a SECURITY DEFINER lookup that returns tenant ids only).
 * - `mask`: what administrators and logs may see ("u***@example.org", "+2547******78").
 *
 * Without the keys (development with the log providers) nothing is sealed: the outbox stores the
 * masked address only and every message is SKIPPED by the log provider. Production refuses to start
 * without both keys, and so does any deployment that selects a vendor provider.
 */
import { Injectable } from '@nestjs/common';
import { openSecret, sealSecret } from '@ngao360/db';
import { createHmac } from 'node:crypto';
import { AppConfig } from '../../config/app-config';

export type AddressKind = 'EMAIL' | 'SMS' | 'PUSH';

/** Kenyan numbers written locally (07…, 01…) become +254…; anything else must already be E.164. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '');
  let e164: string;
  if (/^\+\d{8,15}$/.test(digits)) e164 = digits;
  else if (/^00\d{8,15}$/.test(digits)) e164 = `+${digits.slice(2)}`;
  else if (/^0[17]\d{8}$/.test(digits)) e164 = `+254${digits.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(digits)) e164 = `+${digits}`;
  else return null;
  return e164;
}

export function normaliseEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 320 ? v : null;
}

export function normaliseAddress(kind: AddressKind, raw: string): string | null {
  if (kind === 'EMAIL') return normaliseEmail(raw);
  if (kind === 'SMS') return normalisePhone(raw);
  return raw.trim() || null;
}

export function maskAddress(kind: AddressKind, address: string): string {
  if (kind === 'EMAIL') {
    const [local = '', domain = ''] = address.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (kind === 'SMS') {
    if (address.length <= 6) return '******';
    return `${address.slice(0, 5)}${'*'.repeat(Math.max(3, address.length - 7))}${address.slice(-2)}`;
  }
  try {
    return `push:${new URL(address).host}`;
  } catch {
    return 'push:device';
  }
}

@Injectable()
export class MessagingCrypto {
  constructor(private readonly config: AppConfig) {}

  /** True when addresses can be sealed and hashed (both keys present). */
  get configured(): boolean {
    return !!this.config.values.MESSAGING_ENCRYPTION_KEY && !!this.config.values.MESSAGING_HASH_KEY;
  }

  seal(plaintext: string): string {
    const key = this.config.values.MESSAGING_ENCRYPTION_KEY;
    if (!key) throw new Error('MESSAGING_ENCRYPTION_KEY is not set');
    return sealSecret(plaintext, key);
  }

  open(sealed: string): string {
    const key = this.config.values.MESSAGING_ENCRYPTION_KEY;
    if (!key) throw new Error('MESSAGING_ENCRYPTION_KEY is not set');
    return openSecret(sealed, key);
  }

  /** Keyed hash of a normalised address (hex, 64 chars). */
  hash(kind: AddressKind, normalised: string): string {
    const key = this.config.values.MESSAGING_HASH_KEY;
    if (!key) throw new Error('MESSAGING_HASH_KEY is not set');
    return createHmac('sha256', key).update(`${kind}:${normalised}`).digest('hex');
  }

  /**
   * Hash for contact rows. Without MESSAGING_HASH_KEY (development only) a plain SHA-256 keyed by a
   * fixed label is used so verification still works locally; production always has the key.
   */
  contactHash(kind: AddressKind, normalised: string): string {
    if (this.config.values.MESSAGING_HASH_KEY) return this.hash(kind, normalised);
    return createHmac('sha256', 'ngao360-dev-contact-hash').update(`${kind}:${normalised}`).digest('hex');
  }
}
