/**
 * Offline queue for the field PWA (blueprint 11.3, 13.4; API contract §22).
 *
 * - The idempotency key is generated when the record is first saved here and
 *   reused on every retry; the server ledger records each key once, so a
 *   replay after a lost response is answered with the original result.
 * - Uploads go through `POST /field/sync` in batches of at most 50, with
 *   exponential backoff and jitter after network or server failures.
 * - Per-item states: SAVED_LOCALLY → UPLOADING → CONFIRMED, or REJECTED (the
 *   person reads and dismisses it) or CONFLICT (the person decides: discard,
 *   or submit again as a NEW record with a new key). Nothing is overwritten
 *   on the server and no conflict is resolved automatically.
 * - Payloads, photo bytes and conflict server state are encrypted at rest
 *   (`crypto.ts`); a confirmed item keeps only a receipt (reference and time)
 *   and its payload is deleted at once.
 * - The queue key comes from `QueueKeyVault` (`pin.ts`), unwrapped with the
 *   person's PIN. `lock()` drops it from memory; a locked queue refuses every
 *   operation that needs it (`QueueLockedError`) until it is opened again.
 */
import {
  SYNC_MAX_ITEMS,
  SyncItemSchema,
  type LocalQueueState,
  type SyncItem,
  type SyncItemResult,
  type SyncResponse,
} from '@ngao360/shared';
import { nextAttemptAt } from './backoff';
import { AAD, openBytes, openJson, sealBytes, sealJson } from './crypto';
import type { QueueStorage } from './storage';
import type { QueueCounts, QueueEntryView, QueueKind, SealedBody, StoredAttachment, StoredEntry } from './types';
import { uuidv4 } from './uuid';

/** Server calls the queue needs; `transport.ts` implements them with the API client. */
export interface QueueTransport {
  sync(items: SyncItem[]): Promise<SyncResponse>;
  /** POST /field/evidence (multipart `file`). */
  uploadEvidence(file: Blob, filename: string): Promise<{ fileId: string }>;
  /** POST /field/reports/:id/evidence. */
  attachReportEvidence(reportId: string, fileIds: string[]): Promise<void>;
}

export interface AttachmentInput {
  bytes: ArrayBuffer;
  mimeType: string;
}

/** Kinds whose payload carries OfflineMeta (clientIdempotencyKey, deviceId, clientCreatedAt, submittedOffline). */
const KINDS_WITH_META: ReadonlySet<QueueKind> = new Set(['FIELD_REPORT', 'INCIDENT', 'CHECK_IN', 'ASSIGNMENT_CONFIRMATION']);

/** Server answers that are worth retrying later with the same key. */
const TRANSIENT_CODES = new Set(['INTERNAL', 'RATE_LIMITED', 'MODULE_DISABLED', 'NETWORK']);

/** Receipts of confirmed items are kept this long, then removed. */
export const RECEIPT_TTL_MS = 24 * 60 * 60_000;

/** Local error codes (beside the server's ERROR_CODES and sync codes). */
export const LOCAL_ERROR_CODES = {
  NETWORK: 'NETWORK',
  NO_ANSWER: 'NO_ANSWER',
  ATTACHMENT_FAILED: 'ATTACHMENT_FAILED',
  EVIDENCE_NOT_ATTACHED: 'EVIDENCE_NOT_ATTACHED',
  UNREADABLE: 'UNREADABLE',
} as const;

export type ErrorClass = 'transient' | 'auth' | 'permanent';

export interface ClassifiedError {
  kind: ErrorClass;
  status: number | null;
  code: string;
  message: string;
}

