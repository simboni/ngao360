/**
 * Offline queue (blueprint 13.4; contract §22): idempotent replay, backoff,
 * conflicts, rejected items, encryption at rest and sign-out.
 * Uses the in-memory storage adapter and a fake transport; real WebCrypto.
 * Run with: pnpm --filter @ngao360/web test. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { SyncItem, SyncItemResult, SyncResponse } from '@ngao360/shared';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelayMs } from '@/lib/offline/backoff';
import { classifyError, countEntries, OfflineQueue, QueueValidationError, type QueueTransport } from '@/lib/offline/queue';
import { MemoryQueueStorage } from '@/lib/offline/storage';

const CYCLE = '00000000-0000-4000-8000-0000000000c1';
const DEPLOYMENT = '00000000-0000-4000-8000-0000000000d1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const RESULT = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEVICE = 'device-synthetic-0001';

class Clock {
  t = Date.parse('2027-08-09T06:00:00.000Z');
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}

type Handler = (items: SyncItem[]) => SyncResponse | Promise<SyncResponse>;

class FakeTransport implements QueueTransport {
  calls: SyncItem[][] = [];
  uploads: string[] = [];
  attaches: { reportId: string; fileIds: string[] }[] = [];
  handler: Handler = (items) => ({ results: items.map((i) => accepted(i)), serverTime: new Date().toISOString() });
  uploadFails: Error | null = null;
  async sync(items: SyncItem[]): Promise<SyncResponse> {
    this.calls.push(JSON.parse(JSON.stringify(items)) as SyncItem[]);
    return this.handler(items);
  }
  async uploadEvidence(file: Blob): Promise<{ fileId: string }> {
    if (this.uploadFails) throw this.uploadFails;
    this.uploads.push(String(file.size));
    return { fileId: RESULT(900 + this.uploads.length) };
  }
  async attachReportEvidence(reportId: string, fileIds: string[]): Promise<void> {
    this.attaches.push({ reportId, fileIds });
  }
}

let resultSeq = 1;
function accepted(i: SyncItem, replayed = false): SyncItemResult {
  return {
    idempotencyKey: i.idempotencyKey,
    kind: i.kind,
    outcome: 'ACCEPTED',
    replayed,
    resultType: i.kind,
    resultId: RESULT(resultSeq++),
    reference: i.kind === 'INCIDENT' ? 'INC-2027-000101' : i.kind === 'FIELD_REPORT' ? 'FRP-2027-000201' : null,
    errorCode: null,
    message: null,
    serverState: null,
  };
}

function checkInInput(version = 2) {
  return {
    kind: 'CHECK_IN' as const,
    targetId: DEPLOYMENT,
    summary: 'Check-in · Synthetic Primary School (039001000101)',
    payload: { deploymentId: DEPLOYMENT, expectedVersion: version, checkedInAt: '2027-08-09T05:55:00.000Z', location: null },
  };
}

function incidentInput(photos = 0) {
  return {
    kind: 'INCIDENT' as const,
    summary: 'Opening or closing time · Synthetic Primary School',
    payload: {
      electionCycleId: CYCLE,
      category: 'OPENING_OR_CLOSING_TIME',
      occurredAt: '2027-08-09T05:50:00.000Z',
      location: { pollingStationCode: '039001000101', geographicUnitId: null },
      locationDescription: null,
      description: 'The station opened 40 minutes after the published time; voters waited outside.',
      point: null,
      privacyWarningAcknowledged: true,
    },
    attachments: Array.from({ length: photos }, (_, n) => ({ bytes: new Uint8Array([0xff, 0xd8, n, 1, 2, 3]).buffer, mimeType: 'image/jpeg' })),
  };
}

function reportInput(photos = 0) {
  return {
    kind: 'FIELD_REPORT' as const,
    summary: 'Opening of polls · Synthetic Primary School',
    payload: {
      templateId: TEMPLATE,
      electionCycleId: CYCLE,
      location: { pollingStationCode: '039001000101', geographicUnitId: null },
      eventAt: '2027-08-09T05:58:00.000Z',
      answers: { opened_on_time: false, opening_time: '06:40' },
      notes: null,
      point: null,
      supersedesReportId: null,
    },
    attachments: Array.from({ length: photos }, () => ({ bytes: new Uint8Array([1, 2, 3, 4]).buffer, mimeType: 'image/jpeg' })),
  };
}

describe('offline queue', () => {
  let storage: MemoryQueueStorage;
  let clock: Clock;
  let transport: FakeTransport;
  let online: boolean;
  let queue: OfflineQueue;

  beforeEach(async () => {
    storage = new MemoryQueueStorage();
    clock = new Clock();
    transport = new FakeTransport();
    online = false;
    queue = await OfflineQueue.open({ storage, deviceId: DEVICE, now: clock.now, random: () => 1, isOnline: () => online });
  });

  it('generates the idempotency key and offline metadata when the record is first saved', async () => {
    const e = await queue.enqueue(checkInInput());
    assert.equal(e.state, 'SAVED_LOCALLY');
    const payload = await queue.readPayload(e.idempotencyKey);
    assert.equal(payload?.clientIdempotencyKey, e.idempotencyKey);
    assert.equal(payload?.deviceId, DEVICE);
    assert.equal(payload?.clientCreatedAt, clock.now().toISOString());
    assert.equal(payload?.submittedOffline, true, 'saved while offline');
  });

  it('refuses an incomplete record at save time instead of blocking a batch later', async () => {
    await assert.rejects(
      () => queue.enqueue({ ...incidentInput(), payload: { ...incidentInput().payload, description: 'short' } }),
      (err: unknown) => err instanceof QueueValidationError && err.issues.some((i) => i.path.includes('description')),
    );
    assert.equal((await queue.counts()).pending, 0);
  });

  it('stores payloads encrypted: no plaintext in the stored record', async () => {
    const e = await queue.enqueue(incidentInput(1));
    const raw = await storage.get(e.idempotencyKey);
    const asText = JSON.stringify(raw, (_k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    assert.ok(!asText.includes('voters waited'), 'description must not be stored in clear');
    assert.ok(!asText.includes('039001000101'), 'station code must not be stored in clear');
    assert.ok(raw?.sealed && raw.sealed.iv.byteLength === 12);
    const key = await storage.getMeta<CryptoKey>('queueKey');
    assert.equal(key?.extractable, false, 'queue key is non-extractable');
  });

  it('replays with the same key and identical payload after a lost response, and confirms once', async () => {
    const e = await queue.enqueue(incidentInput());
    // First attempt: the request reaches the server but the response is lost.
    transport.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    online = true;
    const first = await queue.sync(transport);
    assert.equal(first.retrying, 1);
    let [view] = await queue.list();
    assert.equal(view?.state, 'SAVED_LOCALLY');
    assert.equal(view?.retryCount, 1);

    // Second attempt after the backoff: the server answers with the original result.
    transport.handler = (items) => ({ results: items.map((i) => accepted(i, true)), serverTime: clock.now().toISOString() });
    clock.advance(BACKOFF_MAX_MS);
    const second = await queue.sync(transport);
    assert.equal(second.accepted, 1);
    assert.equal(second.replayed, 1);

    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]![0]!.idempotencyKey, e.idempotencyKey);
    assert.equal(transport.calls[1]![0]!.idempotencyKey, e.idempotencyKey);
    assert.deepEqual(transport.calls[0], transport.calls[1], 'byte-identical item on retry (same server hash)');

    [view] = await queue.list();
    assert.equal(view?.state, 'CONFIRMED');
    assert.equal(view?.replayed, true);
    assert.equal(view?.serverReference, 'INC-2027-000101');
    assert.equal(await queue.readPayload(e.idempotencyKey), null, 'payload deleted after confirmation');

    await queue.sync(transport);
    assert.equal(transport.calls.length, 2, 'confirmed items are never sent again');
  });

  it('backs off exponentially and does not retry before the item is due', async () => {
    await queue.enqueue(checkInInput());
    online = true;
    transport.handler = () => {
      throw new HttpError(503, 'INTERNAL');
    };
    await queue.sync(transport);
    let [view] = await queue.list();
    assert.equal(view?.retryCount, 1);
    assert.equal(Date.parse(view!.nextAttemptAt!) - clock.t, BACKOFF_BASE_MS);

    await queue.sync(transport);
    assert.equal(transport.calls.length, 1, 'not due yet');

    clock.advance(BACKOFF_BASE_MS);
    await queue.sync(transport);
    [view] = await queue.list();
    assert.equal(view?.retryCount, 2);
    assert.equal(Date.parse(view!.nextAttemptAt!) - clock.t, BACKOFF_BASE_MS * 2);

    await queue.retryNow();
    await queue.sync(transport);
    assert.equal(transport.calls.length, 3, '"Try now" clears the wait');
  });

  it('backoff delay doubles, has jitter between half and the full step, and is capped', () => {
    assert.equal(backoffDelayMs(1, () => 1), BACKOFF_BASE_MS);
    assert.equal(backoffDelayMs(1, () => 0), BACKOFF_BASE_MS / 2);
    assert.equal(backoffDelayMs(3, () => 1), BACKOFF_BASE_MS * 4);
    assert.equal(backoffDelayMs(50, () => 1), BACKOFF_MAX_MS);
    for (let n = 1; n < 12; n++) assert.ok(backoffDelayMs(n + 1, () => 1) >= backoffDelayMs(n, () => 1));
  });

  it('keeps a conflict for the person, with the server state, and never resends it automatically', async () => {
    const e = await queue.enqueue(checkInInput(2));
    online = true;
    transport.handler = (items) => ({
      results: items.map((i) => ({
        ...accepted(i),
        outcome: 'CONFLICT' as const,
        resultId: null,
        reference: null,
        errorCode: 'SERVER_CHANGED',
        message: 'The assignment changed',
        serverState: { id: DEPLOYMENT, status: 'CONFIRMED', version: 3 },
      })),
      serverTime: clock.now().toISOString(),
    });
    const run = await queue.sync(transport);
    assert.equal(run.conflicts, 1);
    const [view] = await queue.list();
    assert.equal(view?.state, 'CONFLICT');
    assert.equal(view?.errorCode, 'SERVER_CHANGED');
    assert.deepEqual(await queue.readServerState(e.idempotencyKey), { id: DEPLOYMENT, status: 'CONFIRMED', version: 3 });
    assert.equal(await queue.hasPendingFor('CHECK_IN', DEPLOYMENT), true, 'a second check-in tap stays blocked');

    clock.advance(BACKOFF_MAX_MS);
    await queue.sync(transport, { force: true });
    assert.equal(transport.calls.length, 1, 'conflicts are not retried');
    assert.deepEqual(countEntries((await queue.list()).map((v) => ({ state: v.state, retryCount: v.retryCount }))), {
      pending: 0,
      retrying: 0,
      sent: 0,
      failed: 0,
      conflict: 1,
    });
  });

  it('resolves a conflict only as a new record with a new key and the reviewed version', async () => {
    const e = await queue.enqueue(checkInInput(2));
    online = true;
    transport.handler = (items) => ({
      results: items.map((i) => ({ ...accepted(i), outcome: 'CONFLICT' as const, errorCode: 'SERVER_CHANGED', serverState: { status: 'CONFIRMED', version: 3 } })),
      serverTime: clock.now().toISOString(),
    });
    await queue.sync(transport);
    clock.advance(60_000);
    const fresh = await queue.resubmitAsNew(e.idempotencyKey, { expectedVersion: 3 });
    assert.notEqual(fresh.idempotencyKey, e.idempotencyKey);
    const payload = await queue.readPayload(fresh.idempotencyKey);
    assert.equal(payload?.clientIdempotencyKey, fresh.idempotencyKey);
    assert.equal(payload?.expectedVersion, 3);
    assert.equal(payload?.checkedInAt, '2027-08-09T05:55:00.000Z', 'device time of the check-in is kept');
    assert.equal(await queue.readPayload(e.idempotencyKey), null, 'old conflict removed');

    transport.handler = (items) => ({ results: items.map((i) => accepted(i)), serverTime: clock.now().toISOString() });
    await queue.sync(transport);
    assert.equal(transport.calls[1]![0]!.idempotencyKey, fresh.idempotencyKey);
    assert.equal((await queue.counts()).sent, 1);
  });

  it('only a conflict can be resubmitted; discarding removes the local copy only', async () => {
    const e = await queue.enqueue(checkInInput());
    await assert.rejects(() => queue.resubmitAsNew(e.idempotencyKey));
    await queue.discard(e.idempotencyKey);
    assert.equal((await queue.list()).length, 0);
    assert.equal(transport.calls.length, 0);
  });

  it('keeps a rejected item until the person has read it', async () => {
    const e = await queue.enqueue(incidentInput());
    online = true;
    transport.handler = (items) => ({
      results: items.map((i) => ({ ...accepted(i), outcome: 'REJECTED' as const, resultId: null, reference: null, errorCode: 'OUT_OF_SCOPE', message: 'Not your station' })),
      serverTime: clock.now().toISOString(),
    });
    await queue.sync(transport);
    const [view] = await queue.list();
    assert.equal(view?.state, 'REJECTED');
    assert.equal(view?.errorCode, 'OUT_OF_SCOPE');
    assert.ok(await queue.readPayload(e.idempotencyKey), 'kept so the person can read what was refused');
    await queue.acknowledge(e.idempotencyKey);
    assert.equal((await queue.list()).length, 0);
  });

  it('retries transient per-item refusals instead of dropping them', async () => {
    await queue.enqueue(checkInInput());
    online = true;
    transport.handler = (items) => ({
      results: items.map((i) => ({ ...accepted(i), outcome: 'REJECTED' as const, errorCode: 'INTERNAL', message: 'Temporary' })),
      serverTime: clock.now().toISOString(),
    });
    await queue.sync(transport);
    const [view] = await queue.list();
    assert.equal(view?.state, 'SAVED_LOCALLY');
    assert.equal(view?.retryCount, 1);
  });

  it('isolates a malformed item when the server refuses the whole batch', async () => {
    const good = await queue.enqueue(checkInInput());
    const bad = await queue.enqueue(incidentInput());
    online = true;
    transport.handler = (items) => {
      if (items.some((i) => i.idempotencyKey === bad.idempotencyKey)) throw new HttpError(400, 'VALIDATION_FAILED', 'Malformed batch');
      return { results: items.map((i) => accepted(i)), serverTime: clock.now().toISOString() };
    };
    await queue.sync(transport);
    const byKey = new Map((await queue.list()).map((v) => [v.idempotencyKey, v]));
    assert.equal(byKey.get(good.idempotencyKey)?.state, 'CONFIRMED');
    assert.equal(byKey.get(bad.idempotencyKey)?.state, 'REJECTED');
  });

  it('stops on an expired session and keeps items for after sign-in', async () => {
    await queue.enqueue(checkInInput());
    await queue.enqueue(incidentInput());
    online = true;
    transport.handler = () => {
      throw new HttpError(401, 'UNAUTHENTICATED');
    };
    const run = await queue.sync(transport);
    assert.equal(run.authRequired, true);
    const views = await queue.list();
    assert.ok(views.every((v) => v.state === 'SAVED_LOCALLY' && v.errorCode === 'UNAUTHENTICATED'));
  });

  it('uploads incident photos once, then sends their file ids in the incident', async () => {
    await queue.enqueue(incidentInput(2));
    online = true;
    transport.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await queue.sync(transport);
    assert.equal(transport.uploads.length, 2);
    clock.advance(BACKOFF_MAX_MS);
    transport.handler = (items) => ({ results: items.map((i) => accepted(i)), serverTime: clock.now().toISOString() });
    await queue.sync(transport);
    assert.equal(transport.uploads.length, 2, 'photos are not uploaded again on retry');
    const sent = transport.calls[1]![0]!;
    assert.equal(sent.kind, 'INCIDENT');
    assert.deepEqual((sent.payload as { evidenceFileIds: string[] }).evidenceFileIds, [RESULT(901), RESULT(902)]);
    assert.deepEqual(transport.calls[0], transport.calls[1], 'same file ids, same payload on retry');
  });

  it('a photo that the server refuses can be dropped and the record sent without it', async () => {
    const e = await queue.enqueue(incidentInput(1));
    online = true;
    transport.uploadFails = new HttpError(400, 'VALIDATION_FAILED', 'Not an image');
    await queue.sync(transport);
    let [view] = await queue.list();
    assert.equal(view?.state, 'REJECTED');
    assert.equal(view?.errorCode, 'ATTACHMENT_FAILED');
    await queue.dropAttachmentsAndRetry(e.idempotencyKey);
    await queue.sync(transport);
    [view] = await queue.list();
    assert.equal(view?.state, 'CONFIRMED');
    assert.equal(view?.idempotencyKey, e.idempotencyKey, 'same key: the record was never sent before');
  });

  it('attaches field-report photos to the accepted report, then confirms', async () => {
    await queue.enqueue(reportInput(1));
    online = true;
    await queue.sync(transport);
    assert.equal(transport.attaches.length, 1);
    const [view] = await queue.list();
    assert.equal(view?.state, 'CONFIRMED');
    assert.equal(transport.attaches[0]!.reportId, view?.serverResultId);
    assert.equal(transport.calls[0]![0]!.kind, 'FIELD_REPORT');
    assert.ok(!('evidenceFileIds' in (transport.calls[0]![0]!.payload as object)), 'report body carries no file ids');
  });

  it('sends at most 50 items per batch', async () => {
    for (let n = 0; n < 53; n++) await queue.enqueue(checkInInput());
    online = true;
    await queue.sync(transport);
    assert.deepEqual(transport.calls.map((c) => c.length), [50, 3]);
  });

  it('single-flight: concurrent sync calls share one run', async () => {
    await queue.enqueue(checkInInput());
    online = true;
    const [a, b] = await Promise.all([queue.sync(transport), queue.sync(transport)]);
    assert.equal(a, b);
    assert.equal(transport.calls.length, 1);
  });

  it('an item left uploading by a crash goes back to waiting when the queue reopens', async () => {
    const e = await queue.enqueue(checkInInput());
    const raw = await storage.get(e.idempotencyKey);
    await storage.put({ ...raw!, state: 'UPLOADING' });
    const reopened = await OfflineQueue.open({ storage, deviceId: DEVICE, now: clock.now, random: () => 1 });
    const [view] = await reopened.list();
    assert.equal(view?.state, 'SAVED_LOCALLY');
  });

  it('removes confirmed receipts after a day', async () => {
    await queue.enqueue(checkInInput());
    online = true;
    await queue.sync(transport);
    assert.equal((await queue.counts()).sent, 1);
    clock.advance(25 * 60 * 60_000);
    const reopened = await OfflineQueue.open({ storage, deviceId: DEVICE, now: clock.now });
    assert.equal((await reopened.counts()).sent, 0);
  });

  it('sign-out destroys every record and the key', async () => {
    await queue.enqueue(incidentInput(1));
    await queue.putSecret('fieldMe', { agent: { displayName: 'Synthetic Agent' } });
    await queue.destroy();
    assert.equal(storage.destroyed, true);
    assert.equal((await storage.getAll()).length, 0);
    assert.equal(await storage.getMeta('queueKey'), undefined);
  });

  it('encrypted cache values round-trip', async () => {
    await queue.putSecret('template:x', { name: 'Opening of polls' });
    assert.deepEqual(await queue.getSecret('template:x'), { name: 'Opening of polls' });
    assert.equal(await queue.getSecret('missing'), null);
  });
});

describe('error classification', () => {
  it('sorts errors into retry, sign-in and give-up', () => {
    assert.equal(classifyError(new TypeError('Failed to fetch')).kind, 'transient');
    assert.equal(classifyError(new HttpError(503, 'INTERNAL')).kind, 'transient');
    assert.equal(classifyError(new HttpError(429, 'RATE_LIMITED')).kind, 'transient');
    assert.equal(classifyError(new HttpError(403, 'MODULE_DISABLED')).kind, 'transient');
    assert.equal(classifyError(new HttpError(401, 'UNAUTHENTICATED')).kind, 'auth');
    assert.equal(classifyError(new HttpError(403, 'OUT_OF_SCOPE')).kind, 'permanent');
    assert.equal(classifyError(new HttpError(400, 'VALIDATION_FAILED')).kind, 'permanent');
  });
});
