/**
 * Sign-out releases this browser's push subscription (shared field / office devices must not keep
 * showing the previous person's notifications). Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PUSH_SUBSCRIPTION_STORAGE_KEY, releasePushForSignOut } from '../push-model';

const ID = '11111111-2222-4333-8444-555555555555';

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('releasePushForSignOut', () => {
  it('revokes the server row, unsubscribes the browser and forgets the stored id', async () => {
    const storage = memoryStorage({ [PUSH_SUBSCRIPTION_STORAGE_KEY]: ID });
    const revoked: string[] = [];
    let unsubscribed = 0;
    const r = await releasePushForSignOut({
      storage,
      revoke: async (id) => void revoked.push(id),
      getSubscription: async () => ({ unsubscribe: async () => ((unsubscribed += 1), true) }),
    });
    assert.deepEqual(r, { revoked: true, unsubscribed: true });
    assert.deepEqual(revoked, [ID]);
    assert.equal(unsubscribed, 1);
    assert.equal(storage.m.has(PUSH_SUBSCRIPTION_STORAGE_KEY), false);
  });

  it('still unsubscribes the browser and clears the id when the server call fails (offline, session gone)', async () => {
    const storage = memoryStorage({ [PUSH_SUBSCRIPTION_STORAGE_KEY]: ID });
    let unsubscribed = false;
    const r = await releasePushForSignOut({
      storage,
      revoke: async () => {
        throw new Error('offline');
      },
      getSubscription: async () => ({ unsubscribe: async () => (unsubscribed = true) }),
    });
    assert.equal(unsubscribed, true);
    assert.deepEqual(r, { revoked: false, unsubscribed: true });
    assert.equal(storage.m.has(PUSH_SUBSCRIPTION_STORAGE_KEY), false);
  });

  it('unsubscribes a browser subscription even when no id was stored, and tolerates no push support', async () => {
    let calls = 0;
    const revoke = async () => void (calls += 1);
    let unsubscribed = false;
    await releasePushForSignOut({ storage: memoryStorage(), revoke, getSubscription: async () => ({ unsubscribe: async () => (unsubscribed = true) }) });
    assert.equal(calls, 0);
    assert.equal(unsubscribed, true);
    const none = await releasePushForSignOut({
      storage: null,
      revoke,
      getSubscription: async () => {
        throw new Error('no service worker');
      },
    });
    assert.deepEqual(none, { revoked: false, unsubscribed: false });
  });

  it('the sign-out in the auth context releases push before ending the session', () => {
    const src = readFileSync(join(__dirname, '../../../lib/auth-context.tsx'), 'utf8');
    const release = src.indexOf('releasePushForSignOut(');
    const logout = src.indexOf("api.post('/auth/logout'");
    assert.ok(release > 0 && logout > release, 'push is released before /auth/logout');
  });
});
