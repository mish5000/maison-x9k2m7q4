# ADR 0007 — Cache store abstraction

## Status

Accepted — 2026-08-02

## Context

Several things Auralis computes are worth not recomputing:

| What                                                | Natural TTL (`CACHE_TTL_MS`) |
| --------------------------------------------------- | ---------------------------- |
| Provider search results for public sources          | 5 min                        |
| Verified technical metadata for a stable URL        | 24 h                         |
| Provider health snapshots                           | 30 s                         |
| Query normalisation output                          | 10 min                       |
| Compatibility assessments, keyed by profile version | 24 h                         |

Technical metadata is the strongest case: it is a property of the bytes, so a
second search that meets the same URL should not re-issue a HEAD and two range
requests to learn the same facts.

But caching in this product carries a hard safety requirement. Results from an
authenticated connector, or from a folder the user selected, must never be
served to a different workspace. A cache is the classic place that goes wrong,
because the key is where tenancy is either encoded or lost.

There is also a deployment question that could not be answered up front: whether
Auralis would ever run as more than one process. ADR 0002 chose `node:sqlite`,
which is single-process by construction, so today it does not.

## Decision

Define a small `CacheStore` interface in `@auralis/core` and keep the key
builder separate from — and stricter than — the store.

```ts
interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<number>; // used on disconnect
  stats(): CacheStats; // hits, misses, entries, evictions
}
```

The interface is deliberately async even though the only implementation is
synchronous, so that substituting a network-backed store is not a change to
every call site.

Two implementations ship in `cache/store.ts`:

- `MemoryCacheStore` — bounded LRU with per-entry TTL. `maxEntries` defaults to
  5000; `get` re-inserts on hit to mark most-recently-used; `set` evicts from the
  front while over the bound; expired entries are dropped lazily on read.
- `NullCacheStore` — never caches. For when caching is disabled by
  configuration.

**Tenancy lives in the key, not in the store.** `cache/keys.ts` states the
invariant:

> a key is either `shared:` or `ws:<workspaceId>:`. Private providers can only
> ever produce workspace-scoped keys, and `buildProviderKey` throws if asked to
> do otherwise.

`buildProviderKey` raises `CacheScopeViolationError` when
`producesPrivateResults` or a `credentialFingerprint` is present but no
workspace was supplied. `buildTechnicalKey` does the same for private assets.
Every key mixes in `CACHE_SCHEMA_VERSION = 1`, so a change in what a key means
invalidates rather than mis-serves. The credential fingerprint
(`crypto/secrets.ts` `credentialFingerprint`, an HMAC truncated to 16 hex
characters) is a key component so rotating a credential invalidates that
workspace's cached results **without ever putting the credential in a key**.

`ttlForUrl` clamps the TTL of anything that looks signed: it reads `Expires`,
`expires` or `X-Amz-Expires` (interpreting the latter as a duration from
`X-Amz-Date`), returns 0 when already expired, and falls back to a 60 s ceiling
for any URL carrying `X-Amz-Signature` or `Signature`. A presigned URL is never
cached past its own validity.

`workspacePrefix(workspaceId)` and `connectorPrefix(workspaceId, providerId)`
exist so `deleteByPrefix` can evict a tenant's or a connector's entries on
disconnect.

## Consequences

### Positive

- Tenant isolation in the cache is enforced by a function that throws, not by a
  convention. A provider marked `producesPrivateResults` cannot get a shared key
  even by mistake.
- Rotating a credential invalidates the affected cache entries automatically,
  because the fingerprint is part of the digest.
- Signed URLs cannot outlive their signature in the cache.
- `MemoryCacheStore` is bounded, so an unbounded key space cannot exhaust
  memory; `stats()` exposes hits, misses, entries and evictions for the
  diagnostics view.
- `NullCacheStore` makes "no caching" a first-class configuration rather than a
  branch at every call site.
- The interface is four methods plus `stats()`. Anything that speaks
  get/set/delete/scan can implement it.

### Negative

