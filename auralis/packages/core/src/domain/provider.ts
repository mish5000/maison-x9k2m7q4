import type { RawSearchCandidate, SourceCategory } from './candidate.js';
import type { NormalizedSearchQuery, SearchMode } from './query.js';

export type RobotsPosture =
  'not_applicable' | 'respects_robots' | 'api_terms_only' | 'user_configured';

export type RateLimitStrategy =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed_window'; readonly requests: number; readonly windowMs: number }
  | { readonly kind: 'token_bucket'; readonly capacity: number; readonly refillPerSec: number }
  | { readonly kind: 'concurrency_only'; readonly maxConcurrent: number };

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
  /** HTTP statuses worth retrying. Deterministic 4xx are never retried. */
  readonly retryableStatuses: readonly number[];
}

/**
 * Everything the orchestrator needs to know about a provider without calling
 * it. Capabilities drive provider selection, query shaping and UI affordances.
 */
export interface ProviderCapabilities {
  readonly supportsTextSearch: boolean;
  readonly supportsExactTitleSearch: boolean;
  readonly returnsDirectMediaUrls: boolean;
  readonly supportsPreview: boolean;
  readonly requiresAuthentication: boolean;
  readonly rateLimit: RateLimitStrategy;
  readonly robotsPosture: RobotsPosture;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly cacheable: boolean;
  readonly exposesFileSize: boolean;
  readonly exposesDuration: boolean;
  readonly exposesBitrate: boolean;
  readonly supportsServerSideSearch: boolean;
  readonly supportsPagination: boolean;
  readonly supportsIncrementalStreaming: boolean;
  readonly maxConcurrentRequests: number;
  readonly sourceCategory: SourceCategory;
  /** Modes in which the orchestrator may select this provider. */
  readonly modes: readonly SearchMode[];
  /** Results are private to a workspace and must never enter a shared cache. */
  readonly producesPrivateResults: boolean;
  /** Human-readable list of what must be configured before this provider runs. */
  readonly requiredConfiguration: readonly string[];
}

export type ProviderStatus =
  'ready' | 'not_configured' | 'auth_required' | 'degraded' | 'unavailable' | 'disabled';

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: ProviderStatus;
  /** Safe summary shown on the diagnostics page. */
  readonly message: string;
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  /** Present when the provider needs setup; links to docs/providers/<id>.md */
  readonly setupDocPath: string | null;
}

/**
 * Per-search context handed to providers. Providers receive only what they
 * need; they never see the raw HTTP request, cookies, or other tenants' data.
 */
export interface SearchContext {
  readonly searchId: string;
  readonly workspaceId: string;
  readonly mode: SearchMode;
  /** Wall-clock deadline for this provider's contribution. */
  readonly deadlineMs: number;
  readonly maxCandidates: number;
  /** Resolved, decrypted configuration for this provider in this workspace. */
  readonly config: Readonly<Record<string, string>>;
  readonly logger: ProviderLogger;
  /** SSRF-hardened fetch. Providers must not use global fetch. */
  readonly fetch: SafeFetchFn;
  readonly now: () => number;
}

export interface ProviderLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SafeFetchOptions {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PROPFIND';
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Byte range request, inclusive. */
  readonly range?: { readonly start: number; readonly end: number };
  /** Allowed hosts, if the caller wants to narrow beyond the global policy. */
  readonly allowHosts?: readonly string[];
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
  readonly finalUrl: string;
  readonly finalHost: string;
  readonly finalIp: string;
  readonly redirectCount: number;
  readonly durationMs: number;
  text(): string;
  json<T = unknown>(): T;
}

export type SafeFetchFn = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>;

/**
 * The provider contract. Every source of results — public API, RSS feed,
 * directory listing, local folder, authenticated connector — implements this
 * and nothing else. Providers must:
 *   - stream candidates as they are found (yield early, yield often)
 *   - honour `signal` and `context.deadlineMs`
 *   - never perform their own network I/O outside `context.fetch`
 *   - never make access decisions beyond declaring a conservative starting point
 */
export interface SearchProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate>;
  healthCheck(context: ProviderHealthContext): Promise<ProviderHealth>;
}

export interface ProviderHealthContext {
  readonly config: Readonly<Record<string, string>>;
  readonly fetch: SafeFetchFn;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  jitter: true,
  retryableStatuses: Object.freeze([408, 425, 429, 500, 502, 503, 504] as const),
});
