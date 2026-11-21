/**
 * PIN-wrapped offline queue key (API contract §36): wrapping, unlock, attempt
 * limits with delays and lock-out, erase only on confirmed counts, PIN change,
 * forgotten-PIN reset and migration of queues created before the PIN.
 * IndexedDB is fake-indexeddb; WebCrypto is Node's. All data is synthetic.
 * Run with: pnpm --filter @ngao360/web test.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { SyncItem, SyncResponse } from '@ngao360/shared';
import { generateQueueKey, PIN_KDF_ITERATIONS, unwrapQueueKey, type WrappedQueueKey } from '@/lib/offline/crypto';
import {
  checkNewPin,
  LEGACY_KEY_META,
  PIN_ATTEMPTS_META,
  PIN_MAX_ATTEMPTS,
  pinDelayMs,
  PinError,
  type PinAttempts,
  QueueKeyVault,
  WRAPPED_KEY_META,
} from '@/lib/offline/pin';
import { type EnqueueInput, OfflineQueue, type QueueTransport } from '@/lib/offline/queue';
import { IndexedDbQueueStorage, MemoryQueueStorage, type QueueStorage } from '@/lib/offline/storage';

const DEVICE = 'device-pin-test-0001';
const PIN = '583920';
const OTHER_PIN = '274618';
/** Fast KDF for tests; the default (600 000) is checked once below. */
const ITER = 1_000;

class Clock {
  t = Date.parse('2027-08-09T07:00:00.000Z');
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

let dbSeq = 0;
async function freshStorage(): Promise<{ storage: IndexedDbQueueStorage; name: string }> {
  const name = `ngao360-field-pin-test-${process.pid}-${++dbSeq}`;
  return { storage: await IndexedDbQueueStorage.open(name), name };
}

function incident(n = 1): EnqueueInput {
  return {
    kind: 'INCIDENT',
    summary: `Incident ${n} · Synthetic Primary School`,
    payload: {
      electionCycleId: '00000000-0000-4000-8000-0000000000c1',
      category: 'OPENING_OR_CLOSING_TIME',
      occurredAt: '2027-08-09T05:50:00.000Z',
      location: { pollingStationCode: '039001000101', geographicUnitId: null },
      locationDescription: null,
      description: `Synthetic note ${n}: the station opened late and voters waited outside.`,
      point: null,
      privacyWarningAcknowledged: true,
    },
    attachments: [{ bytes: new Uint8Array([0xff, 0xd8, n, 1, 2, 3]).buffer, mimeType: 'image/jpeg' }],
  };
}

const transport: QueueTransport = {
  async sync(items: SyncItem[]): Promise<SyncResponse> {
    return {
      results: items.map((i) => ({ idempotencyKey: i.idempotencyKey, kind: i.kind, outcome: 'ACCEPTED', resultId: crypto.randomUUID(), reference: 'INC-2027-000001', replayed: false })),
      serverTime: new Date().toISOString(),
    } as SyncResponse;
  },
  async uploadEvidence() {
    return { fileId: crypto.randomUUID() };
  },
  async attachReportEvidence() {},
};

function rawText(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof ArrayBuffer || x instanceof Uint8Array ? Buffer.from(x as ArrayBuffer).toString('latin1') : x));
}

describe('PIN rules', () => {
  it('needs 6 to 12 digits, no single repeated digit, no plain sequence, and a matching repeat', () => {
    assert.equal(checkNewPin('583920'), null);
    assert.equal(checkNewPin('58392017'), null);
    assert.match(checkNewPin('58392') ?? '', /at least 6/);
    assert.match(checkNewPin('1234567890123') ?? '', /at most 12/);
    assert.match(checkNewPin('58a920') ?? '', /digits only/);
    assert.match(checkNewPin('000000') ?? '', /repeat/);
    assert.match(checkNewPin('123456') ?? '', /sequence/);
    assert.match(checkNewPin('987654') ?? '', /sequence/);
    assert.match(checkNewPin('890123') ?? '', /sequence/, 'wrapping sequences too');
    assert.match(checkNewPin('583920', '583921') ?? '', /not the same/);
  });

  it('waits nothing for the first failures, then doubles from 30 s up to 30 min', () => {
    assert.deepEqual([0, 1, 2].map(pinDelayMs), [0, 0, 0]);
    assert.equal(pinDelayMs(3), 30_000);
    assert.equal(pinDelayMs(4), 60_000);
    assert.equal(pinDelayMs(5), 120_000);
    assert.equal(pinDelayMs(9), 30 * 60_000);
    assert.equal(pinDelayMs(50), 30 * 60_000);
  });
});

