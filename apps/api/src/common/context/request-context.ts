import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from '../../auth/auth.types';

/** Per-request context available anywhere (audit metadata, current tenant). */
export interface RequestContextStore {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  auth?: AuthContext;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },
  setAuth(auth: AuthContext): void {
    const s = storage.getStore();
    if (s) s.auth = auth;
  },
};
