/* SemiAnalysis Brief — tiny offline shell. Scope is ./ so it never interferes
   with the PRIVÉE worker at the repository root. The data file is always
   fetched from the network; the page itself is cached for instant opens. */
const CACHE = 'sa-brief-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/briefs.json')) return;           // always live (page has its own offline copy)
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()).catch(() => {}); }
      return net;
    } catch (_) {
      const cached = await caches.match(req, { ignoreSearch: true });
      return cached || caches.match('./index.html');
    }
  })());
});
