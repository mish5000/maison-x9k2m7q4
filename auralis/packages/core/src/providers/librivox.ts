import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { buildCandidate, capabilities, msRemaining, parseDuration } from './helpers.js';

/**
 * LibriVox adapter.
 *
 * LibriVox publishes public-domain audiobook recordings and exposes a read-only
 * JSON API with no key. The API returns per-book archive links rather than
 * per-chapter media URLs, so results are classified `source_download`: the file
 * exists and is downloadable, but through the item page rather than a URL this
 * adapter can hand over directly.
 *
 * Docs: https://librivox.org/api/info
 */

const API_ENDPOINT = 'https://librivox.org/api/feed/audiobooks';

interface LibrivoxAuthor {
  readonly first_name?: string;
  readonly last_name?: string;
}

interface LibrivoxBook {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly url_librivox?: string;
  readonly url_zip_file?: string;
  readonly url_rss?: string;
  readonly url_text_source?: string;
  readonly totaltimesecs?: number;
  readonly totaltime?: string;
  readonly language?: string;
  readonly copyright_year?: string;
  readonly num_sections?: string;
  readonly authors?: readonly LibrivoxAuthor[];
}

interface LibrivoxResponse {
  readonly books?: readonly LibrivoxBook[];
}

function authorName(book: LibrivoxBook): string | null {
  const author = book.authors?.[0];
  if (!author) return null;
  const name = [author.first_name, author.last_name].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}

export class LibriVoxProvider implements SearchProvider {
  readonly id = 'librivox';
  readonly displayName = 'LibriVox';
  readonly capabilities = capabilities({
    returnsDirectMediaUrls: false,
    supportsPreview: false,
    rateLimit: { kind: 'token_bucket', capacity: 4, refillPerSec: 1 },
    robotsPosture: 'api_terms_only',
    timeoutMs: 10_000,
    exposesDuration: true,
    supportsPagination: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'open_archive',
    modes: ['quick', 'deep'],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const limit = context.mode === 'deep' ? 30 : 10;
    const searchText = query.title ?? query.variants[0]?.text ?? query.normalized;

    const url = new URL(API_ENDPOINT);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('extended', '1');
    url.searchParams.set('title', `^${searchText}`);

    const response = await context.fetch(url.toString(), {
      signal,
      timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
      maxBytes: 1024 * 1024,
    });
    if (response.status !== 200) return;

    let payload: LibrivoxResponse;
    try {
      payload = response.json<LibrivoxResponse>();
    } catch {
      context.logger.warn('LibriVox returned a response that was not valid JSON');
      return;
    }

    let emitted = 0;
    for (const book of payload.books ?? []) {
      if (signal.aborted || emitted >= context.maxCandidates) return;
      const pageUrl = book.url_librivox ?? null;
      const archiveUrl = book.url_zip_file ?? null;
      if (!pageUrl && !archiveUrl) continue;

      yield buildCandidate({
        providerId: this.id,
        providerDisplayName: this.displayName,
        category: 'open_archive',
        providerAssetId: String(book.id ?? pageUrl ?? archiveUrl),
        title: book.title ?? 'Untitled recording',
        creator: authorName(book),
        filename: null,
        // The zip archive is not a playable audio file, so it is never offered
        // as a media URL. The listing points at the item page instead.
        mediaUrl: null,
        pageUrl,
        collection: 'LibriVox',
        attribution: authorName(book)
          ? `${authorName(book)} — read by LibriVox volunteers`
          : 'LibriVox',
        rightsStatement: book.copyright_year
          ? `Public domain (${book.copyright_year})`
          : 'Public domain',
        declaredAccess: 'source_download',
        claimed: {
          durationSeconds:
            typeof book.totaltimesecs === 'number' && book.totaltimesecs > 0
              ? book.totaltimesecs
              : parseDuration(book.totaltime ?? null),
        },
        extras: {
          librivoxId: book.id ?? null,
          sections: book.num_sections ?? null,
          language: book.language ?? null,
          rssFeed: book.url_rss ?? null,
        },
      });
      emitted += 1;
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const startedAt = context.now();
    try {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');
      const response = await context.fetch(url.toString(), {
        signal: context.signal,
        timeoutMs: 5_000,
        maxBytes: 128 * 1024,
      });
      return {
        providerId: this.id,
        status: response.status === 200 ? 'ready' : 'degraded',
        message:
          response.status === 200 ? 'Reachable.' : `Responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: null,
      };
    } catch {
      return {
        providerId: this.id,
        status: 'unavailable',
        message: 'LibriVox could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: null,
      };
    }
  }
}
