/**
 * Pure helpers behind the push panel on /settings/account (CR AR9, API contract §31.2) and the
 * service worker's notification click (public/sw.js keeps an identical `safeNotificationPath`; the
 * tests run both against the same cases).
 */
import { type PushSubscribe, PushSubscribeSchema } from '@ngao360/shared';

/** VAPID public keys are URL-safe base64 without padding; the Push API wants the raw bytes. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushEnvironment {
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

export type PushSupport = 'SUPPORTED' | 'INSECURE' | 'UNSUPPORTED';

export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.secureContext) return 'INSECURE';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'UNSUPPORTED';
  return 'SUPPORTED';
}

export type PushPanelState = 'LOADING' | 'NOT_CONFIGURED' | 'INSECURE' | 'UNSUPPORTED' | 'NO_WORKER' | 'DENIED' | 'SUBSCRIBED' | 'NOT_SUBSCRIBED';

/** What the panel shows, in order of precedence (server first: nothing works without its key). */
export function pushPanelState(input: {
  configLoaded: boolean;
  vapidPublicKey: string | null;
  support: PushSupport;
  workerReady: boolean | null;
  permission: 'default' | 'granted' | 'denied';
  subscribedHere: boolean;
}): PushPanelState {
  if (!input.configLoaded) return 'LOADING';
  if (!input.vapidPublicKey) return 'NOT_CONFIGURED';
  if (input.support !== 'SUPPORTED') return input.support;
  if (input.workerReady === null) return 'LOADING';
  if (!input.workerReady) return 'NO_WORKER';
  if (input.subscribedHere && input.permission === 'granted') return 'SUBSCRIBED';
  if (input.permission === 'denied') return 'DENIED';
  return 'NOT_SUBSCRIBED';
}

export const PUSH_STATE_TEXT: Record<Exclude<PushPanelState, 'LOADING'>, string> = {
  NOT_CONFIGURED:
    'Push notifications are not set up on this server. You still see alerts in the notification centre, and by e-mail or SMS when you chose those channels.',
  INSECURE: 'Push notifications need a secure (https) connection.',
  UNSUPPORTED: 'This browser does not support push notifications. Alerts still appear in the notification centre.',
  NO_WORKER: 'Push notifications are not available in this browser session (the offline helper is not running). Reload the page, or use the installed app.',
  DENIED: 'Notifications are blocked for this site in your browser settings. Allow them there, then turn push on here.',
  SUBSCRIBED: 'This device receives push notifications for your alerts.',
  NOT_SUBSCRIBED: 'This device does not receive push notifications.',
};

/** Body for POST /me/push/subscriptions from `PushSubscription.toJSON()`; null if unusable. */
export function subscriptionBody(json: { endpoint?: string | null; keys?: Record<string, string> | null }, deviceLabel: string | null): PushSubscribe | null {
  const parsed = PushSubscribeSchema.safeParse({
    endpoint: json.endpoint ?? '',
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    ...(deviceLabel ? { deviceLabel: deviceLabel.slice(0, 100) } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Remembers which server subscription belongs to this browser (only its id; no endpoint or keys). */
export const PUSH_SUBSCRIPTION_STORAGE_KEY = 'ngao360.push.subscriptionId';

export function readStoredSubscriptionId(storage: Pick<Storage, 'getItem'> | null | undefined): string | null {
  try {
    const v = storage?.getItem(PUSH_SUBSCRIPTION_STORAGE_KEY) ?? null;
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredSubscriptionId(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, id: string | null): void {
  try {
    if (id) storage?.setItem(PUSH_SUBSCRIPTION_STORAGE_KEY, id);
    else storage?.removeItem(PUSH_SUBSCRIPTION_STORAGE_KEY);
  } catch {
    /* storage blocked: the panel still works, it just cannot tell which row is this device */
  }
}

export const DEFAULT_NOTIFICATION_PATH = '/notifications';

/**
 * In-app path a notification click may open. Only same-origin paths ("/…", not "//…" or "/\\…"),
 * no control characters, at most 512 characters; anything else opens the notification centre.
 * Mirrors `safeNotificationPath` in public/sw.js.
 */
export function safeNotificationPath(link: unknown, origin: string): string {
  if (typeof link !== 'string' || link.length === 0 || link.length > 512) return DEFAULT_NOTIFICATION_PATH;
  // eslint-disable-next-line no-control-regex
  if (!link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(link)) return DEFAULT_NOTIFICATION_PATH;
  try {
    const url = new URL(link, origin);
    if (url.origin !== new URL(origin).origin) return DEFAULT_NOTIFICATION_PATH;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_NOTIFICATION_PATH;
  }
}
