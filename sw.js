/* PRIVÉE offline shell — instant opens and full airplane-mode use.
   The whole app is one ~50MB file; cache it once and serve it from
   the device thereafter. The tiny sidecars (version.json, lineups.json)
   stay network-first so freshness and self-update still work online. */
const CACHE = 'privee-shell-v1';
const SHELL = './';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      // force-cache reuses the copy the browser just downloaded for the
      // page load, so precaching rarely costs a second download
      const res = await fetch(SHELL, { cache: 'force-cache' });
      if (res && res.ok) await c.put(SHELL, res.clone());
    } catch (_) { /* offline at install — the first online launch will cache */ }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* the app asks us to drop the cached shell when it knows a newer build
   exists (pull-to-refresh, or the version poller) — the next navigation
   then refetches fresh and re-caches it */
self.addEventListener('message', (e) => {
  if (e.data !== 'flush') return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const r of await c.keys()) {
      const u = new URL(r.url);
      if (u.pathname.endsWith('/') || u.pathname.endsWith('index.html')) await c.delete(r);
    }
    if (e.source) e.source.postMessage('flushed');
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // sidecars: network-first so online users get today's data, offline
  // users get the last-known copy
  if (url.pathname.endsWith('version.json') || url.pathname.endsWith('lineups.json')) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        (await caches.open(CACHE)).put(req, net.clone());
        return net;
      } catch (_) {
        return (await caches.match(req)) ||
          new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  const isNav = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  // the app shell + assets: cache-first (instant + offline), populated on
  // first fetch; the shell is keyed ignoring the ?r= cache-bust
  e.respondWith((async () => {
    const cached = await caches.match(isNav ? SHELL : req);
    if (cached) return cached;
    try {
      const net = await fetch(req);
      if (net && net.ok && (isNav || /\.(png|json|webmanifest)$/.test(url.pathname))) {
        (await caches.open(CACHE)).put(isNav ? SHELL : req, net.clone());
      }
      return net;
    } catch (_) {
      return (await caches.match(SHELL)) || Response.error();
    }
  })());
});
