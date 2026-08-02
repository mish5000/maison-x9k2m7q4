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
  buildCandidate,
  capabilities,
  configList,
  looksLikeAudioFilename,
  looksLikePlaylistFilename,
  msRemaining,
  parseSize,
} from './helpers.js';

/**
 * Generic HTTP directory-listing adapter.
 *
 * Walks configured directory index pages (Apache/nginx autoindex style) and
 * emits the audio files it finds. Traversal is confined to the configured root:
 * a link that escapes the root prefix is discarded, which is what stops a
 * crafted listing turning this into a crawler.
 *
 * Configuration:
 *   roots     — newline or comma separated directory URLs
 *   maxDepth  — optional, default 2, hard maximum 4
 */

const CONFIG_ROOTS = 'roots';
const CONFIG_MAX_DEPTH = 'maxDepth';
const HARD_MAX_DEPTH = 4;
const MAX_PAGES = 40;
const MAX_LISTING_BYTES = 1024 * 1024;

export interface DirectoryEntry {
  readonly href: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
}

const ANCHOR_PATTERN = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Parses an autoindex page. Deliberately tolerant: it reads anchors and, when
 * the listing uses the common `<pre>` layout, the trailing size/date columns.
 */
export function parseDirectoryListing(html: string, baseUrl: string): readonly DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  let guard = 0;

  const lines = html.split(/\r?\n/);
  const metadataByHref = new Map<string, { size: number | null; modified: string | null }>();
  for (const line of lines) {
    const anchor = /href\s*=\s*["']([^"']+)["']/i.exec(line);
    if (!anchor?.[1]) continue;
    // Apache: "date time   size" after the closing anchor tag.
    const trailing = line.replace(/<[^>]*>/g, ' ').trim();
    const sizeMatch = /(\d{1,3}(?:[.,]\d+)?[KMG]?)\s*$/.exec(trailing);
    const dateMatch = /(\d{2}-\w{3}-\d{4}\s+\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.exec(
      trailing,
    );
    metadataByHref.set(anchor[1], {
      size: sizeMatch?.[1] ? humanSizeToBytes(sizeMatch[1]) : null,
      modified: dateMatch?.[1] ?? null,
    });
  }

  ANCHOR_PATTERN.lastIndex = 0;
  while ((match = ANCHOR_PATTERN.exec(html)) !== null && guard < 2000) {
    guard += 1;
    const rawHref = match[1];
    if (!rawHref) continue;
    if (rawHref.startsWith('?') || rawHref.startsWith('#') || rawHref.startsWith('mailto:'))
      continue;
    if (rawHref === '../' || rawHref === '..' || rawHref === '/') continue;

    let absolute: string;
    try {
      absolute = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const label = (match[2] ?? '').replace(/<[^>]*>/g, '').trim();
    const isDirectory = rawHref.endsWith('/');
    const name = decodeURIComponent(
      label.length > 0 && label !== 'Parent Directory'
        ? label.replace(/\/$/, '')
        : rawHref.replace(/\/$/, '').substring(rawHref.lastIndexOf('/') + 1),
    );
    if (name.length === 0) continue;

    const metadata = metadataByHref.get(rawHref);
    entries.push({
      href: absolute,
      name,
      isDirectory,
      sizeBytes: metadata?.size ?? null,
      modifiedAt: metadata?.modified ?? null,
    });
  }

  return entries;
}

function humanSizeToBytes(value: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)([KMG])?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const base = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(base)) return null;
  const unit = match[2];
  const multiplier = unit === 'G' ? 2 ** 30 : unit === 'M' ? 2 ** 20 : unit === 'K' ? 2 ** 10 : 1;
  return Math.round(base * multiplier);
}

/** True when `candidate` stays inside `root`. Prevents traversal outside scope. */
export function isWithinRoot(candidate: string, root: string): boolean {
  let candidateUrl: URL;
  let rootUrl: URL;
  try {
    candidateUrl = new URL(candidate);
    rootUrl = new URL(root);
  } catch {
    return false;
  }
  if (candidateUrl.origin !== rootUrl.origin) return false;
  const rootPath = rootUrl.pathname.endsWith('/') ? rootUrl.pathname : `${rootUrl.pathname}/`;
  // Normalising away `.` and `..` is what URL already did; this check is the
  // final guard that the resolved path is still under the configured prefix.
  return candidateUrl.pathname.startsWith(rootPath);
}

