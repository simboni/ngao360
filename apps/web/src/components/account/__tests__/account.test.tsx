/**
 * Account panels (CR AR9): contact verification and SMS consent states, push support and
 * subscription shaping, and the service worker's push / notification-click handlers (public/sw.js,
 * run in a sandbox with fake browser objects). Run: pnpm --filter @ngao360/web test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { type ContactStatus, SMS_CONSENT_NOTICE } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { contactState, deliverabilityText, isCompleteCode, sanitizeCode, sendCodeBlocker, smsConsentState } from '../contact-model';
import { ContactRow, SmsConsentCard } from '../contact-panels';
import {
  DEFAULT_NOTIFICATION_PATH,
  PUSH_STATE_TEXT,
  pushPanelState,
  pushSupport,
  readStoredSubscriptionId,
  safeNotificationPath,
  subscriptionBody,
  urlBase64ToUint8Array,
  writeStoredSubscriptionId,
} from '../push-model';

const ORIGIN = 'https://ngao.example.org';

function contact(over: Partial<ContactStatus> = {}): ContactStatus {
  return {
    channel: 'SMS',
    addressMasked: '+2547•••••12',
    verifiedAt: null,
    smsConsentVersion: null,
    smsConsentAt: null,
    smsOptedOutAt: null,
    deliverable: false,
    ...over,
  };
}

describe('contact verification', () => {
  it('distinguishes missing, unverified and verified addresses', () => {
    assert.equal(contactState(null), 'MISSING');
    assert.equal(contactState(contact({ addressMasked: null })), 'MISSING');
    assert.equal(contactState(contact()), 'UNVERIFIED');
    assert.equal(contactState(contact({ verifiedAt: '2026-11-20T10:00:00Z' })), 'VERIFIED');
  });

  it('explains why no code can be sent to a missing number', () => {
    assert.match(sendCodeBlocker(contact({ addressMasked: null })) ?? '', /mobile number/);
    assert.match(sendCodeBlocker(contact({ channel: 'EMAIL', addressMasked: null })) ?? '', /e-mail/);
    assert.equal(sendCodeBlocker(contact()), null);
  });

  it('accepts only six digits as a code', () => {
    assert.equal(sanitizeCode(' 12a3-456 789'), '123456');
    assert.ok(isCompleteCode('123456'));
    assert.ok(!isCompleteCode('12345'));
  });

  it('says what deliverable means for each channel', () => {
    assert.match(deliverabilityText(contact()), /Verify/);
    assert.match(deliverabilityText(contact({ verifiedAt: '2026-11-20T10:00:00Z' })), /agree to the SMS notice/);
    assert.match(deliverabilityText(contact({ channel: 'EMAIL', verifiedAt: '2026-11-20T10:00:00Z', deliverable: true })), /e-mail/);
  });

  it('renders the masked address and a send-code action, never a full number', () => {
    const html = renderToStaticMarkup(<ContactRow contact={contact()} onChanged={() => undefined} />);
    assert.match(html, /\+2547•••••12/);
    assert.match(html, /Send a code/);
    assert.match(html, /Not verified/);
  });
});

describe('SMS consent', () => {
  it('tracks the notice version and opt-out', () => {
    assert.equal(smsConsentState(contact({ addressMasked: null })), 'NO_PHONE');
    assert.equal(smsConsentState(contact()), 'NOT_GIVEN');
    assert.equal(smsConsentState(contact({ smsConsentVersion: SMS_CONSENT_NOTICE.version, smsConsentAt: '2026-11-20T10:00:00Z' })), 'GIVEN');
    assert.equal(smsConsentState(contact({ smsConsentVersion: '2020-01-01', smsConsentAt: '2026-11-20T10:00:00Z' })), 'OUTDATED');
    assert.equal(smsConsentState(contact({ smsConsentVersion: SMS_CONSENT_NOTICE.version, smsConsentAt: '2026-11-20T10:00:00Z', smsOptedOutAt: '2026-11-21T10:00:00Z' })), 'OPTED_OUT');
  });

  it('shows the exact notice text and version, and offers opt-out once agreed', () => {
    const notGiven = renderToStaticMarkup(<SmsConsentCard sms={contact()} onChanged={() => undefined} />);
    assert.ok(notGiven.includes(SMS_CONSENT_NOTICE.text));
    assert.ok(notGiven.includes(`Notice version ${SMS_CONSENT_NOTICE.version}`));
    assert.match(notGiven, /I agree to SMS messages/);
    assert.doesNotMatch(notGiven, /Turn SMS off/);
    const given = renderToStaticMarkup(
      <SmsConsentCard sms={contact({ smsConsentVersion: SMS_CONSENT_NOTICE.version, smsConsentAt: '2026-11-20T10:00:00Z' })} onChanged={() => undefined} />,
    );
    assert.match(given, /Turn SMS off/);
    assert.doesNotMatch(given, /I agree to SMS messages/);
    const noPhone = renderToStaticMarkup(<SmsConsentCard sms={contact({ addressMasked: null })} onChanged={() => undefined} />);
    assert.doesNotMatch(noPhone, /I agree to SMS messages|Turn SMS off/);
  });
});

describe('push panel', () => {
  it('decodes a URL-safe VAPID key', () => {
    const bytes = urlBase64ToUint8Array('AQIDBA_-');
    assert.deepEqual([...bytes], [1, 2, 3, 4, 15, 254]);
  });

  it('needs a secure context, a service worker, PushManager and Notification', () => {
    const full = { secureContext: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true };
    assert.equal(pushSupport(full), 'SUPPORTED');
    assert.equal(pushSupport({ ...full, secureContext: false }), 'INSECURE');
    assert.equal(pushSupport({ ...full, hasPushManager: false }), 'UNSUPPORTED');
  });

  it('says plainly when the server has no push key, before anything else', () => {
    const base = { configLoaded: true, vapidPublicKey: 'key', support: 'SUPPORTED' as const, workerReady: true, permission: 'default' as const, subscribedHere: false };
    assert.equal(pushPanelState({ ...base, vapidPublicKey: null, support: 'UNSUPPORTED' }), 'NOT_CONFIGURED');
    assert.match(PUSH_STATE_TEXT.NOT_CONFIGURED, /not set up on this server/);
    assert.equal(pushPanelState({ ...base, configLoaded: false }), 'LOADING');
    assert.equal(pushPanelState({ ...base, workerReady: false }), 'NO_WORKER');
    assert.equal(pushPanelState({ ...base, permission: 'denied' }), 'DENIED');
    assert.equal(pushPanelState({ ...base, permission: 'granted', subscribedHere: true }), 'SUBSCRIBED');
    assert.equal(pushPanelState(base), 'NOT_SUBSCRIBED');
  });

  it('sends only HTTPS endpoints with both keys', () => {
    const keys = { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) };
    assert.deepEqual(subscriptionBody({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, 'Chrome on Android'), {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      deviceLabel: 'Chrome on Android',
    });
    assert.equal(subscriptionBody({ endpoint: 'http://push.example/abc', keys }, null), null);
    assert.equal(subscriptionBody({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short' } }, null), null);
  });

  it('remembers only the subscription id, and survives blocked storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    const id = '00000000-0000-4000-8000-0000000000ff';
    writeStoredSubscriptionId(storage, id);
    assert.equal(readStoredSubscriptionId(storage), id);
    writeStoredSubscriptionId(storage, null);
    assert.equal(readStoredSubscriptionId(storage), null);
    map.set('ngao360.push.subscriptionId', 'https://endpoint');
    assert.equal(readStoredSubscriptionId(storage), null);
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
    };
    assert.equal(readStoredSubscriptionId(blocked), null);
    assert.doesNotThrow(() => writeStoredSubscriptionId(blocked, id));
  });
});

/* ------------------------------------------------------------------ service worker */

