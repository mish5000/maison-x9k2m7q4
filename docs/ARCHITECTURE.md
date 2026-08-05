# Architecture

PRIVÉE is a static site with no server, no framework and no build step in this
repository. Three constraints shaped every decision below, and they are worth
holding in mind before changing anything:

1. **Target is iPhone Safari, installed to the home screen.** Not desktop
   Chrome. WebKit's behaviour is the specification that matters.
2. **The Cache API quota on iOS is roughly 50 MB.** The shell alone is ~1.5 MB
   and `assets/` is ~113 MB, so nothing may be precached wholesale.
3. **A failure in the offline layer must never prevent the app from loading.**
   Degrading to "online only" is acceptable. Degrading to "blank screen" is not.

---

## The single-file shell

`index.html` is ~1.5 MB and contains the markup, the styles and the whole
application in one file. This is deliberate, not laziness:

- **One request, one cache entry.** The service worker caches the shell under a
  single key (`./`). A split bundle would mean coordinating several entries that
  can individually fail or fall out of quota, and a partially-cached app is worse
  than an uncached one.
- **No build step means no build drift.** What is committed is byte-for-byte what
  is served. There is no compile output to get stale, and a rollback is a
  `git revert` with nothing to regenerate.
- **First paint does not wait on the network.** An inline `#boot` splash — the
  gold `M` and the progress bar — renders from the first bytes of the document,
  before any script has parsed.

The tradeoff is real: the file is hostile to line-level diffs and merges. Treat
it as a build artifact that happens to be committed. Edit the source in
`apps/privee` in the `anthropic-daily` repository and redeploy the whole file.

## Data loading

The app fetches three JSON sidecars at runtime, each with a `?ts=<epoch>` query
string to defeat the HTTP cache:

| File | Purpose |
| --- | --- |
| `version.json` | Build number. Polled to detect that a newer deploy is live |
| `dishes.json` | Restaurants and signature dishes, ~138 KB |
| `lineups.json` | Nightclub line-ups by date, ~21 KB |

Splitting these out of the shell is what allows a data refresh — a nightly
line-up scrape, say — without republishing the 1.5 MB document or invalidating
anyone's cached shell.

## Service worker

`sw.js` runs three distinct strategies, chosen per request. The choice matters:

**Navigations — cache-first, network fallback.** The cached shell is served
instantly when present, which is what makes the installed app open without a
spinner. If nothing is cached and the network is down, a minimal inline offline
card is returned rather than the browser's error page.

**The three JSON sidecars — network-first, cache fallback.** Freshness wins for
data; a stale line-up is worse than no line-up. The cached copy is only a
backstop for offline.

**Everything else (photos, icons, manifest) — cache-first, cache-on-view.** An
image is cached the first time it is actually displayed. Coverage grows with what
you browse, which keeps the footprint bounded by real usage instead of by the
113 MB in `assets/`.

### Two non-obvious invariants

**Cache keys are normalised to strip the query string** (`keyFor()`). This is not
a tidiness measure. Because the app appends `?ts=<epoch>` to every sidecar fetch,
and the Cache API keys on the full URL, the un-normalised version stored a new,
permanently unreachable entry on every launch — roughly 15 MB of garbage per 100
launches against a 50 MB quota. It also silently broke offline for exactly those
files: the timestamp at read never matched the one at write, so the fallback
`caches.match(req)` could never hit, and offline fell through to `{}`. Normalise
on **both** `put` and `match`, or neither works.

**The shell is cached by an independent background fetch** (`cacheShellOnce()`),
never by cloning the response handed to the page. Cloning ties the page's
response to the cache write, so an iOS quota stall on a ~1.5 MB body stalls the
page itself. Decoupling them is what guarantees constraint 3 above: every cache
operation in this file is wrapped so that quota errors, storage failures and
offline states degrade to "no offline mode" and never to "no app".

`sweepTimestamped()` is the one-time migration that deletes entries left behind
by the leaking version. It is bounded to 500 deletions per activation so a large
cache cannot stall activation into a loop.

Bumping the `CACHE` constant (currently `privee-shell-v2`) invalidates every
cached entry — the `activate` handler deletes any cache whose name is not the
current one. Do that only when the shell and the cache strategy must change
together.

## Assets

1,997 JPEGs, ~113 MB, committed and served from the same origin. Hosting them
locally rather than hot-linking a CDN is what makes offline viewing possible at
all, and it removes a third-party dependency from the critical path. The cost is
repository size: a full clone is ~280 MB. Use `--depth 1` unless you need
history.

## What is deliberately absent

- **No framework.** The interaction model is a card feed and a calendar; a
  runtime would add more weight than it removes.
- **No bundler, no transpiler, no `package.json`.** There is nothing to build.
- **No analytics, no telemetry, no third-party scripts.** The document carries
  `noindex, nofollow` and the app is private by intent. The only outbound call to
  a third party is the TinyURL shortener, invoked on an explicit share action.