describe('PIN-wrapped queue key', () => {
  let clock: Clock;
  let storage: IndexedDbQueueStorage;
  let name: string;
  let vault: QueueKeyVault;

  beforeEach(async () => {
    clock = new Clock();
    ({ storage, name } = await freshStorage());
    vault = new QueueKeyVault({ storage, binding: name, now: clock.now, iterations: ITER });
  });

  it('stores only the wrapped key and salt (600 000 PBKDF2 iterations by default), never the queue key', async () => {
    assert.deepEqual(await vault.status(), { state: 'NEW', unsent: 0 });
    const real = new QueueKeyVault({ storage, binding: name, now: clock.now });
    const key = await real.create(PIN);
    assert.equal(key.extractable, false, 'the key in memory is non-extractable');
    const record = await storage.getMeta<WrappedQueueKey>(WRAPPED_KEY_META);
    assert.equal(record?.iterations, PIN_KDF_ITERATIONS);
    assert.equal(PIN_KDF_ITERATIONS, 600_000);
    assert.equal(record?.salt.byteLength, 16);
    assert.equal(record?.kdf, 'PBKDF2-SHA-256');
    for (const k of await storage.metaKeys()) {
      const v = await storage.getMeta<unknown>(k);
      assert.ok(!(v instanceof CryptoKey), `meta ${k} must not be a stored CryptoKey`);
    }
    assert.equal(await storage.getMeta(LEGACY_KEY_META), undefined);
    const s = await real.status();
    assert.equal(s.state, 'LOCKED');
  });

  it('opens the queue only with the right PIN; records saved before are readable again after unlock', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    const e = await q.enqueue(incident(1));
    await q.putSecret('session', { displayName: 'Synthetic Agent' });
    await q.lock();
    assert.ok(!rawText(await storage.getAll()).includes('voters waited'));

    await assert.rejects(() => vault.unlock(OTHER_PIN), (err: unknown) => err instanceof PinError && err.code === 'WRONG_PIN' && err.details.remaining === PIN_MAX_ATTEMPTS - 1);
    const again = await vault.unlock(PIN);
    const reopened = await OfflineQueue.open({ storage, key: again, deviceId: DEVICE, now: clock.now });
    assert.equal((await reopened.readPayload(e.idempotencyKey))?.description, incident(1).payload.description);
    assert.deepEqual(await reopened.getSecret('session'), { displayName: 'Synthetic Agent' });
    assert.equal((await vault.attempts()).failures, 0, 'a right PIN clears the failures');
  });

  it('binds the wrapped key to its database: copied into another queue it does not open', async () => {
    await vault.create(PIN);
    const record = (await storage.getMeta<WrappedQueueKey>(WRAPPED_KEY_META))!;
    await assert.rejects(() => unwrapQueueKey(record, PIN, 'ngao360-field-other-tenant-other-user'));
    await unwrapQueueKey(record, PIN, name);
  });

  it('counts an attempt before checking it, so closing the app during the check still counts', async () => {
    await vault.create(PIN);
    const writes: PinAttempts[] = [];
    const spy: QueueStorage = Object.create(storage) as QueueStorage;
    spy.putMeta = async (k: string, v: unknown) => {
      if (k === PIN_ATTEMPTS_META) writes.push({ ...(v as PinAttempts) });
      return storage.putMeta(k, v);
    };
    const spyVault = new QueueKeyVault({ storage: spy, binding: name, now: clock.now, iterations: ITER });
    await spyVault.unlock(PIN);
    assert.deepEqual(
      writes.map((w) => w.failures),
      [1, 0],
      'counted first, cleared after the right PIN',
    );
  });

  it('delays after repeated wrong PINs, warns, locks out after 10 and never deletes items on its own', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    await q.enqueue(incident(1));
    await q.enqueue(incident(2));
    await q.lock();

    for (let i = 1; i <= 3; i++) await assert.rejects(() => vault.unlock(OTHER_PIN), { code: 'WRONG_PIN' });
    let s = await vault.status();
    assert.equal(s.state, 'LOCKED');
    assert.ok(s.state === 'LOCKED' && s.retryAt && s.remaining === 7);
    await assert.rejects(() => vault.unlock(PIN), (err: unknown) => err instanceof PinError && err.code === 'TOO_SOON' && Boolean(err.details.retryAt));

    for (let i = 4; i <= PIN_MAX_ATTEMPTS; i++) {
      clock.advance(pinDelayMs(i - 1));
      await assert.rejects(() => vault.unlock(OTHER_PIN), { code: i === PIN_MAX_ATTEMPTS ? 'LOCKED_OUT' : 'WRONG_PIN' });
    }
    s = await vault.status();
    assert.deepEqual(s, { state: 'LOCKED_OUT', unsent: 2 });
    clock.advance(24 * 60 * 60_000);
    await assert.rejects(() => vault.unlock(PIN), { code: 'LOCKED_OUT' }, 'even the right PIN is refused after lock-out');
    assert.equal((await storage.getAll()).length, 2, 'nothing deleted without confirmation');
    assert.ok(await storage.getMeta(WRAPPED_KEY_META), 'items stay encrypted, not destroyed');
  });

  it('a clock set back does not shorten the wait', async () => {
    await vault.create(PIN);
    for (let i = 1; i <= 3; i++) await assert.rejects(() => vault.unlock(OTHER_PIN), { code: 'WRONG_PIN' });
    clock.advance(-60 * 60_000);
    await assert.rejects(() => vault.unlock(PIN), { code: 'TOO_SOON' });
  });

  it('erases only when the person confirms the current number of unsent items', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now, isOnline: () => true });
    await q.enqueue(incident(1));
    await q.sync(transport);
    await q.enqueue(incident(2));
    await q.enqueue(incident(3));
    assert.equal(await vault.unsentCount(), 2, 'the confirmed receipt is not counted as unsent');
    await assert.rejects(() => vault.erase(1), (err: unknown) => err instanceof PinError && err.code === 'COUNT_CHANGED' && err.details.unsent === 2);
    assert.equal((await storage.getAll()).length, 3);
    await vault.erase(2);
    assert.equal((await storage.getAll()).length, 0);
    assert.deepEqual(await vault.status(), { state: 'NEW', unsent: 0 });
  });

  it('forgotten PIN: an erase with a new PIN starts a fresh queue under the new PIN', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    await q.enqueue(incident(1));
    const fresh = await vault.erase(1, OTHER_PIN);
    assert.ok(fresh);
    const q2 = await OfflineQueue.open({ storage, key: fresh!, deviceId: DEVICE, now: clock.now });
    assert.equal((await q2.list()).length, 0);
    await assert.rejects(() => vault.unlock(PIN), { code: 'WRONG_PIN' });
    await vault.unlock(OTHER_PIN);
  });

  it('changes the PIN after checking the current one; the queue key and records stay the same', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    const e = await q.enqueue(incident(1));
    await assert.rejects(() => vault.changePin(OTHER_PIN, '615243'), { code: 'WRONG_PIN' });
    assert.equal((await vault.attempts()).failures, 1, 'a wrong current PIN counts like an unlock');
    await assert.rejects(() => vault.changePin(PIN, '111111'), { code: 'WEAK_PIN' });
    const changed = await vault.changePin(PIN, '615243');
    assert.equal(changed.extractable, false);
    await assert.rejects(() => vault.unlock(PIN), { code: 'WRONG_PIN' });
    const k = await vault.unlock('615243');
    const q2 = await OfflineQueue.open({ storage, key: k, deviceId: DEVICE, now: clock.now });
    assert.equal((await q2.readPayload(e.idempotencyKey))?.description, incident(1).payload.description);
  });

  it('refuses a weak PIN and a second create', async () => {
    await assert.rejects(() => vault.create('123456'), { code: 'WEAK_PIN' });
    await vault.create(PIN);
    await assert.rejects(() => vault.create(OTHER_PIN), { code: 'WRONG_STATE' });
  });

  it('sign-out still deletes the database with the wrapped key', async () => {
    const key = await vault.create(PIN);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    await q.enqueue(incident(1));
    await q.destroy();
    const names = (await indexedDB.databases()).map((d) => d.name);
    assert.ok(!names.includes(name));
  });
});