const LINK_CASES: Array<[unknown, string]> = [
  ['/admin/users?recovery=abc', '/admin/users?recovery=abc'],
  ['/tasks/123#comments', '/tasks/123#comments'],
  ['https://evil.example/phish', DEFAULT_NOTIFICATION_PATH],
  ['//evil.example/phish', DEFAULT_NOTIFICATION_PATH],
  ['/\\evil.example', DEFAULT_NOTIFICATION_PATH],
  ['javascript:alert(1)', DEFAULT_NOTIFICATION_PATH],
  ['/ok\nbad', DEFAULT_NOTIFICATION_PATH],
  ['relative/path', DEFAULT_NOTIFICATION_PATH],
  [`/${'a'.repeat(600)}`, DEFAULT_NOTIFICATION_PATH],
  [42, DEFAULT_NOTIFICATION_PATH],
  [null, DEFAULT_NOTIFICATION_PATH],
];

interface FakeClient {
  url: string;
  focused: boolean;
  navigatedTo: string | null;
  navigate?: (u: string) => Promise<FakeClient | null>;
  focus: () => Promise<FakeClient>;
}

function loadServiceWorker(clients: FakeClient[] = []) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (u: string) => {
        opened.push(u);
        return null;
      },
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
  };
  const source = readFileSync(join(__dirname, '..', '..', '..', '..', 'public', 'sw.js'), 'utf8');
  const context: Record<string, unknown> = { self, URL, caches: {}, fetch: async () => undefined, console };
  runInNewContext(`${source}\n;globalThis.__safe = safeNotificationPath;`, context);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { fire, shown, opened, safe: context.__safe as (l: unknown, o: string) => string };
}

