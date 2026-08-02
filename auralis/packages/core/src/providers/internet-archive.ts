import type { RawSearchCandidate } from '../domain/candidate.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import {
  buildCandidate,
  capabilities,
  looksLikeAudioFilename,
  msRemaining,
  parseDuration,
  parseSize,
} from './helpers.js';

/**
 * Internet Archive adapter.
 *
 * Uses the public advancedsearch endpoint to find audio items, then the item
 * metadata endpoint to enumerate the files inside each item. No API key is
 * required. Item files are served directly, so this provider does return direct
 * media URLs — but the access decision is still made downstream.
 *
 * Docs: https://archive.org/advancedsearch.php and https://archive.org/metadata/
 */

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';
const DETAILS_BASE = 'https://archive.org/details';

interface ArchiveSearchDoc {
  readonly identifier?: string;
  readonly title?: string | readonly string[];
  readonly creator?: string | readonly string[];
  readonly date?: string;
  readonly publicdate?: string;
  readonly collection?: string | readonly string[];
  readonly licenseurl?: string;
  readonly rights?: string;
}

interface ArchiveSearchResponse {
  readonly response?: {
    readonly numFound?: number;
    readonly docs?: readonly ArchiveSearchDoc[];
  };
}

interface ArchiveFile {
  readonly name?: string;
  readonly source?: string;
  readonly format?: string;
  readonly size?: string;
  readonly length?: string;
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly track?: string;
  readonly md5?: string;
  readonly height?: string;
}

interface ArchiveMetadataResponse {
  readonly files?: readonly ArchiveFile[];
  readonly metadata?: Record<string, string | readonly string[]>;
  readonly server?: string;
  readonly dir?: string;
}

const AUDIO_FORMAT_HINTS = [
  'VBR MP3',
  '128Kbps MP3',
  '64Kbps MP3',
  '32Kbps MP3',
  'MP3',
  'Flac',
  'Ogg Vorbis',
  'AIFF',
  'WAVE',
  '24bit Flac',
];

function first(value: string | readonly string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return null;
}