/** Sort a thrown error into retry later / sign in again / give up. */
export function classifyError(err: unknown): ClassifiedError {
  const e = err as { status?: unknown; code?: unknown; message?: unknown; body?: { code?: unknown; message?: unknown } } | null;
  const status = typeof e?.status === 'number' ? e.status : null;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.body?.code === 'string' ? e.body.code : null;
  const message = typeof e?.message === 'string' && e.message ? e.message : 'Upload failed';
  if (status === null) return { kind: 'transient', status, code: code ?? LOCAL_ERROR_CODES.NETWORK, message: 'No connection to the server' };
  if (status === 401) return { kind: 'auth', status, code: code ?? 'UNAUTHENTICATED', message: 'Sign in again to upload' };
  if (status === 408 || status === 425 || status === 429 || status >= 500 || (code !== null && TRANSIENT_CODES.has(code))) {
    return { kind: 'transient', status, code: code ?? 'INTERNAL', message };
  }
  return { kind: 'permanent', status, code: code ?? 'VALIDATION_FAILED', message };
}

export interface SyncRunSummary {
  attempted: number;
  accepted: number;
  replayed: number;
  rejected: number;
  conflicts: number;
  retrying: number;
  /** The session expired: items wait until the person signs in again. */
  authRequired: boolean;
}

export interface OfflineQueueOptions {
  storage: QueueStorage;
  /** The unwrapped queue key (`QueueKeyVault`), or a fresh in-memory key for a non-persistent queue. */
  key: CryptoKey;
  deviceId: string;
  now?: () => Date;
  random?: () => number;
  isOnline?: () => boolean;
  /** Cross-tab mutual exclusion (navigator.locks in the browser). */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type EnqueueInput = {
  kind: QueueKind;
  /** The request body without OfflineMeta (the queue adds it). For INCIDENT, `evidenceFileIds` comes from `attachments`. */
  payload: Record<string, unknown>;
  /** Short line shown in the queue ("Incident: Security concern · Station 001"). Stored encrypted. */
  summary: string;
  targetId?: string | null;
  attachments?: AttachmentInput[];
};

export class QueueValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
    this.name = 'QueueValidationError';
  }
}

/** The queue was locked (inactivity, "Lock now"): the PIN is needed again. */
export class QueueLockedError extends Error {
  constructor() {
    super('The queue is locked. Enter your PIN to open it.');
    this.name = 'QueueLockedError';
  }
}

const bodyAad = AAD.body;
const attachmentAad = AAD.attachment;
const serverAad = AAD.server;

export class OfflineQueue {
  private running: Promise<SyncRunSummary> | null = null;
  private listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly mutex: <T>(fn: () => Promise<T>) => Promise<T>;

  private constructor(
    private readonly storage: QueueStorage,
    private secretKey: CryptoKey | null,
    readonly deviceId: string,
    opts: OfflineQueueOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.isOnline = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.mutex = opts.lock ?? ((fn) => fn());
  }

  /** Open the queue with its (unwrapped) key; items left UPLOADING by a crash go back to waiting. */
  static async open(opts: OfflineQueueOptions): Promise<OfflineQueue> {
    const q = new OfflineQueue(opts.storage, opts.key, opts.deviceId, opts);
    await q.recover();
    return q;
  }

  private get key(): CryptoKey {
    if (!this.secretKey) throw new QueueLockedError();
    return this.secretKey;
  }

  get locked(): boolean {
    return this.secretKey === null;
  }

  /**
   * Forget the key. An upload already running finishes first (it holds the
   * items it is sending); afterwards nothing can be read or saved until the
   * queue is opened again with the PIN.
   */
  async lock(): Promise<void> {
    const running = this.running;
    if (running) await running.catch(() => undefined);
    this.secretKey = null;
    this.emit();
  }