describe('service worker push handler', () => {
  it('applies the same link rules as the panel', () => {
    const sw = loadServiceWorker();
    for (const [link, expected] of LINK_CASES) {
      assert.equal(safeNotificationPath(link, ORIGIN), expected, `panel ${String(link)}`);
      assert.equal(sw.safe(link, ORIGIN), expected, `sw ${String(link)}`);
    }
  });

  it('shows the title and body and keeps only a safe in-app path', async () => {
    const sw = loadServiceWorker();
    const payload = { title: 'Account recovery needs a second administrator', body: 'Review it', link: '/admin/users?recovery=r1', id: 'm-1' };
    await sw.fire('push', { data: { json: () => payload } });
    assert.equal(sw.shown.length, 1);
    assert.equal(sw.shown[0]!.title, payload.title);
    assert.equal(sw.shown[0]!.options.body, 'Review it');
    assert.equal(sw.shown[0]!.options.tag, 'ngao-m-1');
    // Objects from the sandbox have another realm's prototype: compare the field.
    assert.equal((sw.shown[0]!.options.data as { path: string }).path, '/admin/users?recovery=r1');

    await sw.fire('push', { data: { json: () => ({ title: 'x', link: 'https://evil.example' }) } });
    assert.equal((sw.shown[1]!.options.data as { path: string }).path, DEFAULT_NOTIFICATION_PATH);
  });

  it('still shows a generic notification for an empty or broken payload', async () => {
    const sw = loadServiceWorker();
    await sw.fire('push', { data: null });
    await sw.fire('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
      },
    });
    assert.deepEqual(
      sw.shown.map((s) => s.title),
      ['NGAO360', 'NGAO360'],
    );
  });

  it('on click, moves an open app tab to the deep link, or opens one', async () => {
    const tab: FakeClient = {
      url: `${ORIGIN}/dashboard`,
      focused: false,
      navigatedTo: null,
      navigate: async (u) => {
        tab.navigatedTo = u;
        return tab;
      },
      focus: async () => {
        tab.focused = true;
        return tab;
      },
    };
    const withTab = loadServiceWorker([tab]);
    let closed = false;
    await withTab.fire('notificationclick', { notification: { data: { path: '/tasks/7' }, close: () => (closed = true) } });
    assert.ok(closed);
    assert.equal(tab.navigatedTo, `${ORIGIN}/tasks/7`);
    assert.ok(tab.focused);

    const none = loadServiceWorker([]);
    await none.fire('notificationclick', { notification: { data: { path: '//evil.example' }, close: () => undefined } });
    assert.deepEqual(none.opened, [`${ORIGIN}${DEFAULT_NOTIFICATION_PATH}`]);
  });
});
