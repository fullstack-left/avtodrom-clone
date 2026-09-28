// Minimal offline cache for the PWA build. Caches the app shell and streams
// large assets (GLB/HDR/textures) into a runtime cache on first use.
const SHELL = 'avtoshahar-shell-v2';
const RUNTIME = 'avtoshahar-runtime-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Cache-first for versioned build assets and media, network-first for HTML.
  if (req.destination === 'document') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(RUNTIME).then((c) => c.put(req, copy));
      return res;
    }).catch(() => hit)),
  );
});