  get persistent(): boolean {
    return this.storage.persistent;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private async recover(): Promise<void> {
    const cutoff = this.now().getTime() - RECEIPT_TTL_MS;
    for (const e of await this.storage.getAll()) {
      if (e.state === 'UPLOADING') await this.storage.put({ ...e, state: 'SAVED_LOCALLY' });
      else if (e.state === 'CONFIRMED' && e.confirmedAt && Date.parse(e.confirmedAt) < cutoff) await this.storage.delete(e.idempotencyKey);
    }
  }

  /* --------------------------------- Saving -------------------------------- */

  /**
   * Save a record on this phone. Generates the idempotency key and the offline
   * metadata, validates the complete sync item (so a bad item never blocks a
   * batch later), seals the body and photos, and returns the stored entry.
   */
  async enqueue(input: EnqueueInput): Promise<QueueEntryView> {
    const idempotencyKey = uuidv4();
    const createdAt = this.now().toISOString();
    const payload: Record<string, unknown> = { ...input.payload };
    if (KINDS_WITH_META.has(input.kind)) {
      payload.clientIdempotencyKey = idempotencyKey;
      payload.deviceId = this.deviceId;
      payload.clientCreatedAt = createdAt;
      // Fixed at save time so every retry hashes the same on the server.
      payload.submittedOffline = !this.isOnline();
    }
    if (input.kind === 'INCIDENT') delete payload.evidenceFileIds;

    const probe = {
      kind: input.kind,
      idempotencyKey,
      deviceId: this.deviceId,
      clientCreatedAt: createdAt,
      payload: input.kind === 'INCIDENT' ? { ...payload, evidenceFileIds: [] } : payload,
    };
    const parsed = SyncItemSchema.safeParse(probe);
    if (!parsed.success) {
      throw new QueueValidationError(
        'This record is not complete',
        parsed.error.issues.map((i) => ({ path: i.path.slice(1), message: i.message })),
      );
    }
    if (input.kind === 'INCIDENT' && (input.attachments?.length ?? 0) > 10) {
      throw new QueueValidationError('At most 10 photos', [{ path: ['evidenceFileIds'], message: 'At most 10 photos' }]);
    }

    const attachments: StoredAttachment[] = [];
    for (const a of input.attachments ?? []) {
      const id = uuidv4();
      attachments.push({
        id,
        mimeType: a.mimeType,
        sizeBytes: a.bytes.byteLength,
        fileId: null,
        sealed: await sealBytes(this.key, a.bytes, attachmentAad(idempotencyKey, id)),
      });
    }
    const body: SealedBody & { deviceId: string } = { payload, summary: input.summary, deviceId: this.deviceId };
    const entry: StoredEntry = {
      idempotencyKey,
      kind: input.kind,
      state: 'SAVED_LOCALLY',
      phase: 'SEND',
      createdAt,
      retryCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      lastError: null,
      errorCode: null,
      serverResultId: null,
      serverReference: null,
      replayed: false,
      confirmedAt: null,
      targetId: input.targetId ?? null,
      sealed: await sealJson(this.key, body, bodyAad(idempotencyKey)),
      serverState: null,
      attachments,
    };
    await this.storage.put(entry);
    this.emit();
    return this.toView(entry, input.summary);
  }

  /* -------------------------------- Reading -------------------------------- */

  async list(): Promise<QueueEntryView[]> {
    const key = this.key;
    const all = await this.storage.getAll();
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const out: QueueEntryView[] = [];
    for (const e of all) {
      let summary: string | null = null;
      if (e.sealed) {
        try {
          summary = (await openJson<SealedBody>(key, e.sealed, bodyAad(e.idempotencyKey))).summary;
        } catch {
          summary = null;
        }
      }
      out.push(this.toView(e, summary));
    }
    return out;
  }

  async counts(): Promise<QueueCounts> {
    return countEntries(await this.storage.getAll());
  }

  /** The stored request body (decrypted), e.g. to show a rejected item before dismissing it. */
  async readPayload(idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const e = await this.storage.get(idempotencyKey);
    if (!e?.sealed) return null;
    return (await openJson<SealedBody>(this.key, e.sealed, bodyAad(idempotencyKey))).payload;
  }

  /** The current server record returned with a CONFLICT. */
  async readServerState(idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const e = await this.storage.get(idempotencyKey);
    if (!e?.serverState) return null;
    return openJson<Record<string, unknown>>(this.key, e.serverState, serverAad(idempotencyKey));
  }

  /** Small encrypted values beside the queue (cached FieldMe, template versions). */
  async putSecret(name: string, value: unknown): Promise<void> {
    await this.storage.putMeta(`secret:${name}`, await sealJson(this.key, value, AAD.meta(name)));
  }
  async getSecret<T>(name: string): Promise<T | null> {
    const key = this.key;
    const sealed = await this.storage.getMeta<Parameters<typeof openJson>[1]>(`secret:${name}`);
    if (!sealed) return null;
    try {
      return await openJson<T>(key, sealed, AAD.meta(name));
    } catch {
      return null;
    }
  }

  /* ------------------------------ Person's choices ------------------------- */

  /** Remove an item from this phone (never while it is uploading). The server is not changed. */
  async discard(idempotencyKey: string): Promise<void> {
    const e = await this.storage.get(idempotencyKey);
    if (!e) return;
    if (e.state === 'UPLOADING') throw new Error('This item is uploading right now; try again in a moment');
    await this.storage.delete(idempotencyKey);
    this.emit();
  }

  /** The person has read a REJECTED item: delete it (payload included). */
  async acknowledge(idempotencyKey: string): Promise<void> {
    const e = await this.storage.get(idempotencyKey);
    if (!e || e.state !== 'REJECTED') return;
    await this.storage.delete(idempotencyKey);
    this.emit();
  }

  /**
   * Resolve a CONFLICT by submitting the same content again as a NEW record
   * with a new idempotency key (contract §22). `expectedVersion` (check-in and
   * confirmation) is taken from the server state the person reviewed. The old
   * entry is removed only after the new one is safely stored.
   */
  async resubmitAsNew(idempotencyKey: string, changes: { expectedVersion?: number } = {}): Promise<QueueEntryView> {
    const e = await this.storage.get(idempotencyKey);
    if (!e || e.state !== 'CONFLICT' || !e.sealed) throw new Error('Only a conflict can be submitted again');
    const body = await openJson<SealedBody>(this.key, e.sealed, bodyAad(idempotencyKey));
    const payload: Record<string, unknown> = { ...body.payload };
    for (const k of ['clientIdempotencyKey', 'deviceId', 'clientCreatedAt', 'submittedOffline']) delete payload[k];
    if (changes.expectedVersion !== undefined && 'expectedVersion' in payload) payload.expectedVersion = changes.expectedVersion;
    const attachments: AttachmentInput[] = [];
    for (const a of e.attachments) {
      if (!a.sealed) continue;
      attachments.push({ bytes: await openBytes(this.key, a.sealed, attachmentAad(idempotencyKey, a.id)), mimeType: a.mimeType });
    }
    const fresh = await this.enqueue({ kind: e.kind, payload, summary: body.summary, targetId: e.targetId, attachments });
    await this.storage.delete(idempotencyKey);
    this.emit();
    return fresh;
  }

  /** A photo could not be stored (e.g. not an image): send the record without photos, keeping its key (never sent). */
  async dropAttachmentsAndRetry(idempotencyKey: string): Promise<void> {
    const e = await this.storage.get(idempotencyKey);
    if (!e || e.state !== 'REJECTED' || e.errorCode !== LOCAL_ERROR_CODES.ATTACHMENT_FAILED || e.phase !== 'SEND') {
      throw new Error('Only an item whose photo failed can be sent without it');
    }
    await this.storage.put({ ...e, attachments: [], state: 'SAVED_LOCALLY', errorCode: null, lastError: null, nextAttemptAt: null });
    this.emit();
  }

  /** "Try now": clear the backoff wait of every waiting item. */
  async retryNow(): Promise<void> {
    for (const e of await this.storage.getAll()) {
      if (e.state === 'SAVED_LOCALLY' && e.nextAttemptAt) await this.storage.put({ ...e, nextAttemptAt: null });
    }
    this.emit();
  }

  /** Delete every record and the key (sign-out, after the person was warned about unsent items). */
  async destroy(): Promise<void> {
    await this.storage.destroy();
    this.emit();
  }

  /** True when an unsent item already acts on this deployment/incident (stops duplicate taps). */
  async hasPendingFor(kind: QueueKind, targetId: string): Promise<boolean> {
    return (await this.storage.getAll()).some(
      (e) => e.kind === kind && e.targetId === targetId && (e.state === 'SAVED_LOCALLY' || e.state === 'UPLOADING' || e.state === 'CONFLICT'),
    );
  }

  /* --------------------------------- Syncing ------------------------------- */

  /** Next time an automatic attempt is due (null = nothing waiting). */
  async nextDueAt(): Promise<string | null> {
    let min: string | null = null;
    for (const e of await this.storage.getAll()) {
      if (e.state !== 'SAVED_LOCALLY' && e.state !== 'UPLOADING') continue;
      const t = e.nextAttemptAt ?? e.createdAt;
      if (min === null || t < min) min = t;
    }
    return min;
  }

  /** Upload what is due. Single-flight: a second call while one runs returns the same run. */
  sync(transport: QueueTransport, opts: { force?: boolean } = {}): Promise<SyncRunSummary> {
    if (!this.running) {
      if (this.locked) return Promise.reject(new QueueLockedError());
      this.running = this.mutex(() => this.syncOnce(transport, opts)).finally(() => {
        this.running = null;
        this.emit();
      });
    }
    return this.running;
  }

  private async syncOnce(transport: QueueTransport, opts: { force?: boolean }): Promise<SyncRunSummary> {
    const summary: SyncRunSummary = { attempted: 0, accepted: 0, replayed: 0, rejected: 0, conflicts: 0, retrying: 0, authRequired: false };
    const nowIso = this.now().toISOString();
    const due = (await this.storage.getAll())
      .filter((e) => (e.state === 'SAVED_LOCALLY' || e.state === 'UPLOADING') && (opts.force || !e.nextAttemptAt || e.nextAttemptAt <= nowIso))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    const ready: { entry: StoredEntry; item: SyncItem }[] = [];
    for (const original of due) {
      if (summary.authRequired) break;
      summary.attempted += 1;
      let entry = original;
      try {
        entry = await this.uploadAttachments(entry, transport);
      } catch (err) {
        await this.fail(entry, classifyError(err), summary, LOCAL_ERROR_CODES.ATTACHMENT_FAILED);
        continue;
      }
      if (entry.phase === 'ATTACH_EVIDENCE') {
        await this.attachEvidence(entry, transport, summary);
        continue;
      }
      try {
        ready.push({ entry, item: await this.buildItem(entry) });
      } catch {
        await this.put({ ...entry, state: 'REJECTED', errorCode: LOCAL_ERROR_CODES.UNREADABLE, lastError: 'This item could not be read on this phone' });
        summary.rejected += 1;
      }
    }

    for (let i = 0; i < ready.length && !summary.authRequired; i += SYNC_MAX_ITEMS) {
      await this.sendBatch(ready.slice(i, i + SYNC_MAX_ITEMS), transport, summary);
    }
    await this.recover();
    return summary;
  }

  private async put(entry: StoredEntry): Promise<void> {
    await this.storage.put(entry);
  }

  private async uploadAttachments(entry: StoredEntry, transport: QueueTransport): Promise<StoredEntry> {
    let current = entry;
    for (const a of entry.attachments) {
      if (a.fileId || !a.sealed) continue;
      const bytes = await openBytes(this.key, a.sealed, attachmentAad(entry.idempotencyKey, a.id));
      const ext = a.mimeType === 'image/png' ? 'png' : a.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const { fileId } = await transport.uploadEvidence(new Blob([bytes], { type: a.mimeType }), `evidence-${a.id.slice(0, 8)}.${ext}`);
      // Persist each file id at once so a later failure does not upload it again.
      current = { ...current, attachments: current.attachments.map((x) => (x.id === a.id ? { ...x, fileId } : x)) };
      await this.put(current);
    }
    return current;
  }

  private async buildItem(entry: StoredEntry): Promise<SyncItem> {
    if (!entry.sealed) throw new Error('No payload');
    const body = await openJson<SealedBody & { deviceId?: string }>(this.key, entry.sealed, bodyAad(entry.idempotencyKey));
    const payload: Record<string, unknown> = { ...body.payload };
    if (entry.kind === 'INCIDENT') payload.evidenceFileIds = entry.attachments.map((a) => a.fileId).filter((x): x is string => !!x);
    return {
      kind: entry.kind,
      idempotencyKey: entry.idempotencyKey,
      deviceId: body.deviceId ?? this.deviceId,
      clientCreatedAt: entry.createdAt,
      payload,
    } as SyncItem;
  }

  private async sendBatch(batch: { entry: StoredEntry; item: SyncItem }[], transport: QueueTransport, summary: SyncRunSummary): Promise<void> {
    const attemptAt = this.now().toISOString();
    const live: { entry: StoredEntry; item: SyncItem }[] = [];
    for (const b of batch) {
      const fresh = await this.storage.get(b.entry.idempotencyKey);
      if (!fresh || (fresh.state !== 'SAVED_LOCALLY' && fresh.state !== 'UPLOADING')) continue; // discarded meanwhile
      const uploading: StoredEntry = { ...fresh, state: 'UPLOADING', lastAttemptAt: attemptAt };
      await this.put(uploading);
      live.push({ entry: uploading, item: b.item });
    }
    if (live.length === 0) return;
    this.emit();

    let response: SyncResponse;
    try {
      response = await transport.sync(live.map((b) => b.item));
    } catch (err) {
      const c = classifyError(err);
      // A malformed batch is refused as a whole: send items one by one to find the bad one.
      if (c.kind === 'permanent' && live.length > 1 && (c.status === 400 || c.status === 413 || c.status === 422)) {
        for (const b of live) await this.sendBatch([b], transport, summary);
        return;
      }
      for (const b of live) await this.fail(b.entry, c, summary);
      return;
    }

    const byKey = new Map<string, SyncItemResult>(response.results.map((r) => [r.idempotencyKey, r]));
    for (const b of live) {
      const r = byKey.get(b.entry.idempotencyKey);
      if (!r) {
        await this.fail(b.entry, { kind: 'transient', status: null, code: LOCAL_ERROR_CODES.NO_ANSWER, message: 'The server did not answer for this item' }, summary);
        continue;
      }
      await this.applyResult(b.entry, r, transport, summary);
    }
  }

  private async applyResult(entry: StoredEntry, r: SyncItemResult, transport: QueueTransport, summary: SyncRunSummary): Promise<void> {
    if (r.outcome === 'ACCEPTED') {
      summary.accepted += 1;
      if (r.replayed) summary.replayed += 1;
      const accepted: StoredEntry = {
        ...entry,
        serverResultId: r.resultId,
        serverReference: r.reference,
        replayed: r.replayed,
        errorCode: null,
        lastError: null,
      };
      if (entry.kind === 'FIELD_REPORT' && entry.attachments.length > 0 && r.resultId) {
        const next: StoredEntry = { ...accepted, phase: 'ATTACH_EVIDENCE', state: 'SAVED_LOCALLY', nextAttemptAt: null, retryCount: 0 };
        await this.put(next);
        await this.attachEvidence(next, transport, summary);
        return;
      }
      await this.confirm(accepted);
      return;
    }
    const code = r.errorCode ?? (r.outcome === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_FAILED');
    if (r.outcome === 'REJECTED' && TRANSIENT_CODES.has(code)) {
      await this.fail(entry, { kind: 'transient', status: null, code, message: r.message ?? 'Temporary server problem' }, summary);
      return;
    }
    if (r.outcome === 'REJECTED') {
      summary.rejected += 1;
      await this.put({ ...entry, state: 'REJECTED', errorCode: code, lastError: r.message ?? null, nextAttemptAt: null });
      return;
    }
    summary.conflicts += 1;
    await this.put({
      ...entry,
      state: 'CONFLICT',
      errorCode: code,
      lastError: r.message ?? null,
      nextAttemptAt: null,
      serverState: r.serverState ? await sealJson(this.key, r.serverState, serverAad(entry.idempotencyKey)) : null,
    });
  }

  private async attachEvidence(entry: StoredEntry, transport: QueueTransport, summary: SyncRunSummary): Promise<void> {
    const fileIds = entry.attachments.map((a) => a.fileId).filter((x): x is string => !!x);
    if (!entry.serverResultId || fileIds.length === 0) {
      await this.confirm(entry);
      return;
    }
    await this.put({ ...entry, state: 'UPLOADING', lastAttemptAt: this.now().toISOString() });
    try {
      await transport.attachReportEvidence(entry.serverResultId, fileIds);
      await this.confirm(entry);
    } catch (err) {
      await this.fail(entry, classifyError(err), summary, LOCAL_ERROR_CODES.EVIDENCE_NOT_ATTACHED);
    }
  }

  private async confirm(entry: StoredEntry): Promise<void> {
    await this.put({
      ...entry,
      state: 'CONFIRMED',
      phase: entry.phase,
      confirmedAt: this.now().toISOString(),
      nextAttemptAt: null,
      lastError: null,
      errorCode: null,
      // Delete the payload, photos and any server state at once (blueprint 11.3 mobile safety).
      sealed: null,
      serverState: null,
      attachments: entry.attachments.map((a) => ({ ...a, sealed: null })),
    });
  }

  private async fail(entry: StoredEntry, c: ClassifiedError, summary: SyncRunSummary, permanentCode?: string): Promise<void> {
    if (c.kind === 'permanent') {
      summary.rejected += 1;
      await this.put({
        ...entry,
        state: 'REJECTED',
        errorCode: permanentCode ?? c.code,
        lastError: c.message,
        nextAttemptAt: null,
      });
      return;
    }
    if (c.kind === 'auth') summary.authRequired = true;
    summary.retrying += 1;
    const retryCount = entry.retryCount + 1;
    await this.put({
      ...entry,
      state: 'SAVED_LOCALLY',
      retryCount,
      errorCode: c.code,
      lastError: c.message,
      nextAttemptAt: nextAttemptAt(this.now(), retryCount, this.random),
    });
  }

  private toView(e: StoredEntry, summary: string | null): QueueEntryView {
    return {
      idempotencyKey: e.idempotencyKey,
      kind: e.kind,
      state: e.state,
      phase: e.phase,
      createdAt: e.createdAt,
      retryCount: e.retryCount,
      lastAttemptAt: e.lastAttemptAt,
      nextAttemptAt: e.nextAttemptAt,
      lastError: e.lastError,
      errorCode: e.errorCode,
      serverReference: e.serverReference,
      serverResultId: e.serverResultId,
      replayed: e.replayed,
      confirmedAt: e.confirmedAt,
      targetId: e.targetId,
      summary,
      attachmentCount: e.attachments.length,
    };
  }
}

export function countEntries(entries: { state: LocalQueueState; retryCount: number }[]): QueueCounts {
  const c: QueueCounts = { pending: 0, retrying: 0, sent: 0, failed: 0, conflict: 0 };
  for (const e of entries) {
    if (e.state === 'SAVED_LOCALLY' || e.state === 'UPLOADING') {
      c.pending += 1;
      if (e.retryCount > 0) c.retrying += 1;
    } else if (e.state === 'CONFIRMED') c.sent += 1;
    else if (e.state === 'REJECTED') c.failed += 1;
    else if (e.state === 'CONFLICT') c.conflict += 1;
  }
  return c;
}

/** Items the person would lose by signing out now. */
export function unsentCount(c: QueueCounts): number {
  return c.pending + c.failed + c.conflict;
}
