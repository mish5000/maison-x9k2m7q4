import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { buildCandidate, capabilities, msRemaining } from './helpers.js';

/**
 * Wikimedia Commons adapter, using the MediaWiki API's generator search with
 * the `imageinfo` property to obtain direct file URLs and technical metadata.
 *
 * No API key is required. Commons publishes licence and author information per
 * file, which is carried through verbatim as attribution — never inferred.
 *
 * Docs: https://commons.wikimedia.org/w/api.php?action=help&modules=query
 */

const API_ENDPOINT = 'https://commons.wikimedia.org/w/api.php';

interface ImageInfoEntry {
  readonly url?: string;
  readonly descriptionurl?: string;
  readonly size?: number;
  readonly mime?: string;
  readonly duration?: number;
  readonly extmetadata?: Record<string, { value?: string }>;
}

interface CommonsPage {
  readonly pageid?: number;
  readonly title?: string;
  readonly imageinfo?: readonly ImageInfoEntry[];
}

interface CommonsResponse {
  readonly query?: {
    readonly pages?: Record<string, CommonsPage> | readonly CommonsPage[];
  };
}

function stripHtml(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

export class WikimediaCommonsProvider implements SearchProvider {
  readonly id = 'wikimedia-commons';
  readonly displayName = 'Wikimedia Commons';
  readonly capabilities = capabilities({
    returnsDirectMediaUrls: true,
    supportsPreview: true,
    rateLimit: { kind: 'token_bucket', capacity: 5, refillPerSec: 1 },
    robotsPosture: 'api_terms_only',
    timeoutMs: 10_000,
    exposesFileSize: true,
    exposesDuration: true,
    supportsPagination: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'open_data',
    modes: ['quick', 'deep'],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const limit = context.mode === 'deep' ? 40 : 15;
    const searchText = query.variants[0]?.text ?? query.normalized;

    const url = new URL(API_ENDPOINT);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', `filetype:audio ${searchText}`);
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', String(limit));
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|mime|extmetadata|mediatype');
    url.searchParams.set(
      'iiextmetadatafilter',
      'Artist|LicenseShortName|UsageTerms|DateTimeOriginal|Credit',
    );

    const response = await context.fetch(url.toString(), {
      signal,
      timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
      maxBytes: 1024 * 1024,
    });
    if (response.status !== 200) return;

    let payload: CommonsResponse;
    try {
      payload = response.json<CommonsResponse>();
    } catch {
      context.logger.warn('Wikimedia Commons returned a response that was not valid JSON');
      return;
    }

    const rawPages = payload.query?.pages;
    const pages: readonly CommonsPage[] = Array.isArray(rawPages)
      ? rawPages
      : rawPages
        ? Object.values(rawPages)
        : [];

    let emitted = 0;
    for (const page of pages) {
      if (signal.aborted || emitted >= context.maxCandidates) return;
      const info = page.imageinfo?.[0];
      const mediaUrl = info?.url;
      if (typeof mediaUrl !== 'string') continue;

      const title = (page.title ?? '').replace(/^File:/i, '');
      const extra = info?.extmetadata ?? {};

      yield buildCandidate({
        providerId: this.id,
        providerDisplayName: this.displayName,
        category: 'open_data',
        providerAssetId: String(page.pageid ?? page.title ?? mediaUrl),
        title: title.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '),
        creator: stripHtml(extra['Artist']?.value) ?? stripHtml(extra['Credit']?.value),
        filename: decodeURIComponent(mediaUrl.substring(mediaUrl.lastIndexOf('/') + 1)),
        mediaUrl,
        pageUrl: info?.descriptionurl ?? null,
        attribution: stripHtml(extra['Artist']?.value) ?? 'Wikimedia Commons',
        rightsStatement:
          stripHtml(extra['LicenseShortName']?.value) ?? stripHtml(extra['UsageTerms']?.value),
        publishedAt: stripHtml(extra['DateTimeOriginal']?.value),
        declaredAccess: 'direct_download',
        claimed: {
          mimeType: info?.mime ?? null,
          sizeBytes: typeof info?.size === 'number' ? info.size : null,
          durationSeconds: typeof info?.duration === 'number' ? info.duration : null,
        },
        extras: { commonsPageId: page.pageid ?? null },
      });
      emitted += 1;
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const startedAt = context.now();
    try {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set('action', 'query');
      url.searchParams.set('format', 'json');
      url.searchParams.set('meta', 'siteinfo');
      const response = await context.fetch(url.toString(), {
        signal: context.signal,
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
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
        message: 'Wikimedia Commons could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: null,
      };
    }
  }
}
