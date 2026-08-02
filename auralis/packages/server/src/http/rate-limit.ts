import { AuralisError } from '@auralis/core';

/**
 * Request rate limiting, keyed by workspace rather than by IP so a shared
 * network is not penalised and a single tenant cannot exhaust the process.
 *
 * The implementation is a fixed-window counter held in memory. In a
 * multi-process deployment this becomes per-process; the `CacheStore`
 * abstraction is the seam where a shared counter would be substituted, and
 * that trade-off is recorded in docs/adr/0007-cache-store-abstraction.md.
 */

interface WindowState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws when the caller has exceeded its allowance. */
  assertWithinLimit(key: string, action: string): void {
    const result = this.consume(key);
    if (!result.allowed) {
      throw new AuralisError(
        'rate_limited',
        `Too many ${action} requests. Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`,
        { details: { retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) } },
      );
    }
  }

  consume(key: string): {
    readonly allowed: boolean;
    readonly retryAfterMs: number;
    readonly remaining: number;
  } {
    const now = this.now();
    const state = this.windows.get(key);

    if (!state || state.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { allowed: true, retryAfterMs: 0, remaining: this.limit - 1 };
    }

    if (state.count >= this.limit) {
      return { allowed: false, retryAfterMs: state.resetAt - now, remaining: 0 };
    }

    state.count += 1;
    return { allowed: true, retryAfterMs: 0, remaining: this.limit - state.count };
  }

  private sweep(now: number): void {
    if (this.windows.size < 5000) return;
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }
}
