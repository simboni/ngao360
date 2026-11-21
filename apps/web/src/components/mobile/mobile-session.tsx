'use client';

/**
 * Mobile session and offline queue context for the /m route group.
 *
 * - Opens the signed-in person's encrypted queue (one IndexedDB database per
 *   user and tenant) and keeps a small encrypted snapshot of who they are and
 *   what the screens may offer, so the app still opens and saves items when
 *   the phone starts without a connection (/auth/me unreachable).
 * - The queue key is wrapped under the person's device PIN (`lib/offline/pin.ts`,
 *   contract §36): `pin` is the vault state while the queue is closed (set a
 *   PIN, protect an older queue, enter the PIN, or locked out), and null once
 *   it is open. The open queue locks itself after `PIN_INACTIVITY_LOCK_MS`
 *   without a touch or key press, and on "Lock now".
 * - Uploads in the foreground: after each save when online, when the
 *   connection returns, when the app comes back to the screen, on a timer for
 *   items whose backoff has elapsed, and when the service worker relays a
 *   Background Sync event (only while a tab of the app is open; there is no
 *   upload with every tab closed).
 * - Sign-out warns about unsent items, then deletes the queue and its key.
 * - Nothing uploads while the queue is locked (the key is needed to read the
 *   items); the counts stay visible from the clear metadata.
 *
 * Permissions here are UI hints only; the API checks every request.
 */
import type { MeResponse, PermissionKey, TenantModuleKey } from '@ngao360/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { getDeviceId, forgetSession, lastSession, rememberSession } from '@/lib/offline/device';
import { PIN_INACTIVITY_LOCK_MS, QueueKeyVault, type VaultStatus } from '@/lib/offline/pin';
import { countEntries, type EnqueueInput, OfflineQueue, QueueLockedError, type SyncRunSummary } from '@/lib/offline/queue';
import { IndexedDbQueueStorage, indexedDbAvailable, MemoryQueueStorage, queueDatabaseName, type QueueStorage } from '@/lib/offline/storage';
import { apiQueueTransport } from '@/lib/offline/transport';
import type { QueueCounts, QueueEntryView } from '@/lib/offline/types';
import { generateQueueKey, isCryptoAvailable } from '@/lib/offline/crypto';

const EMPTY_COUNTS: QueueCounts = { pending: 0, retrying: 0, sent: 0, failed: 0, conflict: 0 };
const SNAPSHOT = 'session';
const TICK_MS = 15_000;
export const BACKGROUND_SYNC_TAG = 'ngao-field-sync';

/** Encrypted snapshot of the last /auth/me (no email). */
interface SessionSnapshot {
  displayName: string;
  tenantName: string;
  permissions: string[];
  modules: string[];
  savedAt: string;
}

export interface MobileSessionState {
  /** Null until the queue is open (or when it cannot be opened). */
  queue: OfflineQueue | null;
  queueError: string | null;
  /** False when items are kept only in memory (no IndexedDB): they are lost if the app closes. */
  persistent: boolean;
  counts: QueueCounts;
  entries: QueueEntryView[];
  online: boolean;
  syncing: boolean;
  lastRun: SyncRunSummary | null;
  lastSyncAt: string | null;
  /** Started without a server session (offline): identity comes from the encrypted snapshot. */
  offlineMode: boolean;
  ready: boolean;
  displayName: string | null;
  can: (p: PermissionKey) => boolean;
  moduleEnabled: (m: TenantModuleKey) => boolean;
  enqueue: (input: EnqueueInput) => Promise<QueueEntryView>;
  syncNow: (force?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  /** Deletes the queue and key and signs out. Call only after warning about unsent items. */
  signOut: () => Promise<void>;
  /** Vault state while the queue is closed by the PIN; null when open (or no persistent queue). */
  pin: VaultStatus | null;
  /** True when the queue is PIN-protected (persistent storage) and can be locked. */
  pinProtected: boolean;
  createPin: (pin: string) => Promise<void>;
  unlock: (pin: string) => Promise<void>;
  lockNow: () => Promise<void>;
  changePin: (current: string, next: string) => Promise<void>;
  /** Erase every item on this phone after the person confirmed `confirmedUnsent`; with `newPin`, start again under it. */
  eraseQueue: (confirmedUnsent: number, newPin?: string) => Promise<void>;
  refreshPin: () => Promise<void>;
}

const Ctx = createContext<MobileSessionState | null>(null);

function lockFor(name: string) {
  return <T,>(fn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks?.request) return fn();
    return locks.request(`${name}:sync`, () => fn()) as Promise<T>;
  };
}

async function openStorage(name: string): Promise<QueueStorage> {
  if (indexedDbAvailable()) {
    try {
      return await IndexedDbQueueStorage.open(name);
    } catch {
      /* fall through to memory */
    }
  }
  return new MemoryQueueStorage();
}

