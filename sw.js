/* PRIVÉE offline shell — v2.
   Safety-first: the service worker must NEVER be able to stop the app
   from loading. It serves the cached shell instantly when present, but
   caches via an INDEPENDENT background fetch (it never clones or locks
   the response handed to the page — an iOS cache-quota stall on the
   ~50MB shell must not stall the page). Online always works; offline
   works once the shell has been cached by one good online load. */
const CACHE = 'privee-shell-v2';

/* Cache key = the URL WITHOUT its query string.
   The app fetches lineups.json, dishes.json and version.json with
   `?ts=' + Date.now()` to defeat the HTTP cache. The Cache API keys on the
   FULL url, so every launch stored a new, permanently unreachable entry —
   dishes.json alone is ~138KB, roughly 15MB of garbage per 100 launches
   against the ~50MB iOS quota this file's own header names as the
   constraint. It also silently broke offline for exactly these files: the
   timestamp at read never equals the one at write, so the fallback
   `caches.match(req)` could never hit and offline fell through to `{}`.
   The baked seeds masked it. Normalise on BOTH put and match. */
const keyFor = (req) => {
  try { const u = new URL(req.url); u.search = ''; return u.toString(); }
  catch (_) { return req; }
};
const SHELL = './';
const OFFLINE_HTML =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0b0a08;color:#e8c980;font-family:Georgia,serif;text-align:center;padding:32px">' +
  '<div><div style="font-size:64px;letter-spacing:.05em">M</div>' +
  '<p style="font-family:system-ui,sans-serif;font-size:13px;letter-spacing:.18em;' +
  'text-transform:uppercase;color:#f4efe6;opacity:.7;margin-top:18px">Reconnect once to summon PRIVÉE</p></div></body>';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // purge any older (possibly incomplete) cache from a prior worker
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    await sweepTimestamped();        // clean what earlier versions leaked
    await cacheShellOnce();          // grab the shell the moment we take control
  })());
});

self.addEventListener('message', (e) => {
  if (e.data !== 'flush') return;
  e.waitUntil((async () => {
    await caches.delete(CACHE);
    if (e.source) e.source.postMessage('flushed');
  })());
});

/* One-time cleanup for installs that ran the leaking version: drop every
   entry carrying a query string. Bounded — it walks the existing key list
   once and deletes only what it matched, so a huge cache cannot stall
   activation into a loop. */
async function sweepTimestamped() {
  try {
    const c = await caches.open(CACHE);
    const keys = await c.keys();
    let n = 0;
    for (const req of keys) {
      if (n >= 500) break;                       // hard bound on one activation
      try { if (new URL(req.url).search) { await c.delete(req); n++; } } catch (_) {}
    }
  } catch (_) { /* quota or unsupported — never block activation */ }
}

/* cache the whole shell in the background, at most once, reusing the copy
   the browser already downloaded (force-cache) so it costs no extra data.
   Fully decoupled from any response served to the page. */
async function cacheShellOnce() {
  try {
    if (await caches.match(SHELL)) return;
    const copy = await fetch(SHELL, { cache: 'force-cache' });
    if (copy && copy.ok) await (await caches.open(CACHE)).put(SHELL, copy);
  } catch (_) { /* quota or offline — offline mode simply stays unavailable */ }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  const isNav = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  // dishes.json was missing here, so the largest of the three fell through to
  // the CACHE-FIRST generic branch — worst case: never a hit, a new entry every
  // launch, and a stale list served forever once one was stored.
  const isSidecar = url.pathname.endsWith('version.json')
    || url.pathname.endsWith('lineups.json')
    || url.pathname.endsWith('dishes.json');

  if (isNav) {
    e.respondWith((async () => {
      const cached = await caches.match(SHELL);
      if (cached) {                      // instant open + offline
        e.waitUntil(cacheShellOnce());   // (no-op if already cached)
        return cached;
      }
      try {
        const net = await fetch(req);    // first time: live, then cache in bg
        if (net && net.ok) e.waitUntil(cacheShellOnce());
        return net;
      } catch (_) {
        return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  if (isSidecar) {                        // network-first, cache fallback
    e.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        (await caches.open(CACHE)).put(keyFor(req), net.clone());
        return net;
      } catch (_) {
        return (await caches.match(keyFor(req))) ||
          new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // photos (assets/*.jpg), icons, manifest: cache-first, and cache-on-view so
  // any image you've actually looked at is available offline. Bounded by what
  // you browse — never a full precache, which would blow the iOS ~50MB quota.
  e.respondWith((async () => {
    const cached = await caches.match(keyFor(req));
    if (cached) return cached;
    try {
      const net = await fetch(req);
      if (net && net.ok && /\.(jpg|jpeg|png|json|webmanifest)$/.test(url.pathname)) {
        const copy = net.clone();
        e.waitUntil((async () => {
          try { await (await caches.open(CACHE)).put(keyFor(req), copy); } catch (_) {}
        })());
      }
      return net;
    } catch (_) { return Response.error(); }
  })());
});