- **Only the in-process bounded LRU is implemented today.** There is no Redis
  adapter in this repository. The header comment in `cache/store.ts` says _"A
  Redis-compatible adapter lives in the server package and implements the same
  interface"_ — that is **not accurate**: grepping the tree finds no such
  adapter. `AURALIS_REDIS_URL` is parsed by `config/env.ts` and surfaced as
  `AppConfig.redisUrl`, and nothing reads it; `app.ts` constructs
  `new MemoryCacheStore()` unconditionally. The abstraction is the seam, not the
  feature. Treat "swapping it is configuration rather than a code change" as the
  intent, not the current state.
- **The cache is not on any read or write path yet.** The only call anywhere in
  `packages/` is `context.cache.deleteByPrefix(...)` in
  `routes/connectors.ts`, when a connector is disconnected. Nothing calls
  `cache.get` or `cache.set`; `buildProviderKey`, `buildTechnicalKey`,
  `ttlForUrl`, `CACHE_TTL_MS` and `NullCacheStore` are all exported, all
  unit-testable and none of them wired in. So the TTL table above is a design,
  not an observed behaviour, and the scope-violation guarantee — while real and
  correct — currently protects a path nobody walks. The eviction-on-disconnect
  call is doing useful work only against entries that a future caching path
  would have written.
- **The cache is per-process, so its benefits and its bounds are per-process.**
  With more than one API process: N caches, N times the upstream traffic for the
  same query, no shared invalidation, and `deleteByPrefix` on disconnect only
  clears the process that handled the request.
- **The rate limiter has the same problem and the same seam.**
  `http/rate-limit.ts` holds fixed windows in a `Map` and says so: _"In a
  multi-process deployment this becomes per-process; the `CacheStore`
  abstraction is the seam where a shared counter would be substituted."_
  Four processes means four times the intended allowance per workspace.
- **The async interface costs something for nothing today.** Every `get`/`set`
  against `MemoryCacheStore` returns an already-resolved promise, so call sites
  pay an `await` and a microtask for a `Map` lookup. That is the price of not
  having to rewrite them later.
- **An unimplemented adapter is a maintenance hazard.** `CacheStore` has not
  been exercised against a store with real network failures, real serialisation
  constraints (values are held as live object references in memory; a Redis
  implementation would need to serialise, and `Uint8Array` payloads would need
  encoding), or real eviction semantics. The first real implementation will
  probably find the interface slightly wrong.
- **`deleteByPrefix` is an O(n) scan** over all keys in the memory store. Fine at
  5000 entries; a Redis implementation would need `SCAN` with its own
  consistency caveats.
- **`stats()` is synchronous** in an otherwise async interface, which a remote
  store cannot satisfy without caching its own counters locally.

## Alternatives considered

| Alternative                                                    | Why rejected                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No cache at all**                                            | Re-verifying the same URL on every search is the expensive part of the pipeline (HEAD + two range requests, up to `perVerificationMs` each) and the part most visible to upstream sources as load. Technical metadata is a property of the bytes and has a genuine 24-hour TTL. |
| **A concrete `MemoryCache` class with no interface**           | Would work today and would have to be unpicked from every call site the moment a shared store is needed. The interface costs one file and makes the eventual change local.                                                                                                      |
| **Redis as a hard dependency now**                             | Contradicts ADR 0002's clean-clone requirement: it means provisioning a server before a developer can run a search, for a benefit (shared state) that a single-process deployment does not need.                                                                                |
| **Caching inside each provider adapter**                       | Ten places to get key scoping right instead of one, and `buildProviderKey`'s throw-on-violation guarantee would become ten separate opportunities to omit the workspace id.                                                                                                     |
| **HTTP-layer caching (`Cache-Control` on upstream responses)** | Does not cover the things worth caching most — probe results, compatibility assessments, normalisation output — and delegates TTL to sources that are frequently wrong about it. It also cannot express the credential-fingerprint or signed-URL clamping rules.                |
| **Caching in SQLite**                                          | Turns every cache read into a disk-backed query, adds rows to a database whose retention policy is about user data rather than ephemera, and inherits exactly the same single-process limitation it would be adopted to fix.                                                    |
