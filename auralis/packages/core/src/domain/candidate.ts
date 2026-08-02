import type { AccessClassification, AccessDecision } from './access.js';
import type { CompatibilityAssessment } from './compat.js';
import type { MediaTags, MediaTechnicalMetadata, VerificationRecord } from './media.js';

export type SourceCategory =
  | 'open_archive'
  | 'open_data'
  | 'podcast_feed'
  | 'audio_api'
  | 'http_directory'
  | 'ftp_directory'
  | 'local_files'
  | 'connected_storage'
  | 'organisation_repository'
  | 'unknown';

export interface SourceMetadata {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly category: SourceCategory;
  /** Registrable host of the landing page, for display. */
  readonly sourceHost: string | null;
  /** Human landing page for the asset. */
  readonly pageUrl: string | null;
  /** Collection, show, album or archive item this belongs to. */
  readonly collection: string | null;
  /** Attribution text supplied by the source, if any. Rendered as plain text. */
  readonly attribution: string | null;
  /** Rights or usage note supplied by the source verbatim. Never inferred. */
  readonly rightsStatement: string | null;
  readonly publishedAt: string | null;
  readonly artworkUrl: string | null;
}

/**
 * What a provider emits. Deliberately minimal: providers do no verification,
 * no network probing of media, and no access decisions.
 */
export interface RawSearchCandidate {
  readonly providerId: string;
  /** Stable identifier within the provider, used for deduplication. */
  readonly providerAssetId: string;
  readonly title: string;
  readonly creator: string | null;
  readonly filename: string | null;
  /** URL of the media bytes, if the provider exposes one. */
  readonly mediaUrl: string | null;
  /** Human-facing page for this asset. */
  readonly pageUrl: string | null;
  readonly source: SourceMetadata;
  /** Provider's own claims. Treated as untrusted hints, never as facts. */
  readonly claimed: ClaimedMetadata;
  /** Provider's initial access classification; may be downgraded, never silently upgraded. */
  readonly declaredAccess: AccessClassification;
  readonly tags: MediaTags;
  /** Free-form provider payload retained for the technical panel. Sanitised on render. */
  readonly providerExtras: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ClaimedMetadata {
  readonly format: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly bitrateBps: number | null;
  readonly sampleRateHz: number | null;
  readonly channels: number | null;
}

export const EMPTY_CLAIMED: ClaimedMetadata = Object.freeze({
  format: null,
  mimeType: null,
  sizeBytes: null,
  durationSeconds: null,
  bitrateBps: null,
  sampleRateHz: null,
  channels: null,
});

export interface ScoreBreakdownEntry {
  readonly factor: string;
  readonly label: string;
  readonly weight: number;
  readonly value: number;
  readonly contribution: number;
}

export interface RankingScore {
  readonly total: number;
  readonly relevance: number;
  readonly quality: number;
  readonly accessCertainty: number;
  readonly breakdown: readonly ScoreBreakdownEntry[];
  /** Short user-facing sentences for the `Why this result?` panel. */
  readonly explanation: readonly string[];
}

export interface QualityScore {
  readonly total: number;
  readonly breakdown: readonly ScoreBreakdownEntry[];
  readonly warnings: readonly string[];
}

export type ResultBadge =
  | 'verified_audio'
  | 'direct_file'
  | 'open_source'
  | 'source_download'
  | 'connected_storage'
  | 'user_owned'
  | 'preview_only'
  | 'metadata_only'
  | 'unverified_metadata'
  | 'possible_duplicate'
  | 'vbr'
  | 'lossless'
  | 'cdj_compatible'
  | 'compatibility_warning'
  | 'estimated_bitrate';

/**
 * A fully processed result as delivered to the client. This is the only shape
 * the UI consumes.
 */
export interface SearchResult {
  readonly id: string;
  readonly searchId: string;
  readonly title: string;
  readonly creator: string | null;
  readonly filename: string | null;
  readonly source: SourceMetadata;
  readonly pageUrl: string | null;
  /**
   * Direct media URL. Present only when the access decision permits the client
   * to see it; withheld for restricted and connected-private assets.
   */
  readonly mediaUrl: string | null;
  readonly technical: MediaTechnicalMetadata;
  readonly tags: MediaTags;
  readonly claimed: ClaimedMetadata;
  readonly verification: VerificationRecord;
  readonly access: AccessDecision;
  readonly compatibility: readonly CompatibilityAssessment[];
  readonly quality: QualityScore;
  readonly ranking: RankingScore;
  readonly badges: readonly ResultBadge[];
  readonly duplicateGroupId: string | null;
  readonly duplicateCount: number;
  /** Alternative sources for the same logical recording. */
  readonly variants: readonly ResultVariantSummary[];
  readonly discoveredAt: string;
  readonly previewUrl: string | null;
  /**
   * Provider payload retained for the technical panel and for services that
   * need a source-specific handle (an object key, a local path). Values are
   * sanitised strings, numbers or booleans and are always rendered as text.
   */
  readonly providerExtras: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResultVariantSummary {
  readonly id: string;
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly format: string;
  readonly bitrateBps: number | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly sampleRateHz: number | null;
  readonly channels: number | null;
  readonly accessClassification: AccessClassification;
  readonly pageUrl: string | null;
  /** Reason this variant is meaningfully different from the group leader. */
  readonly differsBy: readonly string[];
}
