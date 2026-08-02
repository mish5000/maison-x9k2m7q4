/**
 * Per-provider circuit breaker.
 *
 * A provider that is failing is skipped rather than retried, so one bad source
 * cannot consume the search's time budget. Deterministic 4xx responses are
 * classified as "the request was wrong", not "the provider is down", and never
 * open the circuit.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly successThreshold?: number;
  readonly openDurationMs?: number;
  readonly now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;

  constructor(
    readonly providerId: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 4;
    this.successThreshold = options.successThreshold ?? 2;
    this.openDurationMs = options.openDurationMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** True when a request may be attempted right now. */
  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half_open') return true;
    if (this.now() - this.openedAt >= this.openDurationMs) {
      this.state = 'half_open';
      this.consecutiveSuccesses = 0;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half_open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = 'closed';
        this.consecutiveSuccesses = 0;
      }
      return;
    }
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** A client-side mistake: counted, but never a reason to open the circuit. */
  recordClientError(): void {
    this.consecutiveFailures = 0;
  }

  currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openDurationMs) {
      return 'half_open';
    }
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = 0;
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  for(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(providerId, this.options);
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  states(): Readonly<Record<string, CircuitState>> {
    return Object.fromEntries([...this.breakers].map(([id, b]) => [id, b.currentState()]));
  }

  reset(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}

/** Statuses that mean "the request was wrong", not "the provider is broken". */
const DETERMINISTIC_CLIENT_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 406, 409, 410, 414, 415, 422,
]);

export function isDeterministicClientError(status: number): boolean {
  return DETERMINISTIC_CLIENT_STATUSES.has(status);
}

export function isRetryableStatus(status: number, retryable: readonly number[]): boolean {
  if (isDeterministicClientError(status)) return false;
  return retryable.includes(status);
}

/** Exponential backoff with full jitter, bounded by the policy maximum. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return jitter ? Math.round(random() * exponential) : exponential;
}
