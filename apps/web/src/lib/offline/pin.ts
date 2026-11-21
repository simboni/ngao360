/**
 * Device PIN for the offline queue (API contract §36, blueprint 11.3 "device PIN").
 *
 * `QueueKeyVault` keeps the queue key wrapped under a PIN-derived key
 * (`crypto.ts`): only the wrapped key, its salt and the KDF parameters are
 * stored. The person sets a PIN of at least 6 digits the first time the field
 * app is opened with an online sign-in, and enters it each time the queue is
 * opened (online or offline) and after the app locked itself for inactivity.
 *
 * Wrong PINs:
 * - Every attempt is counted BEFORE the PIN is checked, so closing the app
 *   during the (deliberately slow) check still counts it.
 * - After `PIN_FREE_ATTEMPTS` failures each further attempt waits
 *   `pinDelayMs(failures)` (30 s doubling, capped at 30 min).
 * - The screens warn when `PIN_WARN_REMAINING` attempts are left.
 * - After `PIN_MAX_ATTEMPTS` failures the vault is LOCKED_OUT: no PIN is
 *   accepted any more. Nothing is deleted automatically: the person sees how
 *   many items have not been uploaded and must confirm that exact number to
 *   erase them (`erase`). Items stay encrypted until then.
 *
 * Forgotten PIN: there is no copy of the queue key anywhere else (no endpoint
 * holds one; docs/CHANGE_REQUESTS.md FP1), so items that were not uploaded
 * cannot be opened without the PIN. A reset is offered only after an online
 * re-authentication (the screens call POST /auth/reauth), shows the number of
 * items that would be lost, and erases only on explicit confirmation of that
 * number. Items that were uploaded are safe on the server.
 *
 * Migration: a queue created before the PIN existed has an unwrapped
 * non-extractable key (`LEGACY_KEY_META`). Setting a PIN creates a new
 * wrapped key, re-encrypts every sealed value under it, and only then deletes
 * the old key; an interrupted migration resumes at the next unlock.
 *
 * The attempt counter lives on the phone. It stops guessing through the app;
 * it does not stop someone who copies the browser profile from trying PINs
 * offline (crypto.ts explains the limits).
 */
import {
  AAD,
  openBytes,
  type Sealed,
  sealBytes,
  generateWrappableQueueKey,
  toNonExtractable,
  unwrapQueueKey,
  wrapQueueKey,
  type WrappedQueueKey,
} from './crypto';
import type { QueueStorage } from './storage';
import type { StoredEntry } from './types';

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;
/** Wrong PINs before the vault locks out for good (contract §36). */
export const PIN_MAX_ATTEMPTS = 10;
/** Failures allowed without a wait. */
export const PIN_FREE_ATTEMPTS = 3;
/** Warn when this many attempts (or fewer) are left. */
export const PIN_WARN_REMAINING = 3;
export const PIN_BASE_DELAY_MS = 30_000;
export const PIN_MAX_DELAY_MS = 30 * 60_000;
/** The unlocked queue locks itself after this long without a touch or key press. */
export const PIN_INACTIVITY_LOCK_MS = 5 * 60_000;

export const WRAPPED_KEY_META = 'wrappedQueueKey';
/** Where queues created before the PIN kept their unwrapped key. */
export const LEGACY_KEY_META = 'queueKey';
export const PIN_ATTEMPTS_META = 'pinAttempts';

export interface PinAttempts {
  failures: number;
  lastFailureAt: string | null;
  lockedOut: boolean;
}

const NO_ATTEMPTS: PinAttempts = { failures: 0, lastFailureAt: null, lockedOut: false };

export type VaultStatus =
  /** No key yet: set a PIN (needs an online sign-in). `unsent` > 0 only for records left without any key. */
  | { state: 'NEW'; unsent: number }
  /** A queue from before the PIN: set a PIN to protect it. */
  | { state: 'LEGACY'; unsent: number }
  /** Enter the PIN. `retryAt` is set while a wait after wrong PINs runs. */
  | { state: 'LOCKED'; failures: number; remaining: number; retryAt: string | null; unsent: number }
  /** Too many wrong PINs: only erasing (with confirmation) or an online reset remains. */
  | { state: 'LOCKED_OUT'; unsent: number };

export type PinErrorCode = 'WRONG_PIN' | 'TOO_SOON' | 'LOCKED_OUT' | 'WEAK_PIN' | 'WRONG_STATE' | 'COUNT_CHANGED';

export class PinError extends Error {
  constructor(
    readonly code: PinErrorCode,
    message: string,
    readonly details: { remaining?: number; retryAt?: string | null; unsent?: number } = {},
  ) {
    super(message);
    this.name = 'PinError';
  }
}

/* ---------------------------------- Rules ---------------------------------- */

