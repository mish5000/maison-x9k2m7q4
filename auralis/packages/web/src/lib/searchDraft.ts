/**
 * The advanced panel edits a draft; this module turns that draft into a request
 * body and reports anything the engine would reject, in plain language, before
 * a request is ever sent.
 */

import type { AccessClassification, AudioFormat, SearchMode } from '../api/types.js';
import type { SearchFiltersPayload } from '../api/types.js';
import { MAX_QUERY_LENGTH } from '../api/vocabulary.js';

export interface SearchDraft {
  readonly mode: SearchMode;
  readonly formats: readonly AudioFormat[];
  /** Raw, comma-separated text as typed. */
  readonly extensions: string;
  readonly minBitrateKbps: string;
  readonly durationMinSeconds: string;
  readonly durationMaxSeconds: string;
  readonly accessTypes: readonly AccessClassification[];
  readonly providerIds: readonly string[];
  readonly losslessOnly: boolean;
}

export const EMPTY_DRAFT: SearchDraft = {
  mode: 'quick',
  formats: [],
  extensions: '',
  minBitrateKbps: '',
  durationMinSeconds: '',
  durationMaxSeconds: '',
  accessTypes: [],
  providerIds: [],
  losslessOnly: false,
};

export type DraftField =
  'query' | 'extensions' | 'minBitrateKbps' | 'durationMinSeconds' | 'durationMaxSeconds';

export type DraftErrors = Partial<Record<DraftField, string>>;

const EXTENSION_PATTERN = /^[a-z0-9]{1,5}$/i;

export function parseExtensions(raw: string): readonly string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/^\./, '').toLowerCase())
    .filter((entry) => entry.length > 0);
}

function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  return Number.parseInt(trimmed, 10);
}

/** True when the draft carries at least one real constraint. */
export function hasActiveFilters(draft: SearchDraft): boolean {
  return (
    draft.formats.length > 0 ||
    parseExtensions(draft.extensions).length > 0 ||
    draft.minBitrateKbps.trim().length > 0 ||
    draft.durationMinSeconds.trim().length > 0 ||
    draft.durationMaxSeconds.trim().length > 0 ||
    draft.accessTypes.length > 0 ||
    draft.providerIds.length > 0 ||
    draft.losslessOnly
  );
}

export function countActiveFilters(draft: SearchDraft): number {
  let count = 0;
  if (draft.formats.length > 0) count += 1;
  if (parseExtensions(draft.extensions).length > 0) count += 1;
  if (draft.minBitrateKbps.trim().length > 0) count += 1;
  if (draft.durationMinSeconds.trim().length > 0) count += 1;
  if (draft.durationMaxSeconds.trim().length > 0) count += 1;
  if (draft.accessTypes.length > 0) count += 1;
  if (draft.providerIds.length > 0) count += 1;
  if (draft.losslessOnly) count += 1;
  return count;
}

export interface ValidationResult {
  readonly errors: DraftErrors;
  readonly filters: SearchFiltersPayload | undefined;
}

export function validateDraft(query: string, draft: SearchDraft): ValidationResult {
  const errors: Record<string, string> = {};

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    errors['query'] = 'Type something to search for.';
  } else if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    errors['query'] = `Searches are limited to ${MAX_QUERY_LENGTH} characters.`;
  }

  const extensions = parseExtensions(draft.extensions);
  if (extensions.length > 10) {
    errors['extensions'] = 'Use at most ten extensions.';
  } else if (extensions.some((entry) => !EXTENSION_PATTERN.test(entry))) {
    errors['extensions'] = 'Extensions are short letter-and-number codes, like mp3 or flac.';
  }

  const bitrateKbps = parseWholeNumber(draft.minBitrateKbps);
  if (
    bitrateKbps !== null &&
    (Number.isNaN(bitrateKbps) || bitrateKbps < 8 || bitrateKbps > 10000)
  ) {
    errors['minBitrateKbps'] = 'Enter a bitrate between 8 and 10000 kbps.';
  }

  const durationMin = parseWholeNumber(draft.durationMinSeconds);
  if (durationMin !== null && (Number.isNaN(durationMin) || durationMin > 86_400)) {
    errors['durationMinSeconds'] = 'Enter a length in seconds, up to 86400.';
  }

  const durationMax = parseWholeNumber(draft.durationMaxSeconds);
  if (
    durationMax !== null &&
    (Number.isNaN(durationMax) || durationMax < 1 || durationMax > 86_400)
  ) {
    errors['durationMaxSeconds'] = 'Enter a length in seconds between 1 and 86400.';
  }

  if (
    durationMin !== null &&
    durationMax !== null &&
    !Number.isNaN(durationMin) &&
    !Number.isNaN(durationMax) &&
    durationMin > durationMax
  ) {
    errors['durationMaxSeconds'] = 'The longest length must be at least the shortest length.';
  }

  if (Object.keys(errors).length > 0) {
    return { errors: errors as DraftErrors, filters: undefined };
  }

  if (!hasActiveFilters(draft)) {
    return { errors: {}, filters: undefined };
  }

  const filters: SearchFiltersPayload = {
    formats: draft.formats,
    extensions,
    minBitrateBps: bitrateKbps === null ? null : bitrateKbps * 1000,
    durationMinSeconds: durationMin,
    durationMaxSeconds: durationMax,
    accessTypes: draft.accessTypes,
    providerIds: draft.providerIds,
    losslessOnly: draft.losslessOnly,
  };

  return { errors: {}, filters };
}

export function toggleValue<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}
