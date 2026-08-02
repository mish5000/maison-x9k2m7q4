import type { AccessClassification } from './access.js';
import type { AudioFormat } from './media.js';

export const SEARCH_MODES = ['quick', 'deep', 'connected'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface DurationRangeSeconds {
  readonly min: number | null;
  readonly max: number | null;
}

/** Filters supplied explicitly by the user through the advanced panel. */
export interface SearchFilters {
  readonly formats: readonly AudioFormat[];
  readonly extensions: readonly string[];
  readonly minBitrateBps: number | null;
  readonly duration: DurationRangeSeconds;
  readonly accessTypes: readonly AccessClassification[];
  readonly providerIds: readonly string[];
  readonly losslessOnly: boolean;
}

export const EMPTY_FILTERS: SearchFilters = Object.freeze({
  formats: Object.freeze([] as const),
  extensions: Object.freeze([] as const),
  minBitrateBps: null,
  duration: Object.freeze({ min: null, max: null }),
  accessTypes: Object.freeze([] as const),
  providerIds: Object.freeze([] as const),
  losslessOnly: false,
});

export type QueryIntent = 'title' | 'creator' | 'creator_title' | 'filename' | 'phrase' | 'general';

export interface QueryVariant {
  readonly text: string;
  /** Weight applied to relevance scores derived from this variant. */
  readonly weight: number;
  readonly kind: 'original' | 'normalized' | 'phrase' | 'swapped' | 'stripped' | 'separator';
}

/**
 * The canonical, validated representation of a user search. Every provider
 * receives this; no provider ever sees the raw request body.
 */
export interface NormalizedSearchQuery {
  /** Exactly as the user typed it, minus control characters. */
  readonly raw: string;
  /** Case- and unicode-normalised text with operators removed. */
  readonly normalized: string;
  /** Quoted phrases the user required verbatim. */
  readonly phrases: readonly string[];
  /** Terms prefixed with `-`, which must not appear in results. */
  readonly excluded: readonly string[];
  readonly intent: QueryIntent;
  /** Best-effort split of `artist - title` style input. */
  readonly creator: string | null;
  readonly title: string | null;
  /** Bounded set of query rewrites sent to providers that support text search. */
  readonly variants: readonly QueryVariant[];
  readonly filters: SearchFilters;
  readonly mode: SearchMode;
  readonly locale: string;
}