/** Why a new PIN is not acceptable, or null. `confirm` is the repeated entry, when asked for. */
export function checkNewPin(pin: string, confirm?: string): string | null {
  if (!/^\d+$/.test(pin)) return 'Use digits only.';
  if (pin.length < PIN_MIN_LENGTH) return `Use at least ${PIN_MIN_LENGTH} digits.`;
  if (pin.length > PIN_MAX_LENGTH) return `Use at most ${PIN_MAX_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return 'Do not repeat one digit.';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => (d - digits[i]! + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return 'Do not use a sequence such as 123456.';
  if (confirm !== undefined && confirm !== pin) return 'The two PINs are not the same.';
  return null;
}

/** Wait before the next attempt after `failures` wrong PINs in a row. */
export function pinDelayMs(failures: number): number {
  if (failures < PIN_FREE_ATTEMPTS) return 0;
  return Math.min(PIN_MAX_DELAY_MS, PIN_BASE_DELAY_MS * 2 ** Math.min(failures - PIN_FREE_ATTEMPTS, 20));
}

/** Items not yet accepted by the server (waiting, refused, or needing a decision). Reads clear metadata only. */
export function unsentEntries(entries: Pick<StoredEntry, 'state'>[]): number {
  return entries.filter((e) => e.state !== 'CONFIRMED').length;
}

/* ---------------------------------- Vault ---------------------------------- */

export interface QueueKeyVaultOptions {
  storage: QueueStorage;
  /** Binds the wrapped key to its database (`queueDatabaseName`). */
  binding: string;
  now?: () => Date;
  /** PBKDF2 iterations for NEW wraps. Tests only; production uses PIN_KDF_ITERATIONS. */
  iterations?: number;
  /** Cross-tab mutual exclusion for the attempt counter (navigator.locks in the browser). */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class QueueKeyVault {
  private readonly now: () => Date;
  private readonly mutex: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(private readonly opts: QueueKeyVaultOptions) {
    this.now = opts.now ?? (() => new Date());
    this.mutex = opts.lock ?? ((fn) => fn());
  }

  private get storage(): QueueStorage {
    return this.opts.storage;
  }

  async unsentCount(): Promise<number> {
    return unsentEntries(await this.storage.getAll());
  }

  async attempts(): Promise<PinAttempts> {
    return (await this.storage.getMeta<PinAttempts>(PIN_ATTEMPTS_META)) ?? NO_ATTEMPTS;
  }

  /** When the next attempt is allowed (null = now). A clock set back before the last failure waits from that failure. */
  private retryAt(a: PinAttempts): string | null {
    const delay = pinDelayMs(a.failures);
    if (!delay || !a.lastFailureAt) return null;
    const at = Date.parse(a.lastFailureAt) + delay;
    return at > this.now().getTime() ? new Date(at).toISOString() : null;
  }

  async status(): Promise<VaultStatus> {
    const unsent = await this.unsentCount();
    const wrapped = await this.storage.getMeta<WrappedQueueKey>(WRAPPED_KEY_META);
    if (wrapped) {
      const a = await this.attempts();
      if (a.lockedOut) return { state: 'LOCKED_OUT', unsent };
      return { state: 'LOCKED', failures: a.failures, remaining: PIN_MAX_ATTEMPTS - a.failures, retryAt: this.retryAt(a), unsent };
    }
    if (await this.storage.getMeta<CryptoKey>(LEGACY_KEY_META)) return { state: 'LEGACY', unsent };
    return { state: 'NEW', unsent };
  }

  /** NEW: create the queue key under a PIN. Records left without any key are unreadable and are erased only when `confirmedUnsent` matches. */
  async create(pin: string, opts: { confirmedUnsent?: number } = {}): Promise<CryptoKey> {
    assertPin(pin);
    return this.mutex(async () => {
      const s = await this.status();
      if (s.state !== 'NEW') throw new PinError('WRONG_STATE', 'A PIN is already set on this phone.');
      if (s.unsent > 0) {
        if (opts.confirmedUnsent !== s.unsent) throw countChanged(s.unsent);
        await this.storage.clear();
      }
      return this.storeNewKey(pin);
    });
  }

  /** LEGACY: protect an existing queue with a PIN (re-encrypts every record, then deletes the old key). */
  async migrate(pin: string): Promise<CryptoKey> {
    assertPin(pin);
    const key = await this.mutex(async () => {
      const s = await this.status();
      if (s.state !== 'LEGACY') throw new PinError('WRONG_STATE', 'This queue is not waiting for a first PIN.');
      return this.storeNewKey(pin);
    });
    await this.finishMigration(key);
    return key;
  }

  /** LOCKED: open the queue. Wrong PINs are counted, delayed and finally locked out. */
  async unlock(pin: string): Promise<CryptoKey> {
    const key = await this.attempt(pin, false);
    await this.finishMigration(key);
    return key;
  }

  /** Change the PIN: the current PIN is checked (and counted) like an unlock; the queue key stays the same. */
  async changePin(currentPin: string, newPin: string): Promise<CryptoKey> {
    assertPin(newPin);
    const raw = await this.attempt(currentPin, true);
    const record = await wrapQueueKey(raw, newPin, this.opts.binding, { iterations: this.opts.iterations, now: this.now() });
    await this.mutex(() => this.storage.putMeta(WRAPPED_KEY_META, record));
    const key = await toNonExtractable(raw);
    await this.finishMigration(key);
    return key;
  }

  /**
   * Erase every record and the key on this phone (after LOCKED_OUT, or a
   * forgotten PIN once the person re-authenticated online). `confirmedUnsent`
   * must equal the number of unsent items now, so the person confirmed the
   * figure they were shown. With `newPin` a new key is created at once.
   */
  async erase(confirmedUnsent: number, newPin?: string): Promise<CryptoKey | null> {
    if (newPin !== undefined) assertPin(newPin);
    return this.mutex(async () => {
      const unsent = await this.unsentCount();
      if (confirmedUnsent !== unsent) throw countChanged(unsent);
      await this.storage.clear();
      return newPin === undefined ? null : this.storeNewKey(newPin);
    });
  }

  /* -------------------------------- Internals ------------------------------- */

  private async storeNewKey(pin: string): Promise<CryptoKey> {
    const raw = await generateWrappableQueueKey();
    const record = await wrapQueueKey(raw, pin, this.opts.binding, { iterations: this.opts.iterations, now: this.now() });
    await this.storage.putMeta(WRAPPED_KEY_META, record);
    await this.storage.putMeta(PIN_ATTEMPTS_META, NO_ATTEMPTS);
    return toNonExtractable(raw);
  }

  private async attempt(pin: string, extractable: boolean): Promise<CryptoKey> {
    return this.mutex(async () => {
      const record = await this.storage.getMeta<WrappedQueueKey>(WRAPPED_KEY_META);
      if (!record) throw new PinError('WRONG_STATE', 'No PIN is set on this phone.');
      const a = await this.attempts();
      if (a.lockedOut) throw lockedOut(await this.unsentCount());
      const retryAt = this.retryAt(a);
      if (retryAt) throw new PinError('TOO_SOON', 'Wait before trying again.', { retryAt, remaining: PIN_MAX_ATTEMPTS - a.failures });
      // Count first: an attempt abandoned during the slow check still counts.
      const failures = a.failures + 1;
      const counted: PinAttempts = { failures, lastFailureAt: this.now().toISOString(), lockedOut: failures >= PIN_MAX_ATTEMPTS };
      await this.storage.putMeta(PIN_ATTEMPTS_META, counted);
      let key: CryptoKey;
      try {
        key = await unwrapQueueKey(record, pin, this.opts.binding, extractable);
      } catch {
        if (counted.lockedOut) throw lockedOut(await this.unsentCount());
        throw new PinError('WRONG_PIN', 'Wrong PIN.', { remaining: PIN_MAX_ATTEMPTS - failures, retryAt: this.retryAt(counted) });
      }
      await this.storage.putMeta(PIN_ATTEMPTS_META, NO_ATTEMPTS);
      return key;
    });
  }

  /** Re-encrypt values still sealed under the legacy key, then delete it. Safe to repeat after an interruption. */
  private async finishMigration(key: CryptoKey): Promise<void> {
    const legacy = await this.storage.getMeta<CryptoKey>(LEGACY_KEY_META);
    if (!legacy) return;
    const reseal = async (sealed: Sealed | null, aad: string): Promise<Sealed | null> => {
      if (!sealed) return null;
      try {
        await openBytes(key, sealed, aad);
        return null; // already under the new key
      } catch {
        /* not yet migrated */
      }
      try {
        return await sealBytes(key, await openBytes(legacy, sealed, aad), aad);
      } catch {
        return null; // unreadable under either key: left as it is (shown as unreadable)
      }
    };
    for (const e of await this.storage.getAll()) {
      let changed = false;
      const next: StoredEntry = { ...e, attachments: [...e.attachments] };
      const body = await reseal(e.sealed, AAD.body(e.idempotencyKey));
      if (body) {
        next.sealed = body;
        changed = true;
      }
      const server = await reseal(e.serverState, AAD.server(e.idempotencyKey));
      if (server) {
        next.serverState = server;
        changed = true;
      }
      for (let i = 0; i < next.attachments.length; i++) {
        const a = next.attachments[i]!;
        const sealed = await reseal(a.sealed, AAD.attachment(e.idempotencyKey, a.id));
        if (sealed) {
          next.attachments[i] = { ...a, sealed };
          changed = true;
        }
      }
      if (changed) await this.storage.put(next);
    }
    for (const name of await this.storage.metaKeys()) {
      if (!name.startsWith('secret:')) continue;
      const sealed = await reseal((await this.storage.getMeta<Sealed>(name)) ?? null, AAD.meta(name.slice('secret:'.length)));
      if (sealed) await this.storage.putMeta(name, sealed);
    }
    await this.storage.deleteMeta(LEGACY_KEY_META);
  }
}

function assertPin(pin: string): void {
  const problem = checkNewPin(pin);
  if (problem) throw new PinError('WEAK_PIN', problem);
}

function lockedOut(unsent: number): PinError {
  return new PinError('LOCKED_OUT', `Too many wrong PINs. The items on this phone can no longer be opened with a PIN.`, { unsent, remaining: 0 });
}

function countChanged(unsent: number): PinError {
  return new PinError('COUNT_CHANGED', `The number of items not uploaded is now ${unsent}. Check it and confirm again.`, { unsent });
}
