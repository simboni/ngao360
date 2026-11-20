/**
 * Random per-installation id sent as `deviceId` with offline items (contract
 * §15). It is not a hardware identifier and carries no personal data.
 */
import { uuidv4 } from './uuid';

const DEVICE_KEY = 'ngao360.field.deviceId';
const SESSION_KEY = 'ngao360.field.lastSession';

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 8) return existing;
    const id = uuidv4();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return uuidv4();
  }
}

/**
 * Ids (only) of the last signed-in field user on this phone, so the queue of
 * that person can be opened while offline, when /auth/me cannot be reached.
 * Display data and permissions are kept encrypted inside their queue.
 */
export interface LastSession {
  tenantId: string;
  userId: string;
}

export function rememberSession(s: LastSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: offline start will not find the queue */
  }
}

export function lastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastSession>;
    return typeof v.tenantId === 'string' && typeof v.userId === 'string' ? { tenantId: v.tenantId, userId: v.userId } : null;
  } catch {
    return null;
  }
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Delete the last field user's offline queue (records and key) and forget
 * them. For sign-out paths outside the field app (e.g. the desktop menu),
 * which do not show the unsent-items warning; see docs/CHANGE_REQUESTS.md.
 */
export async function clearOfflineDataForSignOut(): Promise<void> {
  const s = lastSession();
  forgetSession();
  if (!s || typeof indexedDB === 'undefined') return;
  const { deleteQueueDatabase, queueDatabaseName } = await import('./storage');
  await deleteQueueDatabase(queueDatabaseName(s.tenantId, s.userId));
}

/**
 * Items of the last field user's queue on this device that are not yet
 * accepted by the server (waiting, not accepted, or needing a decision).
 * Reads entry states only (no decryption). 0 when there is no queue.
 */
export async function unsentCountForLastSession(): Promise<number> {
  const s = lastSession();
  if (!s || typeof indexedDB === 'undefined') return 0;
  try {
    const { IndexedDbQueueStorage, queueDatabaseName } = await import('./storage');
    const storage = await IndexedDbQueueStorage.open(queueDatabaseName(s.tenantId, s.userId));
    try {
      return (await storage.getAll()).filter((e) => e.state !== 'CONFIRMED').length;
    } finally {
      storage.close();
    }
  } catch {
    return 0;
  }
}
