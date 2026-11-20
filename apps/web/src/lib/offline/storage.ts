/**
 * Storage behind the offline queue. The browser uses IndexedDB
 * (`IndexedDbQueueStorage`); tests and devices without IndexedDB use the
 * in-memory adapter (items are then lost when the app closes, and the screens
 * say so).
 */
import type { StoredEntry } from './types';

export interface QueueStorage {
  /** True when records survive closing the app. */
  readonly persistent: boolean;
  getAll(): Promise<StoredEntry[]>;
  get(idempotencyKey: string): Promise<StoredEntry | undefined>;
  put(entry: StoredEntry): Promise<void>;
  delete(idempotencyKey: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Delete every record and the key (sign-out). */
  destroy(): Promise<void>;
}

function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : v;
}

export class MemoryQueueStorage implements QueueStorage {
  readonly persistent = false;
  private entries = new Map<string, StoredEntry>();
  private meta = new Map<string, unknown>();
  destroyed = false;

  async getAll(): Promise<StoredEntry[]> {
    return [...this.entries.values()].map((e) => clone(e));
  }
  async get(k: string): Promise<StoredEntry | undefined> {
    const e = this.entries.get(k);
    return e ? clone(e) : undefined;
  }
  async put(entry: StoredEntry): Promise<void> {
    this.entries.set(entry.idempotencyKey, clone(entry));
  }
  async delete(k: string): Promise<void> {
    this.entries.delete(k);
  }
  async getMeta<T>(key: string): Promise<T | undefined> {
    // CryptoKey objects are kept by reference (structuredClone of a CryptoKey works, but keep it cheap).
    return this.meta.get(key) as T | undefined;
  }
  async putMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }
  async deleteMeta(key: string): Promise<void> {
    this.meta.delete(key);
  }
  async destroy(): Promise<void> {
    this.entries.clear();
    this.meta.clear();
    this.destroyed = true;
  }
}

/* --------------------------------- IndexedDB -------------------------------- */

const ENTRIES = 'entries';
const META = 'meta';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** One database per signed-in user and tenant. */
export function queueDatabaseName(tenantId: string, userId: string): string {
  return `ngao360-field-${tenantId}-${userId}`;
}

export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export class IndexedDbQueueStorage implements QueueStorage {
  readonly persistent = true;
  private constructor(
    private db: IDBDatabase,
    private readonly name: string,
  ) {}

  static open(name: string): Promise<IndexedDbQueueStorage> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'idempotencyKey' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      r.onsuccess = () => {
        const db = r.result;
        // Another tab deleting the database (sign-out) closes this connection.
        db.onversionchange = () => db.close();
        resolve(new IndexedDbQueueStorage(db, name));
      };
      r.onerror = () => reject(r.error ?? new Error('Could not open the offline queue'));
      r.onblocked = () => reject(new Error('The offline queue is open in another tab that is blocking it'));
    });
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  getAll(): Promise<StoredEntry[]> {
    return req(this.store(ENTRIES, 'readonly').getAll() as IDBRequest<StoredEntry[]>);
  }
  get(k: string): Promise<StoredEntry | undefined> {
    return req(this.store(ENTRIES, 'readonly').get(k) as IDBRequest<StoredEntry | undefined>);
  }
  async put(entry: StoredEntry): Promise<void> {
    await req(this.store(ENTRIES, 'readwrite').put(entry));
  }
  async delete(k: string): Promise<void> {
    await req(this.store(ENTRIES, 'readwrite').delete(k));
  }
  getMeta<T>(key: string): Promise<T | undefined> {
    return req(this.store(META, 'readonly').get(key) as IDBRequest<T | undefined>);
  }
  async putMeta(key: string, value: unknown): Promise<void> {
    await req(this.store(META, 'readwrite').put(value, key));
  }
  async deleteMeta(key: string): Promise<void> {
    await req(this.store(META, 'readwrite').delete(key));
  }
  async destroy(): Promise<void> {
    this.db.close();
    await deleteQueueDatabase(this.name);
  }
  /** Close this connection without deleting anything. */
  close(): void {
    this.db.close();
  }
}

export function deleteQueueDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error ?? new Error('Could not delete the offline queue'));
    // Blocked: other tabs were told to close (onversionchange); deletion completes when they do.
    r.onblocked = () => resolve();
  });
}
