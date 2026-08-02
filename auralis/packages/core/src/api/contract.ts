import { z } from 'zod';

import { ACCESS_CLASSIFICATIONS } from '../domain/access.js';
import { AUDIO_FORMATS } from '../domain/media.js';
import { SEARCH_MODES } from '../domain/query.js';
import { MAX_QUERY_LENGTH } from '../query/normalize.js';

/**
 * The versioned HTTP contract. Schemas here are the single source of truth for
 * both request validation on the server and typed access on the client.
 */

export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

export const searchFiltersSchema = z
  .object({
    formats: z.array(z.enum(AUDIO_FORMATS)).max(10).default([]),
    extensions: z
      .array(z.string().regex(/^[a-z0-9]{1,5}$/i))
      .max(10)
      .default([]),
    minBitrateBps: z.number().int().min(8_000).max(10_000_000).nullable().default(null),
    durationMinSeconds: z.number().int().min(0).max(86_400).nullable().default(null),
    durationMaxSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
    accessTypes: z.array(z.enum(ACCESS_CLASSIFICATIONS)).max(8).default([]),
    providerIds: z
      .array(z.string().regex(/^[a-z0-9-]{2,40}$/))
      .max(20)
      .default([]),
    losslessOnly: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.durationMinSeconds === null ||
      value.durationMaxSeconds === null ||
      value.durationMinSeconds <= value.durationMaxSeconds,
    { message: 'The minimum duration must not exceed the maximum.' },
  );

export type SearchFiltersRequest = z.infer<typeof searchFiltersSchema>;

export const createSearchRequestSchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
    mode: z.enum(SEARCH_MODES).default('quick'),
    filters: searchFiltersSchema.optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .default('en'),
    /** Device profiles to assess results against. */
    compatibilityProfileIds: z
      .array(z.string().regex(/^[a-z0-9-]{2,40}$/))
      .max(4)
      .default(['cdj-3000']),
  })
  .strict();

export type CreateSearchRequest = z.input<typeof createSearchRequestSchema>;

export const createSearchResponseSchema = z.object({
  searchId: z.string(),
  mode: z.enum(SEARCH_MODES),
  normalizedQuery: z.string(),
  providerIds: z.array(z.string()),
  eventsUrl: z.string(),
  timeBudgetMs: z.number(),
  correlationId: z.string(),
});

export type CreateSearchResponse = z.infer<typeof createSearchResponseSchema>;

export const downloadIntentRequestSchema = z
  .object({
    searchId: z.string().min(1).max(64),
  })
  .strict();

export type DownloadIntentRequest = z.infer<typeof downloadIntentRequestSchema>;

export interface DownloadIntentResponse {
  readonly assetId: string;
  readonly allowed: boolean;
  /** Present only when `allowed` is true. */
  readonly method: 'direct' | 'provider_endpoint' | 'server_mediated' | null;
  readonly url: string | null;
  readonly filename: string;
  readonly expiresAt: string | null;
  readonly reason: string;
  readonly classification: string;
  readonly summary: {
    readonly format: string;
    readonly sizeBytes: number | null;
    readonly durationSeconds: number | null;
    readonly bitrateBps: number | null;
    readonly bitrateEstimated: boolean;
    readonly sourceName: string;
    readonly sourceHost: string | null;
    readonly attribution: string | null;
    readonly rightsStatement: string | null;
    readonly verificationStatus: string;
    readonly compatibility: readonly { profileLabel: string; verdict: string }[];
  };
}

export const connectorKindSchema = z.enum([
  's3-compatible',
  'webdav',
  'custom-json-api',
  'rss-feed',
  'http-directory',
  'ftp-directory',
  'local-directory',
]);

export type ConnectorKind = z.infer<typeof connectorKindSchema>;

export const createConnectorRequestSchema = z
  .object({
    kind: connectorKindSchema,
    displayName: z.string().min(1).max(80),
    /**
     * Connector settings. Values whose key appears in the connector's secret
     * field list are encrypted at rest and never returned by the API.
     */
    config: z.record(z.string().min(1).max(64), z.string().max(2048)),
  })
  .strict();

export type CreateConnectorRequest = z.infer<typeof createConnectorRequestSchema>;

export interface ConnectorSummary {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly status: 'ready' | 'not_configured' | 'auth_required' | 'error' | 'untested';
  readonly accountIdentity: string | null;
  readonly scopeDescription: string;
  readonly createdAt: string;
  readonly lastTestedAt: string | null;
  readonly lastTestMessage: string | null;
  /** Non-secret configuration echoed back for display. */
  readonly config: Readonly<Record<string, string>>;
}

export const saveItemRequestSchema = z
  .object({
    searchId: z.string().min(1).max(64),
    resultId: z.string().min(1).max(64),
    note: z.string().max(500).optional(),
  })
  .strict();

export type SaveItemRequest = z.infer<typeof saveItemRequestSchema>;

export interface SavedItemSummary {
  readonly id: string;
  readonly title: string;
  readonly creator: string | null;
  readonly sourceName: string;
  readonly pageUrl: string | null;
  readonly format: string;
  readonly durationSeconds: number | null;
  readonly savedAt: string;
  readonly note: string | null;
}

export interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly sourceCategory: string;
  readonly requiresAuthentication: boolean;
  readonly requiredConfiguration: readonly string[];
  readonly modes: readonly string[];
  readonly supportsPreview: boolean;
  readonly returnsDirectMediaUrls: boolean;
  readonly status: string;
  readonly setupDocPath: string | null;
}

export interface ProviderHealthResponse {
  readonly checkedAt: string;
  readonly providers: readonly {
    readonly providerId: string;
    readonly status: string;
    readonly message: string;
    readonly latencyMs: number | null;
    readonly circuitState: 'closed' | 'open' | 'half_open';
    readonly setupDocPath: string | null;
  }[];
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly correlationId: string;
  };
}

/** Converts the wire filter shape into the domain filter shape. */
export function toDomainFilters(filters: SearchFiltersRequest | undefined): {
  formats: SearchFiltersRequest['formats'];
  extensions: SearchFiltersRequest['extensions'];
  minBitrateBps: number | null;
  duration: { min: number | null; max: number | null };
  accessTypes: SearchFiltersRequest['accessTypes'];
  providerIds: SearchFiltersRequest['providerIds'];
  losslessOnly: boolean;
} {
  return {
    formats: filters?.formats ?? [],
    extensions: filters?.extensions ?? [],
    minBitrateBps: filters?.minBitrateBps ?? null,
    duration: {
      min: filters?.durationMinSeconds ?? null,
      max: filters?.durationMaxSeconds ?? null,
    },
    accessTypes: filters?.accessTypes ?? [],
    providerIds: filters?.providerIds ?? [],
    losslessOnly: filters?.losslessOnly ?? false,
  };
}
