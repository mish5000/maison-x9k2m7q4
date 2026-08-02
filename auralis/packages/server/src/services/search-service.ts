import {
  AuralisError,
  isTerminalEvent,
  type Logger,
  type Metrics,
  newCorrelationId,
  newSearchId,
  normalizeQuery,
  SearchOrchestrator,
  toDomainFilters,
  type CreateSearchResponse,
  type NormalizedSearchQuery,
  type ProviderRegistry,
  type SafeFetchFn,
  type SearchEvent,
  type RawSearchCandidate,
  type SearchProvider,
  type SearchResult,
  type VerifyResult,
  type SearchFiltersRequest,
  type SearchMode,
  budgetFor,
  type CircuitBreakerRegistry,
  API_BASE_PATH,
} from '@auralis/core';

import type { ConnectorRepository } from '../db/connectors.js';
import type { SearchRepository } from '../db/repositories.js';

/**
 * Search lifecycle management.
 *
 * A search is created synchronously (so the client gets an id immediately and
 * can open the event stream), then runs in the background. Events are buffered
 * per search so a client that connects a moment later, or reconnects, receives
 * everything from the beginning.
 */

const MAX_LIVE_SEARCHES_PER_WORKSPACE = 3;
const BUFFER_LIMIT = 4000;

interface LiveSearch {
  readonly searchId: string;
  readonly workspaceId: string;
  readonly controller: AbortController;
  readonly events: SearchEvent[];
  readonly subscribers: Set<(event: SearchEvent) => void>;
  finished: boolean;
  results: readonly SearchResult[];
}

export interface SearchServiceDeps {
  readonly registry: ProviderRegistry;
  readonly repository: SearchRepository;
  readonly connectors: ConnectorRepository;
  readonly fetch: SafeFetchFn;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly breakers: CircuitBreakerRegistry;
  readonly disabledProviderIds: ReadonlySet<string>;
  /** Static configuration for providers not backed by a connector. */
  readonly staticProviderConfig: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly previewUrlFor?: (result: SearchResult) => string | null;
  readonly verifyWithoutUrl?: (candidate: RawSearchCandidate) => Promise<VerifyResult | null>;
}

export interface CreateSearchInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly query: string;
  readonly mode: SearchMode;
  readonly filters: SearchFiltersRequest | undefined;
  readonly locale: string;
  readonly compatibilityProfileIds: readonly string[];
}

