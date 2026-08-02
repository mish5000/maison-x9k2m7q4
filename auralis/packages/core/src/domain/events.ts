import type { SearchResult } from './candidate.js';

/**
 * The search event contract. This is a versioned wire format streamed over SSE.
 * Adding a field is a minor change; removing or repurposing one is a breaking
 * change and requires bumping SEARCH_EVENT_SCHEMA_VERSION.
 */
export const SEARCH_EVENT_SCHEMA_VERSION = 1;

export type SearchEventType =
  | 'search_started'
  | 'provider_started'
  | 'provider_completed'
  | 'candidate_discovered'
  | 'candidate_verified'
  | 'candidate_enriched'
  | 'candidate_rejected'
  | 'search_progress'
  | 'search_completed'
  | 'search_cancelled'
  | 'search_failed';

interface BaseEvent {
  readonly schemaVersion: number;
  readonly searchId: string;
  readonly seq: number;
  readonly at: string;
}

export interface SearchStartedEvent extends BaseEvent {
  readonly type: 'search_started';
  readonly mode: string;
  readonly normalizedQuery: string;
  readonly providerIds: readonly string[];
  readonly timeBudgetMs: number;
}

export interface ProviderStartedEvent extends BaseEvent {
  readonly type: 'provider_started';
  readonly providerId: string;
  readonly providerDisplayName: string;
}

export type ProviderOutcome =
  | 'ok'
  | 'empty'
  | 'timeout'
  | 'rate_limited'
  | 'error'
  | 'cancelled'
  | 'circuit_open'
  | 'not_configured'
  | 'auth_required';

export interface ProviderCompletedEvent extends BaseEvent {
  readonly type: 'provider_completed';
  readonly providerId: string;
  readonly outcome: ProviderOutcome;
  readonly candidateCount: number;
  readonly durationMs: number;
  /** Safe, user-facing message. Never contains internal diagnostics. */
  readonly message: string | null;
}

export interface CandidateDiscoveredEvent extends BaseEvent {
  readonly type: 'candidate_discovered';
  readonly providerId: string;
  readonly result: SearchResult;
}

export interface CandidateVerifiedEvent extends BaseEvent {
  readonly type: 'candidate_verified';
  readonly result: SearchResult;
}

export interface CandidateEnrichedEvent extends BaseEvent {
  readonly type: 'candidate_enriched';
  readonly result: SearchResult;
}

export type RejectionReason =
  | 'unsafe_url'
  | 'not_audio'
  | 'duplicate'
  | 'excluded_term'
  | 'filter_mismatch'
  | 'probe_failed'
  | 'oversized'
  | 'playlist_unresolved';

export interface CandidateRejectedEvent extends BaseEvent {
  readonly type: 'candidate_rejected';
  readonly providerId: string;
  readonly candidateId: string;
  readonly reason: RejectionReason;
  readonly detail: string | null;
}

export interface SearchProgressEvent extends BaseEvent {
  readonly type: 'search_progress';
  readonly providersTotal: number;
  readonly providersCompleted: number;
  readonly candidatesDiscovered: number;
  readonly candidatesVerified: number;
  readonly candidatesRejected: number;
  readonly resultsVisible: number;
  readonly elapsedMs: number;
}

export interface SearchCompletedEvent extends BaseEvent {
  readonly type: 'search_completed';
  readonly resultCount: number;
  readonly durationMs: number;
  readonly partial: boolean;
  readonly degradedProviderIds: readonly string[];
}

export interface SearchCancelledEvent extends BaseEvent {
  readonly type: 'search_cancelled';
  readonly reason: 'client_request' | 'timeout' | 'shutdown';
}

export interface SearchFailedEvent extends BaseEvent {
  readonly type: 'search_failed';
  readonly code: string;
  readonly message: string;
}

export type SearchEvent =
  | SearchStartedEvent
  | ProviderStartedEvent
  | ProviderCompletedEvent
  | CandidateDiscoveredEvent
  | CandidateVerifiedEvent
  | CandidateEnrichedEvent
  | CandidateRejectedEvent
  | SearchProgressEvent
  | SearchCompletedEvent
  | SearchCancelledEvent
  | SearchFailedEvent;

export const TERMINAL_EVENT_TYPES: ReadonlySet<SearchEventType> = new Set([
  'search_completed',
  'search_cancelled',
  'search_failed',
]);

export function isTerminalEvent(event: SearchEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}
