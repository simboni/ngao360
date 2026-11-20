/*
 * NGAO360 service worker (shell only).
 * Blueprint 13.4: cache only the application shell and low-risk static assets.
 * NEVER cache API responses, result forms or other sensitive data.
 * Offline draft queues (IndexedDB, encrypted) are added by the field/tally PWA work.
 */
const VERSION = 'ngao360-shell-v1';
const SHELL = ['/offline', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

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

  // Navigations: network-first, offline page fallback. Pages are not cached.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline')));
  }
});
