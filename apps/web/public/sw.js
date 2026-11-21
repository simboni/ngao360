/*
 * NGAO360 service worker (shell only).
 * Blueprint 13.4: cache only the application shell and low-risk static assets.
 * NEVER cache API responses, result forms, evidence or other sensitive data.
 *
 * Field PWA (/m): the /m page shells are cached (they contain no data; all
 * data is fetched by the client) so the field app opens without a connection.
 * Queued field records live in the encrypted IndexedDB queue
 * (apps/web/src/lib/offline), never in this cache. A Background Sync event
 * only wakes open tabs of the app to upload; there is no upload with every
 * tab closed (the service worker does not hold the queue key's session).
 *
 * Push (CR AR9): the server sends { title, body, link, id } (no personal data). The notification
 * opens only a same-origin in-app path; anything else opens the notification centre.
 */
const VERSION = 'ngao360-shell-v3';
const SHELL = ['/offline', '/manifest.webmanifest', '/icons/icon.svg'];
/** Field app page shells, cached best-effort at install (a failure does not block install). */
const FIELD_SHELL = ['/m', '/m/report', '/m/incident', '/m/checkin', '/m/queue', '/m/submissions', '/m/forms'];
const FIELD_SYNC_TAG = 'ngao-field-sync';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL).then(() => Promise.all(FIELD_SHELL.map((p) => c.add(p).catch(() => undefined)))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isFieldShell(url) {
  return url.pathname === '/m' || url.pathname.startsWith('/m/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept API or file traffic.
  if (url.pathname.startsWith('/api/')) return;

  // Static build assets: cache-first (immutable, content-hashed).
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  if (req.mode === 'navigate') {
    if (isFieldShell(url)) {
      // Field app shells: network-first; keep the latest shell (path only, no query) for offline starts.
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res.ok && !res.redirected && res.type === 'basic' && (res.headers.get('content-type') || '').includes('text/html')) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(url.pathname, copy));
            }
            return res;
          })
          .catch(() =>
            caches
              .match(url.pathname, { ignoreSearch: true })
              .then((hit) => hit || caches.match('/m'))
              .then((hit) => hit || caches.match('/offline')),
          ),
      );
      return;
    }
    // Other navigations: network-first, offline page fallback. Pages are not cached.
    event.respondWith(fetch(req).catch(() => caches.match('/offline')));
  }
});

// Background Sync (where supported): ask open app tabs to upload the field queue.
self.addEventListener('sync', (event) => {
  if (event.tag !== FIELD_SYNC_TAG) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) c.postMessage({ type: FIELD_SYNC_TAG });
    }),
  );
});

/* ---------------------------------------------------------------------------------- push */

const DEFAULT_NOTIFICATION_PATH = '/notifications';

/** Same rules as safeNotificationPath in src/components/account/push-model.ts. */
function safeNotificationPath(link, origin) {
  if (typeof link !== 'string' || link.length === 0 || link.length > 512) return DEFAULT_NOTIFICATION_PATH;
  // eslint-disable-next-line no-control-regex
  if (!link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(link)) return DEFAULT_NOTIFICATION_PATH;
  try {
    const url = new URL(link, origin);
    if (url.origin !== new URL(origin).origin) return DEFAULT_NOTIFICATION_PATH;
    return url.pathname + url.search + url.hash;
  } catch (e) {
    return DEFAULT_NOTIFICATION_PATH;
  }
}

function readPushPayload(data) {
  if (!data) return {};
  try {
    const parsed = data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data);
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.slice(0, 120) : 'NGAO360';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : 'You have a new notification.';
  const id = typeof payload.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(payload.id) ? payload.id : null;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: id ? 'ngao-' + id : undefined,
      data: { path: safeNotificationPath(payload.link, self.location.origin) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(safeNotificationPath(data.path, self.location.origin), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Reuse an open app tab: move it to the linked screen and bring it forward.
        if ('navigate' in client) {
          // navigate() fails for a tab this worker does not control: open a new window instead.
          return client
            .navigate(target)
            .then((c) => (c ? c.focus() : self.clients.openWindow(target)))
            .catch(() => self.clients.openWindow(target));
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