export class SearchService {
  private readonly live = new Map<string, LiveSearch>();
  /** In-flight executions, so shutdown can wait for them to unwind. */
  private readonly running = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly deps: SearchServiceDeps) {}

  create(input: CreateSearchInput): CreateSearchResponse {
    const activeForWorkspace = [...this.live.values()].filter(
      (search) => search.workspaceId === input.workspaceId && !search.finished,
    );
    if (activeForWorkspace.length >= MAX_LIVE_SEARCHES_PER_WORKSPACE) {
      throw new AuralisError(
        'rate_limited',
        'You have several searches running already. Wait for one to finish, or cancel it.',
      );
    }

    const normalized: NormalizedSearchQuery = normalizeQuery(input.query, {
      mode: input.mode,
      filters: toDomainFilters(input.filters),
      locale: input.locale,
    });

    const connectorState = this.deps.connectors.resolveAllByProvider(input.workspaceId);
    const configByProvider: Record<string, Readonly<Record<string, string>>> = {
      ...this.deps.staticProviderConfig,
    };
    for (const [providerId, config] of Object.entries(connectorState.configByProvider)) {
      configByProvider[providerId] = { ...(configByProvider[providerId] ?? {}), ...config };
    }

    const selection = this.deps.registry.select({
      mode: normalized.mode,
      requestedProviderIds: normalized.filters.providerIds,
      configByProvider,
      disabledProviderIds: this.deps.disabledProviderIds,
      canAttempt: (providerId) => this.deps.breakers.for(providerId).canAttempt(),
    });

    if (selection.selected.length === 0) {
      throw new AuralisError(
        'provider_unavailable',
        normalized.mode === 'connected'
          ? 'No connected sources are set up yet. Connect a source to search it.'
          : 'No sources are available for this search right now.',
        { details: { skipped: selection.skipped.map((entry) => entry.providerId) } },
      );
    }

    const searchId = newSearchId();
    const correlationId = newCorrelationId();
    const budget = budgetFor(normalized.mode);

    this.deps.repository.createSession({
      searchId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      mode: normalized.mode,
      locale: normalized.locale,
      rawQuery: normalized.raw,
      normalizedQuery: normalized.normalized,
      filters: normalized.filters,
      providerIds: selection.selected.map((provider) => provider.id),
      correlationId,
    });

    const search: LiveSearch = {
      searchId,
      workspaceId: input.workspaceId,
      controller: new AbortController(),
      events: [],
      subscribers: new Set(),
      finished: false,
      results: [],
    };
    this.live.set(searchId, search);

    const execution = this.execute(search, normalized, selection.selected, configByProvider, {
      validCredentialProviderIds: connectorState.validCredentialProviderIds,
      connectorIdByProvider: connectorState.connectorIdByProvider,
      compatibilityProfileIds: input.compatibilityProfileIds,
    });
    this.running.add(execution);
    void execution.finally(() => this.running.delete(execution));

    return {
      searchId,
      mode: normalized.mode,
      normalizedQuery: normalized.normalized,
      providerIds: selection.selected.map((provider) => provider.id),
      eventsUrl: `${API_BASE_PATH}/searches/${searchId}/events`,
      timeBudgetMs: budget.totalMs,
      correlationId,
    };
  }

  private async execute(
    search: LiveSearch,
    query: NormalizedSearchQuery,
    providers: readonly SearchProvider[],
    configByProvider: Readonly<Record<string, Readonly<Record<string, string>>>>,
    context: {
      readonly validCredentialProviderIds: ReadonlySet<string>;
      readonly connectorIdByProvider: Readonly<Record<string, string>>;
      readonly compatibilityProfileIds: readonly string[];
    },
  ): Promise<void> {
    const orchestrator = new SearchOrchestrator({
      registry: this.deps.registry,
      fetch: this.deps.fetch,
      logger: this.deps.logger.child({ searchId: search.searchId }),
      metrics: this.deps.metrics,
      breakers: this.deps.breakers,
      ...(this.deps.previewUrlFor ? { previewUrlFor: this.deps.previewUrlFor } : {}),
      ...(this.deps.verifyWithoutUrl ? { verifyWithoutUrl: this.deps.verifyWithoutUrl } : {}),
    });

    const emit = (event: SearchEvent): void => {
      if (search.events.length < BUFFER_LIMIT) search.events.push(event);
      if (this.closed) return;
      try {
        this.deps.repository.appendEvent(event);
      } catch {
        // Persistence of the event log must never break the live stream.
      }
      // Results are persisted as they stream so a download request that
      // arrives mid-search finds the row it needs.
      if (
        event.type === 'candidate_discovered' ||
        event.type === 'candidate_verified' ||
        event.type === 'candidate_enriched'
      ) {
        try {
          const localPath = asString(event.result, 'localPath');
          this.deps.repository.saveResult(search.searchId, search.workspaceId, event.result, {
            localPath,
            connectorId: context.connectorIdByProvider[event.result.source.providerId] ?? null,
          });
        } catch {
          // The client already has the result over the stream; persistence is
          // an optimisation for later requests, not part of delivery.
        }
      }
      if (event.type === 'candidate_rejected') {
        try {
          this.deps.repository.deleteResult(search.searchId, search.workspaceId, event.candidateId);
        } catch {
          // Same reasoning as above.
        }
      }
      if (event.type === 'provider_completed') {
        try {
          this.deps.repository.recordProviderSearch(
            search.searchId,
            event.providerId,
            event.outcome,
            event.candidateCount,
            event.durationMs,
          );
        } catch {
          // Same reasoning as above.
        }
      }
      for (const subscriber of search.subscribers) {
        try {
          subscriber(event);
        } catch {
          // A broken client connection must not affect the search.
        }
      }
      if (isTerminalEvent(event)) search.finished = true;
    };

    let status: 'completed' | 'cancelled' | 'failed' = 'completed';
    let partial = false;

    try {
      const results = await orchestrator.run(
        {
          searchId: search.searchId,
          workspaceId: search.workspaceId,
          query,
          providers,
          configByProvider,
          compatibilityProfileIds: context.compatibilityProfileIds,
          signal: search.controller.signal,
          validCredentialProviderIds: context.validCredentialProviderIds,
        },
        emit,
      );

      search.results = results;
      if (search.controller.signal.aborted) status = 'cancelled';

      const supplemental = new Map<
        string,
        { localPath?: string | null; connectorId?: string | null }
      >();
      for (const result of results) {
        const localPath = asString(result, 'localPath');
        supplemental.set(result.id, {
          localPath,
          connectorId: context.connectorIdByProvider[result.source.providerId] ?? null,
        });
      }

      partial = search.events.some((event) => event.type === 'search_completed' && event.partial);

      // Persistence is best-effort at this point: the client already has every
      // result over the event stream, and a shutting-down process must not
      // crash because its database closed underneath a finishing search.
      if (!this.closed) {
        try {
          this.deps.repository.saveResults(
            search.searchId,
            search.workspaceId,
            results,
            supplemental,
          );
          this.deps.repository.finishSession(search.searchId, status, results.length, partial);
        } catch {
          this.deps.logger.debug('Search results could not be persisted', {
            searchId: search.searchId,
          });
        }
      }
    } catch (error) {
      status = 'failed';
      this.deps.logger.error('Search execution failed', {
        searchId: search.searchId,
        code: error instanceof AuralisError ? error.code : 'internal_error',
      });
      if (!this.closed) {
        try {
          this.deps.repository.finishSession(search.searchId, status, 0, true);
        } catch {
          // See above: recording the outcome must not become a second failure.
        }
      }
    } finally {
      search.finished = true;
      // Give a late-connecting client a window to replay the buffer.
      setTimeout(() => this.live.delete(search.searchId), 120_000).unref?.();
    }
  }

  /**
   * Subscribes to a search. Buffered events are replayed first, so a client
   * that connects after the search started still sees everything.
   */
  subscribe(
    searchId: string,
    workspaceId: string,
    afterSeq: number,
    onEvent: (event: SearchEvent) => void,
  ): { readonly unsubscribe: () => void; readonly alreadyFinished: boolean } {
    const search = this.live.get(searchId);

    if (!search) {
      // The search is no longer live; replay the persisted event log.
      const session = this.deps.repository.getSession(searchId, workspaceId);
      if (!session) throw new AuralisError('not_found', 'That search could not be found.');
      for (const event of this.deps.repository.eventsSince(searchId, afterSeq)) onEvent(event);
      return { unsubscribe: () => undefined, alreadyFinished: true };
    }

    if (search.workspaceId !== workspaceId) {
      throw new AuralisError('not_found', 'That search could not be found.');
    }

    for (const event of search.events) {
      if (event.seq > afterSeq) onEvent(event);
    }

    if (search.finished) return { unsubscribe: () => undefined, alreadyFinished: true };

    search.subscribers.add(onEvent);
    return {
      unsubscribe: () => search.subscribers.delete(onEvent),
      alreadyFinished: false,
    };
  }

  cancel(searchId: string, workspaceId: string): boolean {
    const search = this.live.get(searchId);
    if (!search || search.workspaceId !== workspaceId) {
      const session = this.deps.repository.getSession(searchId, workspaceId);
      if (!session) throw new AuralisError('not_found', 'That search could not be found.');
      return false;
    }
    if (search.finished) return false;
    search.controller.abort();
    return true;
  }

  results(searchId: string, workspaceId: string): readonly SearchResult[] {
    const search = this.live.get(searchId);
    if (search && search.workspaceId === workspaceId && search.results.length > 0) {
      return search.results;
    }
    const session = this.deps.repository.getSession(searchId, workspaceId);
    if (!session) throw new AuralisError('not_found', 'That search could not be found.');
    return this.deps.repository.listResults(searchId, workspaceId);
  }

  status(
    searchId: string,
    workspaceId: string,
  ): {
    readonly searchId: string;
    readonly status: string;
    readonly resultCount: number;
    readonly partial: boolean;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly normalizedQuery: string;
    readonly mode: string;
  } {
    const session = this.deps.repository.getSession(searchId, workspaceId);
    if (!session) throw new AuralisError('not_found', 'That search could not be found.');
    return {
      searchId: session.id,
      status: session.status,
      resultCount: session.resultCount,
      partial: session.partial,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      normalizedQuery: session.normalizedQuery,
      mode: session.mode,
    };
  }

  /**
   * Aborts every live search and waits for their executions to unwind, so the
   * database is not closed while a search is still writing to it.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const search of this.live.values()) {
      if (!search.finished) search.controller.abort();
    }
    await Promise.allSettled([...this.running]);
    this.live.clear();
    this.running.clear();
  }
}

function asString(result: SearchResult, key: string): string | null {
  const value = result.providerExtras[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
