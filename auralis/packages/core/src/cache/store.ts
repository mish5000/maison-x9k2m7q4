/**
 * Cache abstraction.
 *
 * The default implementation is in-process and bounded. A Redis-compatible
 * adapter lives in the server package and implements the same interface, so
 * swapping it is configuration rather than a code change.
 *
 * SECURITY INVARIANT: authenticated connector results never enter a shared
 * cache. `buildCacheKey` refuses to produce a shared-scope key for a private
 * provider — see cache/keys.ts.
 */

export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every key beginning with the prefix. Used on disconnect. */
  deleteByPrefix(prefix: string): Promise<number>;
  stats(): CacheStats;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly evictions: number;
}

export interface MemoryCacheOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/** Bounded LRU with per-entry TTL. Eviction is by least-recently-used. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 5000;
    this.now = options.now ?? Date.now;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      evictions: this.evictions,
    };
  }
}

/** A store that never caches. Used when caching is disabled by configuration. */
export class NullCacheStore implements CacheStore {
  async get<T>(): Promise<T | null> {
    return null;
  }
  async set(): Promise<void> {
    /* intentionally empty */
  }
  async delete(): Promise<void> {
    /* intentionally empty */
  }
  async deleteByPrefix(): Promise<number> {
    return 0;
  }
  stats(): CacheStats {
    return { hits: 0, misses: 0, entries: 0, evictions: 0 };
  }
}

export const CACHE_TTL_MS = Object.freeze({
  /** Provider search results for public sources. */
  providerResults: 5 * 60_000,
  /** Verified technical metadata for a stable URL. */
  technicalMetadata: 24 * 60 * 60_000,
  /** Provider health snapshots. */
  providerHealth: 30_000,
  /** Query normalisation output. */
  queryNormalisation: 10 * 60_000,
  /** Compatibility assessments, keyed by profile version. */
  compatibility: 24 * 60 * 60_000,
});
