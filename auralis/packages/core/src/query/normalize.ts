import type {
  NormalizedSearchQuery,
  QueryIntent,
  QueryVariant,
  SearchFilters,
  SearchMode,
} from '../domain/query.js';
import { EMPTY_FILTERS } from '../domain/query.js';
import { AuralisError } from '../domain/errors.js';

/**
 * Query normalisation and variant generation.
 *
 * Two rules govern this module:
 *  1. The user's original text is never lost — it always appears as the
 *     highest-weighted variant.
 *  2. Variants are strictly bounded. Every extra variant multiplies provider
 *     load, so the cap is a rate-limit protection, not a nicety.
 */

export const MAX_QUERY_LENGTH = 256;
export const MAX_VARIANTS_QUICK = 2;
export const MAX_VARIANTS_DEEP = 5;

const SEPARATORS = /[._+]+/g;
const MULTI_SPACE = /\s{2,}/g;

/** Common filename separators normalised to spaces, with punctuation kept. */
export function normaliseText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(SEPARATORS, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(MULTI_SPACE, ' ')
    .trim();
}

/** Strips diacritics for a looser comparison form. */
export function foldAccents(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Removes punctuation entirely; used for comparison, never for display. */
export function comparisonKey(input: string): string {
  return foldAccents(normaliseText(input))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(MULTI_SPACE, ' ')
    .trim();
}

export interface ParsedOperators {
  readonly text: string;
  readonly phrases: readonly string[];
  readonly excluded: readonly string[];
  readonly filetypes: readonly string[];
  readonly sources: readonly string[];
  readonly minBitrateBps: number | null;
}

const OPERATOR_PATTERN =
  /(?:^|\s)(filetype|ext|source|provider|bitrate|minbitrate):([A-Za-z0-9_.-]+)/gi;

/** Extracts quoted phrases, minus-terms and `key:value` operators. */
export function parseOperators(raw: string): ParsedOperators {
  const phrases: string[] = [];
  const excluded: string[] = [];
  const filetypes: string[] = [];
  const sources: string[] = [];
  let minBitrateBps: number | null = null;

  // Quoted phrases first, so operators inside quotes are treated as literals.
  let working = raw.replace(/"([^"]{1,120})"/g, (_match, phrase: string) => {
    const trimmed = phrase.trim();
    if (trimmed.length > 0 && phrases.length < 4) phrases.push(trimmed);
    return ' ';
  });

  working = working.replace(OPERATOR_PATTERN, (_match, key: string, value: string) => {
    const lowerKey = key.toLowerCase();
    const lowerValue = value.toLowerCase();
    if (lowerKey === 'filetype' || lowerKey === 'ext') {
      if (filetypes.length < 5) filetypes.push(lowerValue.replace(/^\./, ''));
    } else if (lowerKey === 'source' || lowerKey === 'provider') {
      if (sources.length < 8) sources.push(lowerValue);
    } else {
      const kbps = Number.parseInt(lowerValue.replace(/kbps?$/, ''), 10);
      if (Number.isFinite(kbps) && kbps > 0 && kbps <= 10_000) minBitrateBps = kbps * 1000;
    }
    return ' ';
  });

  working = working.replace(/(?:^|\s)-([^\s"]{2,60})/g, (_match, term: string) => {
    if (excluded.length < 8) excluded.push(term.toLowerCase());
    return ' ';
  });

  return {
    text: working.replace(MULTI_SPACE, ' ').trim(),
    phrases,
    excluded,
    filetypes,
    sources,
    minBitrateBps,
  };
}

const CREATOR_TITLE_SPLIT = /^(.{2,80}?)\s+[-–—]\s+(.{2,120})$/;
const FILENAME_HINT = /\.[a-z0-9]{2,5}$/i;
const EDITION_TERMS =
  /\b(remaster(?:ed)?|deluxe|expanded|anniversary|edition|version|mix|edit|live|acoustic|instrumental|radio\s?edit|extended)\b/gi;

export function inferIntent(raw: string, parsed: ParsedOperators): QueryIntent {
  if (parsed.phrases.length > 0 && parsed.text.length === 0) return 'phrase';
  if (FILENAME_HINT.test(raw.trim())) return 'filename';
  if (CREATOR_TITLE_SPLIT.test(parsed.text)) return 'creator_title';
  const words = parsed.text.split(/\s+/).filter(Boolean);
  if (words.length <= 3 && /^[\p{Lu}]/u.test(raw.trim())) return 'title';
  return 'general';
}