function snapshotOf(me: MeResponse): SessionSnapshot {
  return {
    displayName: me.user.displayName,
    tenantName: me.tenant.name,
    permissions: me.permissions,
    modules: me.modules,
    savedAt: new Date().toISOString(),
  };
}

export function MobileSessionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [queue, setQueue] = useState<OfflineQueue | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [counts, setCounts] = useState<QueueCounts>(EMPTY_COUNTS);
  const [entries, setEntries] = useState<QueueEntryView[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastRun, setLastRun] = useState<SyncRunSummary | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [offlineMode, setOfflineMode] = useState(false);
  const [ready, setReady] = useState(false);
  const openedFor = useRef<string | null>(null);
  const [pin, setPin] = useState<VaultStatus | null>(null);
  const pinRef = useRef<VaultStatus | null>(null);
  pinRef.current = pin;
  const vaultRef = useRef<QueueKeyVault | null>(null);
  const storageRef = useRef<QueueStorage | null>(null);
  const authMeRef = useRef<MeResponse | null>(auth.me);
  const lastActivity = useRef(Date.now());

  /* Connection state */
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  /** Open the queue with an unwrapped key and load (or save) the identity snapshot. */
  const openWith = useCallback(
    async (storage: QueueStorage, key: CryptoKey, name: string) => {
      const q = await OfflineQueue.open({ storage, key, deviceId: getDeviceId(), lock: lockFor(name) });
      const me = authMeRef.current;
      if (me) {
        await q.putSecret(SNAPSHOT, snapshotOf(me));
        setOfflineMode(false);
      } else {
        const snap = await q.getSecret<SessionSnapshot>(SNAPSHOT);
        setSnapshot(snap);
        setOfflineMode(Boolean(snap));
      }
      lastActivity.current = Date.now();
      setPin(null);
      setQueue(q);
    },
    [],
  );

  /** Re-read the vault state of a closed queue (and its counts, from clear metadata). */
  const refreshPin = useCallback(async () => {
    const vault = vaultRef.current;
    const storage = storageRef.current;
    if (!vault || !storage) return;
    const status = await vault.status();
    setCounts(countEntries(await storage.getAll()));
    setEntries([]);
    // A queue without a key is set up only after an online sign-in.
    setPin(status.state === 'NEW' && !authMeRef.current ? null : status);
  }, []);

  /* Open the queue for the signed-in person, or for the last person on this phone while offline. */
  useEffect(() => {
    authMeRef.current = auth.me;
    if (auth.loading) return;
    let cancelled = false;
    // Without /auth/me (offline, or the server unreachable) fall back to the last field user on this phone.
    // A 401 still sends the person to sign-in (AuthProvider).
    const identity = auth.me ? { tenantId: auth.me.tenant.id, userId: auth.me.user.id } : lastSession();
    if (!identity) {
      setReady(true);
      return;
    }
    const name = queueDatabaseName(identity.tenantId, identity.userId);
    if (openedFor.current === name) {
      if (auth.me && queue) {
        setOfflineMode(false);
        void queue.putSecret(SNAPSHOT, snapshotOf(auth.me)).catch(() => undefined);
      } else if (auth.me && !queue) {
        void refreshPin();
      }
      return;
    }
    openedFor.current = name;
    void (async () => {
      try {
        if (!isCryptoAvailable()) throw new Error('This browser cannot encrypt saved items. Use an up-to-date Chrome or Firefox.');
        const storage = await openStorage(name);
        if (cancelled) return;
        storageRef.current = storage;
        if (auth.me) rememberSession(identity);
        if (!storage.persistent) {
          // Items live only in this page's memory: an in-memory key, no PIN.
          vaultRef.current = null;
          await openWith(storage, await generateQueueKey(), name);
          return;
        }
        vaultRef.current = new QueueKeyVault({ storage, binding: name, lock: lockFor(`${name}:pin`) });
        await refreshPin();
      } catch (err) {
        setQueueError(err instanceof Error ? err.message : 'The offline queue could not be opened');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // queue intentionally omitted: it is set by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.loading, auth.me]);

  const withVault = useCallback(
    async (fn: (vault: QueueKeyVault, storage: QueueStorage) => Promise<CryptoKey | null>) => {
      const vault = vaultRef.current;
      const storage = storageRef.current;
      const name = openedFor.current;
      if (!vault || !storage || !name) throw new Error('The offline queue is not ready');
      try {
        const key = await fn(vault, storage);
        if (key) await openWith(storage, key, name);
        else await refreshPin();
      } catch (err) {
        await refreshPin();
        throw err;
      }
    },
    [openWith, refreshPin],
  );

  const createPin = useCallback((pin: string) => withVault((v) => (pinRef.current?.state === 'LEGACY' ? v.migrate(pin) : v.create(pin))), [withVault]);
  const unlock = useCallback((pin: string) => withVault((v) => v.unlock(pin)), [withVault]);
  const eraseQueue = useCallback((confirmedUnsent: number, newPin?: string) => withVault((v) => v.erase(confirmedUnsent, newPin)), [withVault]);

  const lockNow = useCallback(async () => {
    const q = queue;
    if (!q || !vaultRef.current) return;
    setQueue(null);
    setSnapshot(null);
    await q.lock();
    await refreshPin();
  }, [queue, refreshPin]);

  const changePin = useCallback(
    async (current: string, next: string) => {
      const vault = vaultRef.current;
      if (!vault) throw new Error('This queue has no PIN');
      await vault.changePin(current, next);
      lastActivity.current = Date.now();
    },
    [],
  );

  /* Inactivity lock (only for a PIN-protected queue). */
  useEffect(() => {
    if (!queue || !vaultRef.current) return;
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const check = () => {
      if (Date.now() - lastActivity.current >= PIN_INACTIVITY_LOCK_MS) void lockNow();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 5_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [queue, lockNow]);

  const refresh = useCallback(async () => {
    if (!queue || queue.locked) return;
    const list = await queue.list();
    setEntries(list);
    setCounts(await queue.counts());
  }, [queue]);

  useEffect(() => {
    if (!queue) return;
    void refresh();
    return queue.subscribe(() => void refresh());
  }, [queue, refresh]);

  const syncNow = useCallback(
    async (force = false) => {
      if (!queue || queue.locked || !navigator.onLine) return;
      setSyncing(true);
      try {
        const run = await queue.sync(apiQueueTransport, { force });
        setLastRun(run);
        setLastSyncAt(new Date().toISOString());
      } catch (err) {
        // Locked while starting: the next unlock uploads.
        if (!(err instanceof QueueLockedError)) throw err;
      } finally {
        setSyncing(false);
      }
    },
    [queue],
  );

  /* Foreground triggers */
  useEffect(() => {
    if (!queue) return;
    const onOnline = () => {
      if (!auth.me) void auth.reload();
      void syncNow();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncNow();
    };
    const onMessage = (ev: MessageEvent) => {
      if ((ev.data as { type?: string } | null)?.type === BACKGROUND_SYNC_TAG) void syncNow();
    };
    const tick = window.setInterval(async () => {
      const due = await queue.nextDueAt();
      if (due && due <= new Date().toISOString()) void syncNow();
    }, TICK_MS);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    void syncNow();
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [queue, syncNow, auth]);

  const enqueue = useCallback(
    async (input: EnqueueInput) => {
      if (!queue) throw new Error(queueError ?? 'The offline queue is not open yet');
      const entry = await queue.enqueue(input);
      if (navigator.onLine) void syncNow();
      else void requestBackgroundSync();
      return entry;
    },
    [queue, queueError, syncNow],
  );

  const signOut = useCallback(async () => {
    try {
      if (queue) await queue.destroy();
      else await storageRef.current?.destroy();
    } finally {
      openedFor.current = null;
      vaultRef.current = null;
      storageRef.current = null;
      setPin(null);
      setQueue(null);
      forgetSession();
      await auth.logout();
    }
  }, [queue, auth]);

  const value = useMemo<MobileSessionState>(() => {
    const perms = new Set<string>(auth.me?.permissions ?? snapshot?.permissions ?? []);
    const modules = new Set<string>(auth.me?.modules ?? snapshot?.modules ?? []);
    return {
      queue,
      queueError,
      persistent: queue?.persistent ?? false,
      counts,
      entries,
      online,
      syncing,
      lastRun,
      lastSyncAt,
      offlineMode: !auth.me && offlineMode,
      ready: ready && !auth.loading,
      displayName: auth.me?.user.displayName ?? snapshot?.displayName ?? null,
      can: (p) => perms.has(p),
      moduleEnabled: (m) => modules.has(m),
      enqueue,
      syncNow,
      refresh,
      signOut,
      pin,
      pinProtected: Boolean(queue && vaultRef.current),
      createPin,
      unlock,
      lockNow,
      changePin,
      eraseQueue,
      refreshPin,
    };
  }, [auth.me, auth.loading, snapshot, queue, queueError, counts, entries, online, syncing, lastRun, lastSyncAt, offlineMode, ready, enqueue, syncNow, refresh, signOut, pin, createPin, unlock, lockNow, changePin, eraseQueue, refreshPin]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMobileSession(): MobileSessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMobileSession must be used inside MobileSessionProvider');
  return v;
}

/** Ask the service worker to wake the app when the connection returns (Background Sync, where supported). */
async function requestBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as (ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }) | undefined)?.sync;
    await sync?.register(BACKGROUND_SYNC_TAG);
  } catch {
    /* not supported: the online event and the timer still upload */
  }
}
