/**
 * Type surface shared with the engine.
 *
 * `@auralis/core` is a Node package (node:crypto, node:dns, node:http), so the
 * browser bundle must never import a runtime value from it. Everything below is
 * a type-only import or re-export, which the compiler erases completely. The
 * runtime vocabularies the interface needs are redeclared in `./vocabulary.ts`.
 */

import type { ConnectorSummary, ProviderSummary, SavedItemSummary } from '@auralis/core';

export type {
  AccessAction,
  AccessClassification,
  AccessDecision,
  ApiErrorBody,
  AudioCodec,
  AudioFormat,
  BitrateInfo,
  BitrateMode,
  ChannelLayout,
  CompatibilityAssessment,
  CompatibilityVerdict,
  Confidence,
  ConnectorKind,
  ConnectorSummary,
  CreateSearchResponse,
  DownloadIntentResponse,
  MediaTags,
  MediaTechnicalMetadata,
  ProviderHealthResponse,
  ProviderOutcome,
  ProviderSummary,
  QualityScore,
  RankingScore,
  RejectionReason,
  ResultBadge,
  ResultVariantSummary,
  SavedItemSummary,
  ScoreBreakdownEntry,
  SearchEvent,
  SearchEventType,
  SearchMode,
  SearchResult,
  SourceCategory,
  SourceMetadata,
  VerificationRecord,
  VerificationStatus,
} from '@auralis/core';

/** The wire shape of the filters block on `POST /api/v1/searches`. */
export interface SearchFiltersPayload {
  readonly formats: readonly string[];
  readonly extensions: readonly string[];
  readonly minBitrateBps: number | null;
  readonly durationMinSeconds: number | null;
  readonly durationMaxSeconds: number | null;
  readonly accessTypes: readonly string[];
  readonly providerIds: readonly string[];
  readonly losslessOnly: boolean;
}

export interface CreateSearchPayload {
  readonly query: string;
  readonly mode: string;
  readonly filters?: SearchFiltersPayload;
  readonly locale: string;
  readonly compatibilityProfileIds: readonly string[];
}

export interface ProviderListResponse {
  readonly providers: readonly ProviderSummary[];
}

export interface SavedListResponse {
  readonly items: readonly SavedItemSummary[];
}

export interface ConnectorListResponse {
  readonly connectors: readonly ConnectorSummary[];
}

export interface ConnectorTestResponse {
  readonly connectorId: string;
  readonly status: string;
  readonly message: string;
}
