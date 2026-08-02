import {
  EMPTY_CLAIMED,
  type ClaimedMetadata,
  type RawSearchCandidate,
  type SourceCategory,
  type SourceMetadata,
} from '../domain/candidate.js';
import type { AccessClassification } from '../domain/access.js';
import { EMPTY_TAGS, type MediaTags } from '../domain/media.js';
import {
  DEFAULT_RETRY_POLICY,
  type ProviderCapabilities,
  type SearchContext,
} from '../domain/provider.js';
import { cleanTagString } from '../media/bytes.js';
import { displayHost } from '../net/url-safety.js';

/** Shared helpers for provider adapters. */

export interface CandidateInit {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly category: SourceCategory;
  readonly providerAssetId: string;
  readonly title: string;
  readonly creator?: string | null;
  readonly filename?: string | null;
  readonly mediaUrl?: string | null;
  readonly pageUrl?: string | null;
  readonly collection?: string | null;
  readonly attribution?: string | null;
  readonly rightsStatement?: string | null;
  readonly publishedAt?: string | null;
  readonly artworkUrl?: string | null;
  readonly declaredAccess: AccessClassification;
  readonly claimed?: Partial<ClaimedMetadata>;
  readonly tags?: Partial<MediaTags>;
  readonly extras?: Record<string, string | number | boolean | null>;
}

/**
 * Builds a candidate with every string cleaned. Provider output is untrusted:
 * it comes from remote APIs and feeds and ends up rendered in the UI.
 */
export function buildCandidate(init: CandidateInit): RawSearchCandidate {
  const source: SourceMetadata = {
    providerId: init.providerId,
    providerDisplayName: init.providerDisplayName,
    category: init.category,
    sourceHost: hostOf(init.pageUrl ?? init.mediaUrl ?? null),
    pageUrl: safeUrl(init.pageUrl ?? null),
    collection: cleanTagString(init.collection ?? null, 200),
    attribution: cleanTagString(init.attribution ?? null, 300),
    rightsStatement: cleanTagString(init.rightsStatement ?? null, 300),
    publishedAt: normaliseDate(init.publishedAt ?? null),
    artworkUrl: safeUrl(init.artworkUrl ?? null),
  };

  return {
    providerId: init.providerId,
    providerAssetId: init.providerAssetId.slice(0, 200),
    title: cleanTagString(init.title, 300) ?? 'Untitled recording',
    creator: cleanTagString(init.creator ?? null, 200),
    filename: cleanTagString(init.filename ?? null, 260),
    mediaUrl: safeUrl(init.mediaUrl ?? null),
    pageUrl: source.pageUrl,
    source,
    claimed: { ...EMPTY_CLAIMED, ...sanitiseClaimed(init.claimed) },
    declaredAccess: init.declaredAccess,
    tags: { ...EMPTY_TAGS, ...sanitiseTags(init.tags) },
    providerExtras: Object.freeze({ ...(init.extras ?? {}) }),
  };
}

function sanitiseClaimed(claimed: Partial<ClaimedMetadata> | undefined): Partial<ClaimedMetadata> {
  if (!claimed) return {};
  const positive = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  return {
    format: cleanTagString(claimed.format ?? null, 20),
    mimeType: cleanTagString(claimed.mimeType ?? null, 100),
    sizeBytes: positive(claimed.sizeBytes),
    durationSeconds: positive(claimed.durationSeconds),
    bitrateBps: positive(claimed.bitrateBps),
    sampleRateHz: positive(claimed.sampleRateHz),
    channels: positive(claimed.channels),
  };
}

function sanitiseTags(tags: Partial<MediaTags> | undefined): Partial<MediaTags> {
  if (!tags) return {};
  return {
    title: cleanTagString(tags.title ?? null, 300),
    artist: cleanTagString(tags.artist ?? null, 200),
    album: cleanTagString(tags.album ?? null, 200),
    albumArtist: cleanTagString(tags.albumArtist ?? null, 200),
    genre: cleanTagString(tags.genre ?? null, 100),
    comment: cleanTagString(tags.comment ?? null, 500),
    trackNumber: typeof tags.trackNumber === 'number' ? tags.trackNumber : null,
    year: typeof tags.year === 'number' ? tags.year : null,
  };
}

export function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return displayHost(new URL(value).hostname);
  } catch {
    return null;
  }
}

export function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Parses common duration notations: seconds, `M:SS`, `H:MM:SS`. */
export function parseDuration(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds : null;
  }

  const parts = trimmed.split(':').map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

export function parseSize(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value.replace(/[,\s]/g, ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Capability defaults so adapters only declare what differs. */
export function capabilities(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return {
    supportsTextSearch: true,
    supportsExactTitleSearch: false,
    returnsDirectMediaUrls: false,
    supportsPreview: false,
    requiresAuthentication: false,
    rateLimit: { kind: 'concurrency_only', maxConcurrent: 2 },
    robotsPosture: 'api_terms_only',
    timeoutMs: 8_000,
    retry: DEFAULT_RETRY_POLICY,
    cacheable: true,
    exposesFileSize: false,
    exposesDuration: false,
    exposesBitrate: false,
    supportsServerSideSearch: true,
    supportsPagination: false,
    supportsIncrementalStreaming: false,
    maxConcurrentRequests: 2,
    sourceCategory: 'unknown',
    modes: ['quick', 'deep'],
    producesPrivateResults: false,
    requiredConfiguration: [],
    ...overrides,
  };
}

/** Time remaining before this provider's deadline. */
export function msRemaining(context: SearchContext): number {
  return Math.max(0, context.deadlineMs - context.now());
}

export function isConfigured(context: SearchContext, required: readonly string[]): boolean {
  return required.every((key) => {
    const value = context.config[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/** Splits a comma or newline separated configuration value into a list. */
export function configList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 50);
}

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'wave',
  'aif',
  'aiff',
  'aifc',
  'flac',
  'aac',
  'm4a',
  'm4b',
  'ogg',
  'oga',
  'opus',
]);

export function looksLikeAudioFilename(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export const PLAYLIST_EXTENSIONS: ReadonlySet<string> = new Set(['m3u', 'm3u8', 'pls', 'cue']);

/**
 * Playlist containers are surfaced by directory-style adapters so the pipeline
 * can inspect them. They are never presented as playable files — the verifier
 * classifies them as playlists and the orchestrator rejects them.
 */
export function looksLikePlaylistFilename(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return PLAYLIST_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