describe('migration of queues created before the PIN', () => {
  async function legacyQueue(storage: QueueStorage, clock: Clock) {
    const legacy = await generateQueueKey();
    await storage.putMeta(LEGACY_KEY_META, legacy);
    const q = await OfflineQueue.open({ storage, key: legacy, deviceId: DEVICE, now: clock.now });
    const a = await q.enqueue(incident(1));
    const b = await q.enqueue(incident(2));
    await q.putSecret('session', { displayName: 'Synthetic Agent' });
    return { legacy, keys: [a.idempotencyKey, b.idempotencyKey] };
  }

  for (const kind of ['memory', 'indexeddb'] as const) {
    it(`re-encrypts every record under the PIN-wrapped key, then deletes the old key (${kind})`, async (t) => {
      const clock = new Clock();
      let storage: QueueStorage;
      let name = 'ngao360-field-memory';
      if (kind === 'memory') storage = new MemoryQueueStorage();
      else {
        ({ storage, name } = await freshStorage());
        try {
          await storage.putMeta('probe', await generateQueueKey());
          await storage.deleteMeta('probe');
        } catch {
          t.skip('this IndexedDB cannot store a CryptoKey');
          return;
        }
      }
      const { legacy, keys } = await legacyQueue(storage, clock);
      const vault = new QueueKeyVault({ storage, binding: name, now: clock.now, iterations: ITER });
      assert.deepEqual(await vault.status(), { state: 'LEGACY', unsent: 2 });

      const key = await vault.migrate(PIN);
      assert.equal(await storage.getMeta(LEGACY_KEY_META), undefined, 'old key deleted');
      const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
      for (const k of keys) assert.ok((await q.readPayload(k))?.description);
      assert.deepEqual(await q.getSecret('session'), { displayName: 'Synthetic Agent' });
      const old = await OfflineQueue.open({ storage, key: legacy, deviceId: DEVICE, now: clock.now });
      await assert.rejects(() => old.readPayload(keys[0]!), 'the old key no longer opens anything');
      // Photos moved too: they upload under the new key.
      const run = await q.sync({ ...transport }, { force: true });
      assert.equal(run.rejected, 0);
    });
  }

  it('an interrupted migration resumes at the next unlock', async () => {
    const clock = new Clock();
    const storage = new MemoryQueueStorage();
    const { keys } = await legacyQueue(storage, clock);
    let puts = 0;
    const failing: QueueStorage = Object.create(storage) as QueueStorage;
    failing.put = async (e) => {
      if (++puts === 2) throw new Error('simulated crash');
      return storage.put(e);
    };
    const vault = new QueueKeyVault({ storage: failing, binding: 'db', now: clock.now, iterations: ITER });
    await assert.rejects(() => vault.migrate(PIN), /simulated crash/);
    assert.ok(await storage.getMeta(LEGACY_KEY_META), 'old key kept while records remain under it');
    const after = new QueueKeyVault({ storage, binding: 'db', now: clock.now, iterations: ITER });
    assert.equal((await after.status()).state, 'LOCKED');
    const key = await after.unlock(PIN);
    assert.equal(await storage.getMeta(LEGACY_KEY_META), undefined);
    const q = await OfflineQueue.open({ storage, key, deviceId: DEVICE, now: clock.now });
    for (const k of keys) assert.ok((await q.readPayload(k))?.description);
  });
});
