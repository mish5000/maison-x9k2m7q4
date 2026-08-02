import type { RateLimitStrategy } from '../domain/provider.js';
import type { SearchMode } from '../domain/query.js';

/**
 * Concurrency, rate limiting and time budgets.
 *
 * These are bulkheads: a slow or greedy provider is confined to its own lane
 * and cannot exhaust the search's time or the process's sockets.
 */

export interface SearchBudget {
  /** Total wall-clock allowance for the whole search. */
  readonly totalMs: number;
  /** Allowance for a single provider's contribution. */
  readonly perProviderMs: number;
  /** Allowance for verifying one candidate. */
  readonly perVerificationMs: number;
  /** Maximum candidates accepted from one provider. */
  readonly maxCandidatesPerProvider: number;
  /** Maximum candidates verified with network probes. */
  readonly maxVerifications: number;
  /** Maximum results retained for a search. */
  readonly maxResults: number;
  /** Concurrent verification probes. */
  readonly verificationConcurrency: number;
}

const BUDGET_TABLE: Readonly<Record<SearchMode, SearchBudget>> = Object.freeze({
  quick: {
    totalMs: 12_000,
    perProviderMs: 6_000,
    perVerificationMs: 4_000,
    maxCandidatesPerProvider: 25,
    maxVerifications: 30,
    maxResults: 120,
    verificationConcurrency: 6,
  },
  deep: {
    totalMs: 45_000,
    perProviderMs: 20_000,
    perVerificationMs: 8_000,
    maxCandidatesPerProvider: 80,
    maxVerifications: 140,
    maxResults: 400,
    verificationConcurrency: 8,
  },
  connected: {
    totalMs: 25_000,
    perProviderMs: 15_000,
    perVerificationMs: 6_000,
    maxCandidatesPerProvider: 100,
    maxVerifications: 80,
    maxResults: 300,
    verificationConcurrency: 4,
  },
});

export const BUDGETS = BUDGET_TABLE;

/** Returns the budget for a mode. Never undefined, whatever the input. */
export function budgetFor(mode: SearchMode): SearchBudget {
  return BUDGET_TABLE[mode] ?? BUDGET_TABLE.quick;
}

/** A counting semaphore. Used to bound concurrency per provider and globally. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('aborted');
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseOnce();
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('aborted'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    this.available -= 1;
    return this.releaseOnce();
  }

  get inFlight(): number {
    return this.capacity - this.available;
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/** Token bucket used for provider rate limits. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Attempts to take a token. Returns the wait in ms when none is available. */
  tryTake(): { readonly allowed: boolean; readonly retryAfterMs: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const deficit = 1 - this.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((deficit / this.refillPerSecond) * 1000) };
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }
}

export interface RateLimiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  tryConsume(): { readonly allowed: boolean; readonly retryAfterMs: number };
}

export function createRateLimiter(
  strategy: RateLimitStrategy,
  maxConcurrent: number,
  now: () => number = Date.now,
): RateLimiter {
  const semaphore = new Semaphore(Math.max(1, maxConcurrent));

  switch (strategy.kind) {
    case 'none':
    case 'concurrency_only':
      return {
        acquire: (signal) => semaphore.acquire(signal),
        tryConsume: () => ({ allowed: true, retryAfterMs: 0 }),
      };
    case 'token_bucket': {
      const bucket = new TokenBucket(strategy.capacity, strategy.refillPerSec, now);
      return {
        acquire: (signal) => semaphore.acquire(signal),
        tryConsume: () => bucket.tryTake(),
      };
    }
    case 'fixed_window': {
      const bucket = new TokenBucket(
        strategy.requests,
        strategy.requests / (strategy.windowMs / 1000),
        now,
      );
      return {
        acquire: (signal) => semaphore.acquire(signal),
        tryConsume: () => bucket.tryTake(),
      };
    }
  }
}

/** Runs `fn` with a deadline, rejecting with a timeout when it is exceeded. */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Consumes an async iterable with a hard item cap and abort support, so a
 * provider that never stops yielding cannot stall the search.
 */
export async function* takeUntil<T>(
  source: AsyncIterable<T>,
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<T> {
  let count = 0;
  for await (const item of source) {
    if (signal.aborted) return;
    yield item;
    count += 1;
    if (count >= limit) return;
  }
}