/** Escapes a term for the Lucene-style query syntax the endpoint expects. */
export function escapeArchiveQuery(text: string): string {
  return text
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildArchiveQuery(query: NormalizedSearchQuery): string {
  const clauses: string[] = ['mediatype:(audio)'];

  const phrases = query.phrases
    .map((phrase) => `"${escapeArchiveQuery(phrase)}"`)
    .filter((p) => p.length > 2);
  const terms = escapeArchiveQuery(query.variants[0]?.text ?? query.normalized);

  if (phrases.length > 0) clauses.push(phrases.join(' AND '));
  if (terms.length > 0) clauses.push(`(${terms})`);
  for (const excluded of query.excluded.slice(0, 4)) {
    const safe = escapeArchiveQuery(excluded);
    if (safe.length > 1) clauses.push(`NOT (${safe})`);
  }

  return clauses.join(' AND ');
}

export class InternetArchiveProvider implements SearchProvider {
  readonly id = 'internet-archive';
  readonly displayName = 'Internet Archive';
  readonly capabilities = capabilities({
    supportsExactTitleSearch: true,
    returnsDirectMediaUrls: true,
    supportsPreview: true,
    rateLimit: { kind: 'token_bucket', capacity: 8, refillPerSec: 2 },
    robotsPosture: 'api_terms_only',
    timeoutMs: 12_000,
    exposesFileSize: true,
    exposesDuration: true,
    exposesBitrate: false,
    supportsPagination: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 3,
    sourceCategory: 'open_archive',
    modes: ['quick', 'deep'],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const rows = context.mode === 'deep' ? 30 : 12;
    const searchUrl = new URL(SEARCH_ENDPOINT);
    searchUrl.searchParams.set('q', buildArchiveQuery(query));
    searchUrl.searchParams.set('rows', String(rows));
    searchUrl.searchParams.set('page', '1');
    searchUrl.searchParams.set('output', 'json');
    for (const field of [
      'identifier',
      'title',
      'creator',
      'date',
      'publicdate',
      'collection',
      'licenseurl',
    ]) {
      searchUrl.searchParams.append('fl[]', field);
    }

    const response = await context.fetch(searchUrl.toString(), {
      signal,
      timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
      maxBytes: 512 * 1024,
    });

    if (response.status !== 200) return;

    let payload: ArchiveSearchResponse;
    try {
      payload = response.json<ArchiveSearchResponse>();
    } catch {
      context.logger.warn('Internet Archive returned a response that was not valid JSON');
      return;
    }

    const docs = payload.response?.docs ?? [];
    let emitted = 0;

    for (const doc of docs) {
      if (signal.aborted || msRemaining(context) <= 0) return;
      if (emitted >= context.maxCandidates) return;
      const identifier = doc.identifier;
      if (typeof identifier !== 'string' || identifier.length === 0) continue;

      const files = await this.fetchItemFiles(identifier, context, signal);
      for (const candidate of files) {
        if (emitted >= context.maxCandidates) return;
        yield candidate;
        emitted += 1;
      }
    }
  }

  private async fetchItemFiles(
    identifier: string,
    context: SearchContext,
    signal: AbortSignal,
  ): Promise<readonly RawSearchCandidate[]> {
    if (msRemaining(context) <= 0) return [];

    let metadata: ArchiveMetadataResponse;
    try {
      const response = await context.fetch(
        `${METADATA_ENDPOINT}/${encodeURIComponent(identifier)}`,
        {
          signal,
          timeoutMs: Math.min(msRemaining(context), 6_000),
          maxBytes: 1024 * 1024,
        },
      );
      if (response.status !== 200) return [];
      metadata = response.json<ArchiveMetadataResponse>();
    } catch {
      return [];
    }

    const meta = metadata.metadata ?? {};
    const itemTitle = first(meta['title']) ?? identifier;
    const itemCreator = first(meta['creator']);
    const collection = first(meta['collection']);
    const rights = first(meta['rights']) ?? first(meta['licenseurl']);
    const publishedAt = first(meta['publicdate']) ?? first(meta['date']);

    const candidates: RawSearchCandidate[] = [];
    const files = metadata.files ?? [];

    // Prefer original files over derived ones, then take the best few per item.
    const audioFiles = files
      .filter((file) => typeof file.name === 'string' && looksLikeAudioFilename(file.name))
      .filter(
        (file) =>
          file.format === undefined ||
          AUDIO_FORMAT_HINTS.some((hint) => file.format?.includes(hint)),
      )
      .sort((a, b) => rankFile(b) - rankFile(a))
      .slice(0, 6);

    for (const file of audioFiles) {
      const name = file.name;
      if (typeof name !== 'string') continue;
      const mediaUrl = `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURI(name)}`;

      candidates.push(
        buildCandidate({
          providerId: this.id,
          providerDisplayName: this.displayName,
          category: 'open_archive',
          providerAssetId: `${identifier}/${name}`,
          title: file.title ?? stripExtension(name) ?? itemTitle,
          creator: file.artist ?? itemCreator,
          filename: name.substring(name.lastIndexOf('/') + 1),
          mediaUrl,
          pageUrl: `${DETAILS_BASE}/${encodeURIComponent(identifier)}`,
          collection: file.album ?? collection,
          attribution: itemCreator ? `${itemCreator} via Internet Archive` : 'Internet Archive',
          rightsStatement: rights,
          publishedAt,
          declaredAccess: 'direct_download',
          claimed: {
            format: file.format ?? null,
            sizeBytes: parseSize(file.size),
            durationSeconds: parseDuration(file.length),
          },
          tags: {
            title: file.title ?? null,
            artist: file.artist ?? null,
            album: file.album ?? null,
            trackNumber: file.track ? Number.parseInt(file.track, 10) || null : null,
          },
          extras: {
            archiveIdentifier: identifier,
            archiveFormat: file.format ?? null,
            archiveSource: file.source ?? null,
            publishedHash: file.md5 ?? null,
          },
        }),
      );
    }

    return candidates;
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const startedAt = context.now();
    try {
      const url = new URL(SEARCH_ENDPOINT);
      url.searchParams.set('q', 'mediatype:(audio)');
      url.searchParams.set('rows', '1');
      url.searchParams.set('output', 'json');
      const response = await context.fetch(url.toString(), {
        signal: context.signal,
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
      const latencyMs = context.now() - startedAt;
      return {
        providerId: this.id,
        status: response.status === 200 ? 'ready' : 'degraded',
        message:
          response.status === 200
            ? 'Reachable.'
            : `The archive responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs,
        setupDocPath: null,
      };
    } catch {
      return {
        providerId: this.id,
        status: 'unavailable',
        message: 'The archive could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: null,
      };
    }
  }
}

function rankFile(file: ArchiveFile): number {
  let score = 0;
  if (file.source === 'original') score += 100;
  if (file.format?.includes('Flac')) score += 40;
  if (file.format === 'VBR MP3') score += 30;
  if (file.format?.includes('128Kbps')) score += 20;
  if (file.format?.includes('64Kbps')) score += 5;
  if (parseSize(file.size) !== null) score += 2;
  if (parseDuration(file.length) !== null) score += 2;
  return score;
}

function stripExtension(name: string): string | null {
  const base = name.substring(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.length > 0 ? stem.replace(/[_-]+/g, ' ') : null;
}
