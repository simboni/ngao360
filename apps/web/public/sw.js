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
 */
const VERSION = 'ngao360-shell-v2';
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
