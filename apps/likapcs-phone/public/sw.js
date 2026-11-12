/* LIKApcs Phone service worker (0.28.0).
 * Caches ONLY the app shell (this site's HTML, JS, CSS and icons) so the app opens without a
 * connection. It never caches /api or /ws: money and PC status always come live from the server. */
const CACHE = 'likapcs-phone-shell-v1';
// The app lives under /phone/ (its scope), so every shell path is built from the scope.
const SCOPE = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}icon-192.png`, `${SCOPE}icon-512.png`])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('likapcs-phone-shell-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL(SCOPE).pathname)) return;
  if (url.pathname.includes('/api/') || url.pathname.includes('/ws')) return;

  // Page loads: network first, the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(SCOPE)));
    return;
  }

  // Static files: cache first, then the network (and remember them).
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.includes('/assets/') || /\.(png|webmanifest|svg)$/.test(url.pathname))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