export class HttpDirectoryProvider implements SearchProvider {
  readonly id = 'http-directory';
  readonly displayName = 'HTTP directory listings';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: true,
    supportsPreview: true,
    supportsServerSideSearch: false,
    rateLimit: { kind: 'token_bucket', capacity: 6, refillPerSec: 3 },
    robotsPosture: 'user_configured',
    timeoutMs: 15_000,
    exposesFileSize: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'http_directory',
    modes: ['quick', 'deep', 'connected'],
    requiredConfiguration: [CONFIG_ROOTS],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const roots = configList(context.config[CONFIG_ROOTS]).slice(0, 8);
    if (roots.length === 0) return;

    const configuredDepth = Number.parseInt(context.config[CONFIG_MAX_DEPTH] ?? '', 10);
    const maxDepth = Math.min(
      HARD_MAX_DEPTH,
      Number.isFinite(configuredDepth) && configuredDepth > 0
        ? configuredDepth
        : context.mode === 'deep'
          ? 3
          : 2,
    );

    const searchText = query.variants[0]?.text ?? query.normalized;
    let emitted = 0;
    let pagesFetched = 0;

    for (const root of roots) {
      if (signal.aborted || emitted >= context.maxCandidates) return;

      const queue: Array<{ url: string; depth: number }> = [{ url: normaliseRoot(root), depth: 0 }];
      const visited = new Set<string>();

      while (queue.length > 0 && pagesFetched < MAX_PAGES) {
        if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0) return;
        const next = queue.shift();
        if (!next || visited.has(next.url)) continue;
        visited.add(next.url);

        let html: string;
        try {
          const response = await context.fetch(next.url, {
            signal,
            timeoutMs: Math.min(msRemaining(context), 8_000),
            maxBytes: MAX_LISTING_BYTES,
            headers: { accept: 'text/html,application/xhtml+xml' },
          });
          pagesFetched += 1;
          if (response.status !== 200) continue;
          html = response.text();
        } catch (error) {
          context.logger.warn('A configured directory could not be listed', {
            reason: error instanceof Error ? error.name : 'unknown',
          });
          continue;
        }

        for (const entry of parseDirectoryListing(html, next.url)) {
          if (!isWithinRoot(entry.href, normaliseRoot(root))) continue;

          if (entry.isDirectory) {
            if (next.depth + 1 <= maxDepth) queue.push({ url: entry.href, depth: next.depth + 1 });
            continue;
          }

          if (!looksLikeAudioFilename(entry.name) && !looksLikePlaylistFilename(entry.name))
            continue;
          if (coverage(searchText, entry.name) < 0.34) continue;
          if (emitted >= context.maxCandidates) return;

          yield buildCandidate({
            providerId: this.id,
            providerDisplayName: this.displayName,
            category: 'http_directory',
            providerAssetId: entry.href,
            title: entry.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '),
            filename: entry.name,
            mediaUrl: entry.href,
            pageUrl: next.url,
            collection: directoryLabel(next.url),
            declaredAccess: 'direct_download',
            claimed: { sizeBytes: parseSize(entry.sizeBytes) },
            extras: { directory: next.url, modified: entry.modifiedAt },
          });
          emitted += 1;
        }
      }
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const roots = configList(context.config[CONFIG_ROOTS]);
    const target = roots[0];
    if (!target) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: 'Add one or more directory addresses to search them.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/http-directory.md',
      };
    }

    const startedAt = context.now();
    try {
      const response = await context.fetch(normaliseRoot(target), {
        signal: context.signal,
        timeoutMs: 5_000,
        maxBytes: 256 * 1024,
      });
      const ok = response.status === 200;
      return {
        providerId: this.id,
        status: ok ? 'ready' : 'degraded',
        message: ok
          ? `${roots.length} director${roots.length === 1 ? 'y' : 'ies'} configured.`
          : `The first configured directory responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/http-directory.md',
      };
    } catch {
      return {
        providerId: this.id,
        status: 'degraded',
        message: 'The first configured directory could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/http-directory.md',
      };
    }
  }
}

function normaliseRoot(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function directoryLabel(rawUrl: string): string | null {
  try {
    const path = new URL(rawUrl).pathname.replace(/\/$/, '');
    const segment = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
    return segment.length > 0 ? segment : null;
  } catch {
    return null;
  }
}
