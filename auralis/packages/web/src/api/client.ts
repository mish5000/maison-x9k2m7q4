/**
 * Thin, typed HTTP client for the Auralis API.
 *
 * Rules enforced here rather than at every call site:
 *  - every mutating request carries the `x-auralis-csrf` header
 *  - every request is `same-origin` so cookies stay first-party
 *  - error bodies are reduced to the user-facing `message`; the machine `code`
 *    and `correlationId` are carried on the error object for the collapsed
 *    technical panel and are never rendered as prose
 */

import type {
  ApiErrorBody,
  ConnectorListResponse,
  ConnectorSummary,
  ConnectorTestResponse,
  CreateSearchPayload,
  CreateSearchResponse,
  DownloadIntentResponse,
  ProviderHealthResponse,
  ProviderListResponse,
  ProviderSummary,
  SavedItemSummary,
} from './types.js';

export const API_BASE_PATH = '/api/v1';

const CSRF_HEADER = 'x-auralis-csrf';

export class ApiError extends Error {
  readonly code: string;
  readonly correlationId: string | null;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      correlationId?: string | null;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.correlationId = options.correlationId ?? null;
    this.details = options.details ?? {};
  }

  /** True when the request never reached the engine. */
  get isOffline(): boolean {
    return this.code === 'network_unavailable';
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const candidate = (value as { error: unknown }).error;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'message' in candidate &&
    typeof (candidate as { message: unknown }).message === 'string'
  );
}

function fallbackMessage(status: number): string {
  if (status === 0) {
    return 'Auralis cannot reach the search engine right now.';
  }
  if (status === 404) {
    return 'That is no longer available.';
  }
  if (status === 429) {
    return 'Too many requests for the moment. Wait a few seconds and try again.';
  }
  if (status >= 500) {
    return 'Something went wrong inside Auralis. The search was not completed.';
  }
  return 'The request could not be completed.';
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (method !== 'GET') {
    headers[CSRF_HEADER] = '1';
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) {
    init.signal = options.signal;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new ApiError('Auralis cannot reach the search engine right now.', {
      code: 'network_unavailable',
      status: 0,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (isApiErrorBody(parsed)) {
      throw new ApiError(parsed.error.message, {
        code: parsed.error.code,
        status: response.status,
        correlationId: parsed.error.correlationId,
        details: parsed.error.details,
      });
    }
    throw new ApiError(fallbackMessage(response.status), {
      code: 'unexpected_response',
      status: response.status,
    });
  }

  return parsed as T;
}

/**
 * Collection endpoints are read defensively: an envelope (`{items: []}`) and a
 * bare array are both accepted so a shape change cannot blank the screen.
 */
function unwrapList<T>(payload: unknown, key: string): readonly T[] {
  if (Array.isArray(payload)) {
    return payload as readonly T[];
  }
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value as readonly T[];
    }
  }
  return [];
}

export function createSearch(
  payload: CreateSearchPayload,
  signal?: AbortSignal,
): Promise<CreateSearchResponse> {
  return request<CreateSearchResponse>('/searches', {
    method: 'POST',
    body: payload,
    ...(signal ? { signal } : {}),
  });
}

export async function cancelSearch(searchId: string): Promise<void> {
  await request<unknown>(`/searches/${encodeURIComponent(searchId)}/cancel`, { method: 'POST' });
}

export function requestDownloadIntent(
  assetId: string,
  searchId: string,
): Promise<DownloadIntentResponse> {
  return request<DownloadIntentResponse>(`/assets/${encodeURIComponent(assetId)}/download-intent`, {
    method: 'POST',
    body: { searchId },
  });
}

export async function listProviders(signal?: AbortSignal): Promise<readonly ProviderSummary[]> {
  const payload = await request<ProviderListResponse>('/providers', signal ? { signal } : {});
  return unwrapList<ProviderSummary>(payload, 'providers');
}

export function providerHealth(signal?: AbortSignal): Promise<ProviderHealthResponse> {
  return request<ProviderHealthResponse>('/providers/health', signal ? { signal } : {});
}

export async function listSaved(signal?: AbortSignal): Promise<readonly SavedItemSummary[]> {
  const payload = await request<unknown>('/saved', signal ? { signal } : {});
  const items = unwrapList<SavedItemSummary>(payload, 'items');
  return items.length > 0 ? items : unwrapList<SavedItemSummary>(payload, 'saved');
}

export function saveItem(input: {
  searchId: string;
  resultId: string;
  note?: string;
}): Promise<SavedItemSummary> {
  return request<SavedItemSummary>('/saved', { method: 'POST', body: input });
}

export async function deleteSaved(savedId: string): Promise<void> {
  await request<unknown>(`/saved/${encodeURIComponent(savedId)}`, { method: 'DELETE' });
}

export async function listConnectors(signal?: AbortSignal): Promise<readonly ConnectorSummary[]> {
  const payload = await request<ConnectorListResponse>('/connectors', signal ? { signal } : {});
  return unwrapList<ConnectorSummary>(payload, 'connectors');
}

export function createConnector(input: {
  kind: string;
  displayName: string;
  config: Record<string, string>;
}): Promise<ConnectorSummary> {
  return request<ConnectorSummary>('/connectors', { method: 'POST', body: input });
}

export function testConnector(connectorId: string): Promise<ConnectorTestResponse> {
  return request<ConnectorTestResponse>(`/connectors/${encodeURIComponent(connectorId)}/test`, {
    method: 'POST',
  });
}

export async function deleteConnector(connectorId: string): Promise<void> {
  await request<unknown>(`/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
}

/** Reduces any thrown value to a sentence that is safe to show a person. */
export function toUserMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'That request was stopped.';
  }
  if (error instanceof Error && error.message.length > 0 && error.message.length < 200) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

/** The correlation id, when one is available, for the collapsed technical panel. */
export function toCorrelationId(error: unknown): string | null {
  return error instanceof ApiError ? error.correlationId : null;
}
