import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { coverage } from '../scoring/relevance.js';
import {
  findChild,
  findChildren,
  findDescendants,
  parseXml,
  textOf,
  type XmlNode,
} from '../util/xml.js';
import {
  buildCandidate,
  capabilities,
  configList,
  msRemaining,
  parseDuration,
  parseSize,
} from './helpers.js';

/**
 * RSS / Atom feed adapter.
 *
 * Feeds are supplied by the user or an administrator — this provider never
 * discovers feeds on its own. Each configured feed is fetched, parsed with the
 * hardened XML reader (no DOCTYPE, no entity expansion), and filtered
 * client-side because feeds have no server-side search.
 *
 * Configuration:
 *   feeds — newline or comma separated list of feed URLs
 */

const CONFIG_FEEDS = 'feeds';
const MAX_FEEDS = 12;
const MAX_ITEMS_PER_FEED = 300;
const MAX_FEED_BYTES = 2 * 1024 * 1024;

interface FeedItem {
  readonly title: string;
  readonly creator: string | null;
  readonly mediaUrl: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly pageUrl: string | null;
  readonly publishedAt: string | null;
  readonly artworkUrl: string | null;
  readonly guid: string;
  readonly description: string | null;
}

/** Extracts items from either an RSS 2.0 or an Atom document. */
export function extractFeedItems(
  document: XmlNode | null,
  feedUrl: string,
): {
  readonly feedTitle: string | null;
  readonly feedImage: string | null;
  readonly items: readonly FeedItem[];
} {
  if (!document) return { feedTitle: null, feedImage: null, items: [] };

  const rss = findChild(document, 'rss');
  const channel = rss ? findChild(rss, 'channel') : null;
  const atomFeed = findChild(document, 'feed');
  const root = channel ?? atomFeed;
  if (!root) return { feedTitle: null, feedImage: null, items: [] };

  const feedTitle = textOf(findChild(root, 'title'));
  const feedImage =
    findChild(root, 'image')?.attributes['href'] ??
    textOf(findChild(findChild(root, 'image'), 'url')) ??
    findChildren(root, 'image')[0]?.attributes['href'] ??
    null;

  const entries = channel ? findChildren(root, 'item') : findChildren(root, 'entry');
  const items: FeedItem[] = [];

  for (const entry of entries.slice(0, MAX_ITEMS_PER_FEED)) {
    const enclosure =
      findChild(entry, 'enclosure') ??
      findChildren(entry, 'link').find(
        (link) =>
          link.attributes['rel'] === 'enclosure' && typeof link.attributes['href'] === 'string',
      ) ??
      null;

    const mediaUrl = enclosure?.attributes['url'] ?? enclosure?.attributes['href'] ?? null;

    const linkNode = findChildren(entry, 'link').find(
      (link) => link.attributes['rel'] === undefined || link.attributes['rel'] === 'alternate',
    );
    const pageUrl = textOf(findChild(entry, 'link')) ?? linkNode?.attributes['href'] ?? null;

    const durationNode = findChildren(entry, 'duration')[0];
    const imageNode = findChildren(entry, 'image')[0];

    items.push({
      title: textOf(findChild(entry, 'title')) ?? 'Untitled episode',
      creator:
        textOf(findChildren(entry, 'author')[0] ?? null) ??
        textOf(findChild(findChildren(entry, 'author')[0] ?? null, 'name')) ??
        textOf(findChildren(entry, 'creator')[0] ?? null) ??
        feedTitle,
      mediaUrl,
      mimeType: enclosure?.attributes['type'] ?? null,
      sizeBytes: parseSize(enclosure?.attributes['length'] ?? null),
      durationSeconds: parseDuration(textOf(durationNode ?? null)),
      pageUrl,
      publishedAt:
        textOf(findChild(entry, 'pubDate')) ??
        textOf(findChild(entry, 'published')) ??
        textOf(findChild(entry, 'updated')),
      artworkUrl: imageNode?.attributes['href'] ?? feedImage,
      guid: textOf(findChild(entry, 'guid')) ?? mediaUrl ?? `${feedUrl}#${items.length}`,
      description: truncate(
        textOf(findChild(entry, 'description')) ?? textOf(findChild(entry, 'summary')),
        500,
      ),
    });
  }

  return { feedTitle, feedImage, items };
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class RssFeedProvider implements SearchProvider {
  readonly id = 'rss-feed';
  readonly displayName = 'RSS and Atom feeds';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: true,
    supportsPreview: true,
    supportsServerSideSearch: false,
    rateLimit: { kind: 'concurrency_only', maxConcurrent: 3 },
    robotsPosture: 'user_configured',
    timeoutMs: 12_000,
    exposesFileSize: true,
    exposesDuration: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 3,
    sourceCategory: 'podcast_feed',
    modes: ['quick', 'deep', 'connected'],
    requiredConfiguration: [CONFIG_FEEDS],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const feeds = configList(context.config[CONFIG_FEEDS]).slice(0, MAX_FEEDS);
    if (feeds.length === 0) return;

    const searchText = query.variants[0]?.text ?? query.normalized;
    let emitted = 0;

    for (const feedUrl of feeds) {
      if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0) return;

      let xml: XmlNode | null;
      try {
        const response = await context.fetch(feedUrl, {
          signal,
          timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
          maxBytes: MAX_FEED_BYTES,
          headers: {
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          },
        });
        if (response.status !== 200) continue;
        xml = parseXml(response.text());
      } catch (error) {
        context.logger.warn('A configured feed could not be read', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        continue;
      }

      const { feedTitle, items } = extractFeedItems(xml, feedUrl);

      // Feeds have no server-side search, so relevance is applied here to avoid
      // flooding the pipeline with every episode of every configured show.
      const scored = items
        .map((item) => ({
          item,
          score: Math.max(
            coverage(searchText, item.title),
            coverage(searchText, `${item.title} ${item.description ?? ''}`) * 0.7,
          ),
        }))
        .filter((entry) => entry.score >= 0.34)
        .sort((a, b) => b.score - a.score)
        .slice(0, context.mode === 'deep' ? 25 : 10);

      for (const { item } of scored) {
        if (emitted >= context.maxCandidates) return;
        yield buildCandidate({
          providerId: this.id,
          providerDisplayName: this.displayName,
          category: 'podcast_feed',
          providerAssetId: item.guid,
          title: item.title,
          creator: item.creator,
          filename: item.mediaUrl ? filenameOf(item.mediaUrl) : null,
          mediaUrl: item.mediaUrl,
          pageUrl: item.pageUrl,
          collection: feedTitle,
          attribution: item.creator ?? feedTitle,
          publishedAt: item.publishedAt,
          artworkUrl: item.artworkUrl,
          declaredAccess: item.mediaUrl ? 'direct_download' : 'metadata_only',
          claimed: {
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            durationSeconds: item.durationSeconds,
          },
          tags: { title: item.title, artist: item.creator, album: feedTitle },
          extras: { feedUrl, summary: item.description },
        });
        emitted += 1;
      }
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const feeds = configList(context.config[CONFIG_FEEDS]);
    if (feeds.length === 0) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: 'Add one or more feed addresses to search them.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/rss-feed.md',
      };
    }

    const startedAt = context.now();
    const target = feeds[0];
    if (!target) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: 'Add one or more feed addresses to search them.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/rss-feed.md',
      };
    }

    try {
      const response = await context.fetch(target, {
        signal: context.signal,
        timeoutMs: 5_000,
        maxBytes: 256 * 1024,
      });
      const ok = response.status === 200;
      return {
        providerId: this.id,
        status: ok ? 'ready' : 'degraded',
        message: ok
          ? `${feeds.length} feed${feeds.length === 1 ? '' : 's'} configured.`
          : `The first configured feed responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/rss-feed.md',
      };
    } catch {
      return {
        providerId: this.id,
        status: 'degraded',
        message: 'The first configured feed could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/rss-feed.md',
      };
    }
  }
}

function filenameOf(rawUrl: string): string | null {
  try {
    const path = new URL(rawUrl).pathname;
    const name = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Exported for the provider contract tests. */
export function feedItemCount(document: XmlNode | null): number {
  return findDescendants(document, 'item').length + findDescendants(document, 'entry').length;
}
