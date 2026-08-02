/**
 * Owns one search: creating it, consuming its event stream, and reducing that
 * stream into the shape the interface renders.
 *
 * Events arrive faster than React should re-render, so they are buffered in a
 * ref and flushed once per animation frame. Results are keyed by `result.id`;
 * a later event for the same id replaces the earlier one, which is exactly the
 * discovered -> verified -> enriched progression the engine emits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cancelSearch, createSearch, toCorrelationId, toUserMessage } from '../api/client.js';
import type {
  CreateSearchPayload,
  CreateSearchResponse,
  ProviderOutcome,
  SearchEvent,
  SearchMode,
  SearchResult,
} from '../api/types.js';

export type SearchStatus = 'idle' | 'starting' | 'streaming' | 'completed' | 'cancelled' | 'failed';

export type ProviderRunState = 'pending' | 'searching' | ProviderOutcome;

export interface ProviderRun {
  readonly id: string;
  readonly displayName: string;
  readonly state: ProviderRunState;
  readonly candidateCount: number;
  readonly durationMs: number | null;
  readonly message: string | null;
}

export interface SearchProgress {
  readonly providersTotal: number;
  readonly providersCompleted: number;
  readonly candidatesDiscovered: number;
  readonly candidatesVerified: number;
  readonly candidatesRejected: number;
  readonly resultsVisible: number;
  readonly elapsedMs: number;
}

export interface SearchSession {
  readonly status: SearchStatus;
  readonly searchId: string | null;
  readonly query: string;
  readonly normalizedQuery: string | null;
  readonly mode: SearchMode | null;
  readonly timeBudgetMs: number | null;
  readonly results: readonly SearchResult[];
  readonly providers: readonly ProviderRun[];
  readonly progress: SearchProgress;
  readonly partial: boolean;
  readonly degradedProviderIds: readonly string[];
  readonly errorMessage: string | null;
  readonly correlationId: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly cancelRequested: boolean;
  readonly connectionLost: boolean;
}

const EMPTY_PROGRESS: SearchProgress = {
  providersTotal: 0,
  providersCompleted: 0,
  candidatesDiscovered: 0,
  candidatesVerified: 0,
  candidatesRejected: 0,
  resultsVisible: 0,
  elapsedMs: 0,
};

interface InternalState {
  readonly status: SearchStatus;
  readonly searchId: string | null;
  readonly query: string;
  readonly normalizedQuery: string | null;
  readonly mode: SearchMode | null;
  readonly timeBudgetMs: number | null;
  readonly resultsById: ReadonlyMap<string, SearchResult>;
  readonly providersById: ReadonlyMap<string, ProviderRun>;
  readonly providerOrder: readonly string[];
  readonly progress: SearchProgress;
  readonly partial: boolean;
  readonly degradedProviderIds: readonly string[];
  readonly errorMessage: string | null;
  readonly correlationId: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly cancelRequested: boolean;
  readonly connectionLost: boolean;
}

const IDLE_STATE: InternalState = {
  status: 'idle',
  searchId: null,
  query: '',
  normalizedQuery: null,
  mode: null,
  timeBudgetMs: null,
  resultsById: new Map(),
  providersById: new Map(),
  providerOrder: [],
  progress: EMPTY_PROGRESS,
  partial: false,
  degradedProviderIds: [],
  errorMessage: null,
  correlationId: null,
  startedAtMs: null,
  endedAtMs: null,
  cancelRequested: false,
  connectionLost: false,
};

const TERMINAL: ReadonlySet<SearchStatus> = new Set(['completed', 'cancelled', 'failed']);

function withProvider(
  state: InternalState,
  id: string,
  patch: Partial<ProviderRun> & { displayName?: string },
): InternalState {
  const existing = state.providersById.get(id);
  const next: ProviderRun = {
    id,
    displayName: patch.displayName ?? existing?.displayName ?? id,
    state: patch.state ?? existing?.state ?? 'pending',
    candidateCount: patch.candidateCount ?? existing?.candidateCount ?? 0,
    durationMs: patch.durationMs ?? existing?.durationMs ?? null,
    message: patch.message !== undefined ? patch.message : (existing?.message ?? null),
  };
  const providersById = new Map(state.providersById);
  providersById.set(id, next);
  const providerOrder = state.providerOrder.includes(id)
    ? state.providerOrder
    : [...state.providerOrder, id];
  return { ...state, providersById, providerOrder };
}

function applyEvent(state: InternalState, event: SearchEvent): InternalState {
  switch (event.type) {
    case 'search_started': {
      let next: InternalState = {
        ...state,
        status: 'streaming',
        normalizedQuery: event.normalizedQuery,
        timeBudgetMs: event.timeBudgetMs,
        progress: { ...state.progress, providersTotal: event.providerIds.length },
      };
      for (const providerId of event.providerIds) {
        next = withProvider(next, providerId, { state: 'pending' });
      }
      return next;
    }

    case 'provider_started':
      return withProvider(state, event.providerId, {
        state: 'searching',
        displayName: event.providerDisplayName,
      });

    case 'provider_completed':
      return withProvider(state, event.providerId, {
        state: event.outcome,
        candidateCount: event.candidateCount,
        durationMs: event.durationMs,
        message: event.message,
      });

    case 'candidate_discovered':
    case 'candidate_verified':
    case 'candidate_enriched': {
      const resultsById = new Map(state.resultsById);
      resultsById.set(event.result.id, event.result);
      return { ...state, resultsById };
    }

    case 'candidate_rejected': {
      if (!state.resultsById.has(event.candidateId)) {
        return state;
      }
      const resultsById = new Map(state.resultsById);
      resultsById.delete(event.candidateId);
      return { ...state, resultsById };
    }

    case 'search_progress':
      return {
        ...state,
        progress: {
          providersTotal: event.providersTotal,
          providersCompleted: event.providersCompleted,
          candidatesDiscovered: event.candidatesDiscovered,
          candidatesVerified: event.candidatesVerified,
          candidatesRejected: event.candidatesRejected,
          resultsVisible: event.resultsVisible,
          elapsedMs: event.elapsedMs,
        },
      };

    case 'search_completed':
      return {
        ...state,
        status: 'completed',
        partial: event.partial,
        degradedProviderIds: event.degradedProviderIds,
        endedAtMs: Date.now(),
        connectionLost: false,
        progress: { ...state.progress, elapsedMs: event.durationMs },
      };

    case 'search_cancelled':
      return {
        ...state,
        status: 'cancelled',
        endedAtMs: Date.now(),
        connectionLost: false,
      };

    case 'search_failed':
      return {
        ...state,
        status: 'failed',
        errorMessage: event.message,
        endedAtMs: Date.now(),
        connectionLost: false,
      };

    default:
      return state;
  }
}

function isSearchEvent(value: unknown): value is SearchEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

const STREAMED_EVENT_TYPES: readonly SearchEvent['type'][] = [
  'search_started',
  'provider_started',
  'provider_completed',
  'candidate_discovered',
  'candidate_verified',
  'candidate_enriched',
  'candidate_rejected',
  'search_progress',
  'search_completed',
  'search_cancelled',
  'search_failed',
];

export interface StartSearchInput {
  readonly query: string;
  readonly mode: SearchMode;
  readonly filters?: CreateSearchPayload['filters'];
  readonly compatibilityProfileIds: readonly string[];
  readonly locale: string;
}

export interface SearchStreamApi {
  readonly session: SearchSession;
  readonly start: (input: StartSearchInput) => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly isActive: boolean;
}

export function useSearchStream(): SearchStreamApi {
  const [state, setState] = useState<InternalState>(IDLE_STATE);
  const sourceRef = useRef<EventSource | null>(null);
  const bufferRef = useRef<SearchEvent[]>([]);
  const frameRef = useRef<number | null>(null);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const closeStream = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    bufferRef.current = [];
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const flush = useCallback(() => {
    frameRef.current = null;
    const batch = bufferRef.current;
    if (batch.length === 0) return;
    bufferRef.current = [];
    setState((current) => {
      let next = current;
      for (const event of batch) {
        next = applyEvent(next, event);
      }
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (event: SearchEvent) => {
      bufferRef.current.push(event);
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    },
    [flush],
  );

  const start = useCallback(
    async (input: StartSearchInput) => {
      closeStream();
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;

      setState({
        ...IDLE_STATE,
        status: 'starting',
        query: input.query,
        mode: input.mode,
        startedAtMs: Date.now(),
        resultsById: new Map(),
        providersById: new Map(),
      });

      const payload: CreateSearchPayload = {
        query: input.query,
        mode: input.mode,
        locale: input.locale,
        compatibilityProfileIds: input.compatibilityProfileIds,
        ...(input.filters ? { filters: input.filters } : {}),
      };

      let created: CreateSearchResponse;
      try {
        created = await createSearch(payload);
      } catch (error) {
        if (runIdRef.current !== runId || !mountedRef.current) return;
        setState((current) => ({
          ...current,
          status: 'failed',
          errorMessage: toUserMessage(error),
          correlationId: toCorrelationId(error),
          endedAtMs: Date.now(),
        }));
        return;
      }

      if (runIdRef.current !== runId || !mountedRef.current) return;

      setState((current) => ({
        ...current,
        status: 'streaming',
        searchId: created.searchId,
        normalizedQuery: created.normalizedQuery,
        timeBudgetMs: created.timeBudgetMs,
        progress: { ...current.progress, providersTotal: created.providerIds.length },
      }));

      const source = new EventSource(created.eventsUrl);
      sourceRef.current = source;

      const handle = (raw: MessageEvent<string>): void => {
        if (runIdRef.current !== runId) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.data) as unknown;
        } catch {
          return;
        }
        if (!isSearchEvent(parsed)) return;
        enqueue(parsed);
        if (
          parsed.type === 'search_completed' ||
          parsed.type === 'search_cancelled' ||
          parsed.type === 'search_failed'
        ) {
          source.close();
          if (sourceRef.current === source) {
            sourceRef.current = null;
          }
        }
      };

      for (const type of STREAMED_EVENT_TYPES) {
        source.addEventListener(type, handle as EventListener);
      }
      source.addEventListener('message', handle as EventListener);

      source.addEventListener('error', () => {
        if (runIdRef.current !== runId || !mountedRef.current) return;
        // EventSource retries on its own; a CLOSED socket is the terminal case.
        if (source.readyState === EventSource.CLOSED) {
          setState((current) =>
            TERMINAL.has(current.status)
              ? current
              : {
                  ...current,
                  status: 'failed',
                  connectionLost: true,
                  errorMessage:
                    'The connection to the search engine was lost before the search finished.',
                  endedAtMs: Date.now(),
                },
          );
        } else {
          setState((current) =>
            current.connectionLost || TERMINAL.has(current.status)
              ? current
              : { ...current, connectionLost: true },
          );
        }
      });

      source.addEventListener('open', () => {
        if (runIdRef.current !== runId || !mountedRef.current) return;
        setState((current) =>
          current.connectionLost ? { ...current, connectionLost: false } : current,
        );
      });
    },
    [closeStream, enqueue],
  );

  const cancel = useCallback(() => {
    const searchId = state.searchId;
    setState((current) =>
      TERMINAL.has(current.status) ? current : { ...current, cancelRequested: true },
    );
    if (!searchId) {
      closeStream();
      setState((current) =>
        TERMINAL.has(current.status)
          ? current
          : { ...current, status: 'cancelled', endedAtMs: Date.now() },
      );
      return;
    }
    void cancelSearch(searchId)
      .catch(() => undefined)
      .finally(() => {
        if (!mountedRef.current) return;
        closeStream();
        setState((current) =>
          TERMINAL.has(current.status)
            ? current
            : { ...current, status: 'cancelled', endedAtMs: Date.now() },
        );
      });
  }, [closeStream, state.searchId]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    closeStream();
    setState(IDLE_STATE);
  }, [closeStream]);

  const results = useMemo(() => {
    const list = Array.from(state.resultsById.values());
    list.sort((a, b) => {
      const delta = b.ranking.total - a.ranking.total;
      if (delta !== 0) return delta;
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [state.resultsById]);

  const providers = useMemo(
    () =>
      state.providerOrder
        .map((id) => state.providersById.get(id))
        .filter((entry): entry is ProviderRun => entry !== undefined),
    [state.providerOrder, state.providersById],
  );

  const session = useMemo<SearchSession>(
    () => ({
      status: state.status,
      searchId: state.searchId,
      query: state.query,
      normalizedQuery: state.normalizedQuery,
      mode: state.mode,
      timeBudgetMs: state.timeBudgetMs,
      results,
      providers,
      progress: state.progress,
      partial: state.partial,
      degradedProviderIds: state.degradedProviderIds,
      errorMessage: state.errorMessage,
      correlationId: state.correlationId,
      startedAtMs: state.startedAtMs,
      endedAtMs: state.endedAtMs,
      cancelRequested: state.cancelRequested,
      connectionLost: state.connectionLost,
    }),
    [state, results, providers],
  );

  return {
    session,
    start,
    cancel,
    reset,
    isActive: state.status === 'starting' || state.status === 'streaming',
  };
}