export interface CreatorTitle {
  readonly creator: string | null;
  readonly title: string | null;
}

export function splitCreatorTitle(text: string): CreatorTitle {
  const match = CREATOR_TITLE_SPLIT.exec(text.trim());
  if (!match?.[1] || !match[2]) return { creator: null, title: null };
  return { creator: match[1].trim(), title: match[2].trim() };
}

function buildVariants(
  raw: string,
  normalized: string,
  parsed: ParsedOperators,
  creatorTitle: CreatorTitle,
  mode: SearchMode,
): readonly QueryVariant[] {
  const limit = mode === 'deep' ? MAX_VARIANTS_DEEP : MAX_VARIANTS_QUICK;
  const seen = new Set<string>();
  const variants: QueryVariant[] = [];

  const add = (text: string, weight: number, kind: QueryVariant['kind']): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (variants.length >= limit) return;
    seen.add(key);
    variants.push({ text: trimmed, weight, kind });
  };

  // The user's own words always come first and carry the most weight.
  add(raw.trim(), 1, 'original');
  if (normalized !== raw.trim().toLowerCase()) add(normalized, 0.95, 'normalized');

  for (const phrase of parsed.phrases) add(phrase, 0.9, 'phrase');

  if (mode === 'deep') {
    if (creatorTitle.creator && creatorTitle.title) {
      add(`${creatorTitle.title} ${creatorTitle.creator}`, 0.8, 'swapped');
    }
    const stripped = normalized
      .replace(EDITION_TERMS, '')
      .replace(/\([^)]*\)/g, '')
      .trim();
    if (stripped.length >= 3) add(stripped, 0.75, 'stripped');
    const separatorForm = normalized.replace(/\s+/g, '-');
    if (separatorForm !== normalized) add(separatorForm, 0.6, 'separator');
  }

  return variants;
}

export interface NormalizeOptions {
  readonly mode?: SearchMode;
  readonly filters?: Partial<SearchFilters>;
  readonly locale?: string;
}

export function normalizeQuery(
  rawInput: string,
  options: NormalizeOptions = {},
): NormalizedSearchQuery {
  if (typeof rawInput !== 'string') {
    throw new AuralisError('invalid_request', 'Enter something to search for.');
  }

  const raw = rawInput
    // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(MULTI_SPACE, ' ')
    .trim();

  if (raw.length === 0) {
    throw new AuralisError('invalid_request', 'Enter something to search for.');
  }
  if (raw.length > MAX_QUERY_LENGTH) {
    throw new AuralisError(
      'invalid_request',
      `Searches are limited to ${MAX_QUERY_LENGTH} characters.`,
    );
  }

  const parsed = parseOperators(raw);
  const normalized = normaliseText(parsed.text.length > 0 ? parsed.text : parsed.phrases.join(' '));

  if (normalized.length === 0 && parsed.phrases.length === 0) {
    throw new AuralisError(
      'unsupported_query',
      'That search contains only filters. Add something to search for.',
    );
  }

  const mode: SearchMode = options.mode ?? 'quick';
  const creatorTitle = splitCreatorTitle(parsed.text);
  const intent = inferIntent(raw, parsed);

  const baseFilters: SearchFilters = { ...EMPTY_FILTERS, ...options.filters };
  const filters: SearchFilters = {
    ...baseFilters,
    extensions: [...new Set([...baseFilters.extensions, ...parsed.filetypes])],
    providerIds: [...new Set([...baseFilters.providerIds, ...parsed.sources])],
    minBitrateBps: baseFilters.minBitrateBps ?? parsed.minBitrateBps,
  };

  return {
    raw,
    normalized,
    phrases: parsed.phrases,
    excluded: parsed.excluded,
    intent,
    creator: creatorTitle.creator,
    title: creatorTitle.title,
    variants: buildVariants(raw, normalized, parsed, creatorTitle, mode),
    filters,
    mode,
    locale: options.locale ?? 'en',
  };
}

/** True when a candidate's text contains any excluded term. */
export function violatesExclusions(text: string, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const haystack = comparisonKey(text);
  return excluded.some((term) => haystack.includes(comparisonKey(term)));
}
