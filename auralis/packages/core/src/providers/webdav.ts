import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { coverage } from '../scoring/relevance.js';
import { findDescendants, parseXml, textOf, type XmlNode } from '../util/xml.js';
import {
  buildCandidate,
  capabilities,
  isConfigured,
  looksLikeAudioFilename,
  msRemaining,
  parseSize,
} from './helpers.js';

/**
 * WebDAV connector (Nextcloud, ownCloud, generic DAV servers).
 *
 * Uses PROPFIND with Depth: 1 and walks the collection tree, bounded by depth
 * and request count. Credentials are sent only to the configured host and are
 * dropped automatically on any cross-origin redirect by the egress layer.
 *
 * Configuration:
 *   baseUrl  — collection URL, e.g. https://cloud.example.org/remote.php/dav/files/alice/Music/
 *   username — secret
 *   password — secret (an app password is strongly preferred)
 */

export const WEBDAV_REQUIRED_CONFIG = ['baseUrl', 'username', 'password'] as const;
export const WEBDAV_SECRET_CONFIG_KEYS = ['password'] as const;

const MAX_COLLECTIONS = 40;
const MAX_DEPTH = 4;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/><d:getetag/>
</d:prop></d:propfind>`;

export interface DavEntry {
  readonly href: string;
  readonly displayName: string | null;
  readonly isCollection: boolean;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

/** Parses a multistatus PROPFIND response into entries. */
export function parsePropfindResponse(xml: string, baseUrl: string): readonly DavEntry[] {
  let document: XmlNode | null;
  try {
    document = parseXml(xml);
  } catch {
    return [];
  }
  if (!document) return [];

  const responses = findDescendants(document, 'response', 2000);
  const entries: DavEntry[] = [];

  for (const response of responses) {
    const href = textOf(findDescendants(response, 'href', 4)[0] ?? null);
    if (!href) continue;

    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const resourceType = findDescendants(response, 'resourcetype', 8)[0] ?? null;
    const isCollection =
      resourceType !== null && findDescendants(resourceType, 'collection', 4).length > 0;

    entries.push({
      href: absolute,
      displayName: textOf(findDescendants(response, 'displayname', 8)[0] ?? null),
      isCollection,
      sizeBytes: parseSize(textOf(findDescendants(response, 'getcontentlength', 8)[0] ?? null)),
      contentType: textOf(findDescendants(response, 'getcontenttype', 8)[0] ?? null),
      lastModified: textOf(findDescendants(response, 'getlastmodified', 8)[0] ?? null),
      etag: textOf(findDescendants(response, 'getetag', 8)[0] ?? null)?.replace(/"/g, '') ?? null,
    });
  }

  return entries;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export class WebDavProvider implements SearchProvider {
  readonly id = 'webdav';
  readonly displayName = 'WebDAV storage';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: false,
    supportsPreview: true,
    supportsServerSideSearch: false,
    requiresAuthentication: true,
    rateLimit: { kind: 'token_bucket', capacity: 6, refillPerSec: 3 },
    robotsPosture: 'not_applicable',
    timeoutMs: 15_000,
    exposesFileSize: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'connected_storage',
    modes: ['connected'],
    producesPrivateResults: true,
    requiredConfiguration: [...WEBDAV_REQUIRED_CONFIG],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    if (!isConfigured(context, WEBDAV_REQUIRED_CONFIG)) return;

    const baseUrl = normaliseCollection(context.config['baseUrl'] ?? '');
    const username = context.config['username'] ?? '';
    const password = context.config['password'] ?? '';
    const searchText = query.variants[0]?.text ?? query.normalized;

    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return;
    }

    const queue: Array<{ url: string; depth: number }> = [{ url: baseUrl, depth: 0 }];
    const visited = new Set<string>();
    let emitted = 0;
    let collectionsFetched = 0;

    while (queue.length > 0 && collectionsFetched < MAX_COLLECTIONS) {
      if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0) return;
      const current = queue.shift();
      if (!current || visited.has(current.url)) continue;
      visited.add(current.url);

      let body: string;
      try {
        const response = await context.fetch(current.url, {
          method: 'PROPFIND',
          headers: {
            authorization: basicAuthHeader(username, password),
            depth: '1',
            'content-type': 'application/xml; charset=utf-8',
          },
          body: PROPFIND_BODY,
          signal,
          timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
          maxBytes: 4 * 1024 * 1024,
          allowHosts: [host],
        });
        collectionsFetched += 1;
        if (response.status === 401 || response.status === 403) {
          context.logger.warn('WebDAV connector rejected the stored credentials');
          return;
        }
        if (response.status !== 207 && response.status !== 200) continue;
        body = response.text();
      } catch (error) {
        context.logger.warn('WebDAV collection could not be listed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        continue;
      }

      for (const entry of parsePropfindResponse(body, current.url)) {
        if (entry.href === current.url) continue; // the collection itself
        if (!entry.href.startsWith(baseUrl)) continue; // never leave the configured root

        if (entry.isCollection) {
          if (current.depth + 1 <= MAX_DEPTH)
            queue.push({ url: entry.href, depth: current.depth + 1 });
          continue;
        }

        const name = entry.displayName ?? decodeSegment(entry.href);
        if (!name || !looksLikeAudioFilename(name)) continue;
        if (coverage(searchText, name) < 0.34) continue;
        if (emitted >= context.maxCandidates) return;

        yield buildCandidate({
          providerId: this.id,
          providerDisplayName: context.config['displayName'] ?? this.displayName,
          category: 'connected_storage',
          providerAssetId: entry.href,
          title: name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '),
          filename: name,
          mediaUrl: null,
          pageUrl: null,
          collection: decodeSegment(current.url.replace(/\/$/, '')),
          publishedAt: entry.lastModified,
          declaredAccess: 'connected_private',
          claimed: { sizeBytes: entry.sizeBytes, mimeType: entry.contentType },
          extras: { davHref: entry.href, etag: entry.etag },
        });
        emitted += 1;
      }
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const missing = WEBDAV_REQUIRED_CONFIG.filter((key) => !context.config[key]);
    if (missing.length > 0) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: `Connect a WebDAV folder to search it. Missing: ${missing.join(', ')}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/webdav.md',
      };
    }

    const startedAt = context.now();
    const baseUrl = normaliseCollection(context.config['baseUrl'] ?? '');
    try {
      const response = await context.fetch(baseUrl, {
        method: 'PROPFIND',
        headers: {
          authorization: basicAuthHeader(
            context.config['username'] ?? '',
            context.config['password'] ?? '',
          ),
          depth: '0',
          'content-type': 'application/xml; charset=utf-8',
        },
        body: PROPFIND_BODY,
        signal: context.signal,
        timeoutMs: 6_000,
        maxBytes: 256 * 1024,
        allowHosts: [new URL(baseUrl).hostname],
      });

      if (response.status === 207 || response.status === 200) {
        return {
          providerId: this.id,
          status: 'ready',
          message: 'Connected.',
          checkedAt: new Date().toISOString(),
          latencyMs: context.now() - startedAt,
          setupDocPath: 'docs/providers/webdav.md',
        };
      }
      return {
        providerId: this.id,
        status: response.status === 401 || response.status === 403 ? 'auth_required' : 'degraded',
        message:
          response.status === 401 || response.status === 403
            ? 'The stored credentials were rejected. Reconnect this folder.'
            : `The server responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/webdav.md',
      };
    } catch {
      return {
        providerId: this.id,
        status: 'unavailable',
        message: 'The WebDAV server could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/webdav.md',
      };
    }
  }
}

function normaliseCollection(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function decodeSegment(rawUrl: string): string {
  try {
    const path = new URL(rawUrl).pathname.replace(/\/$/, '');
    return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
  } catch {
    return '';
  }
}
