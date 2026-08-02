import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { FtpClient, type FtpEntry } from '../net/ftp-client.js';
import { PRODUCTION_URL_POLICY, type UrlSafetyPolicy } from '../net/url-safety.js';
import { coverage } from '../scoring/relevance.js';
import {
  buildCandidate,
  capabilities,
  configList,
  looksLikeAudioFilename,
  msRemaining,
} from './helpers.js';

/**
 * Generic FTP directory adapter.
 *
 * Walks configured FTP roots using the in-house client, which applies the same
 * address classification as the HTTP egress — including re-validating the
 * address a server hands back in its PASV reply.
 *
 * Files are not proxied: an FTP asset is classified `connected_private` when
 * credentials are configured, and the server streams it under a
 * workspace-scoped route rather than exposing an ftp:// URL to the browser.
 *
 * Configuration:
 *   roots    — newline or comma separated ftp:// URLs, e.g. ftp://media.example.org/audio/
 *   username — optional; defaults to anonymous
 *   password — optional secret
 *   maxDepth — optional, default 2, hard maximum 4
 */

const CONFIG_ROOTS = 'roots';
const HARD_MAX_DEPTH = 4;
const MAX_DIRECTORIES = 30;

export const FTP_REQUIRED_CONFIG = [CONFIG_ROOTS] as const;
export const FTP_SECRET_CONFIG_KEYS = ['password'] as const;

export interface FtpRoot {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

export function parseFtpRoot(value: string): FtpRoot | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'ftp:') return null;
    const port = url.port.length > 0 ? Number(url.port) : 21;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const path = url.pathname.length > 0 ? decodeURIComponent(url.pathname) : '/';
    // A path containing a traversal segment is rejected outright.
    if (path.split('/').includes('..')) return null;
    return { host: url.hostname, port, path: path.endsWith('/') ? path : `${path}/` };
  } catch {
    return null;
  }
}

export interface FtpProviderOptions {
  readonly policy?: UrlSafetyPolicy;
}

export class FtpDirectoryProvider implements SearchProvider {
  readonly id = 'ftp-directory';
  readonly displayName = 'FTP directories';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: false,
    supportsPreview: true,
    supportsServerSideSearch: false,
    requiresAuthentication: false,
    rateLimit: { kind: 'concurrency_only', maxConcurrent: 1 },
    robotsPosture: 'not_applicable',
    timeoutMs: 20_000,
    exposesFileSize: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 1,
    sourceCategory: 'ftp_directory',
    modes: ['connected', 'deep'],
    producesPrivateResults: true,
    requiredConfiguration: [CONFIG_ROOTS],
  });

  constructor(private readonly options: FtpProviderOptions = {}) {}

  private get policy(): UrlSafetyPolicy {
    return this.options.policy ?? PRODUCTION_URL_POLICY;
  }

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    const roots = configList(context.config[CONFIG_ROOTS])
      .map(parseFtpRoot)
      .filter((root): root is FtpRoot => root !== null)
      .slice(0, 4);
    if (roots.length === 0) return;

    const username = context.config['username'] ?? 'anonymous';
    const password = context.config['password'] ?? 'auralis@example.invalid';
    const configuredDepth = Number.parseInt(context.config['maxDepth'] ?? '', 10);
    const maxDepth = Math.min(
      HARD_MAX_DEPTH,
      Number.isFinite(configuredDepth) && configuredDepth > 0 ? configuredDepth : 2,
    );
    const searchText = query.variants[0]?.text ?? query.normalized;
    const hasCredentials = username !== 'anonymous';

    let emitted = 0;

    for (const root of roots) {
      if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0) return;

      let client: FtpClient;
      try {
        client = await FtpClient.connect({
          host: root.host,
          port: root.port,
          user: username,
          password,
          connectTimeoutMs: 5_000,
          commandTimeoutMs: 8_000,
          policy: this.policy,
          signal,
        });
      } catch (error) {
        context.logger.warn('A configured FTP server could not be reached', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        continue;
      }

      try {
        const queue: Array<{ path: string; depth: number }> = [{ path: root.path, depth: 0 }];
        let directoriesListed = 0;

        while (queue.length > 0 && directoriesListed < MAX_DIRECTORIES) {
          if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0)
            break;
          const current = queue.shift();
          if (!current) break;
          if (!current.path.startsWith(root.path)) continue;

          let entries: readonly FtpEntry[];
          try {
            entries = await client.list(current.path);
            directoriesListed += 1;
          } catch {
            continue;
          }

          for (const entry of entries) {
            if (entry.name.includes('/') || entry.name === '.' || entry.name === '..') continue;
            const childPath = `${current.path}${entry.name}${entry.isDirectory ? '/' : ''}`;

            if (entry.isDirectory) {
              if (current.depth + 1 <= maxDepth)
                queue.push({ path: childPath, depth: current.depth + 1 });
              continue;
            }
            if (!looksLikeAudioFilename(entry.name)) continue;
            if (coverage(searchText, entry.name) < 0.34) continue;
            if (emitted >= context.maxCandidates) break;

            yield buildCandidate({
              providerId: this.id,
              providerDisplayName: context.config['displayName'] ?? this.displayName,
              category: 'ftp_directory',
              providerAssetId: `ftp://${root.host}:${root.port}${childPath}`,
              title: entry.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '),
              filename: entry.name,
              mediaUrl: null,
              pageUrl: null,
              collection: current.path,
              publishedAt: entry.modifiedAt,
              declaredAccess: hasCredentials ? 'connected_private' : 'source_download',
              claimed: { sizeBytes: entry.sizeBytes },
              extras: {
                ftpHost: root.host,
                ftpPort: root.port,
                ftpPath: childPath,
                anonymous: !hasCredentials,
              },
            });
            emitted += 1;
          }
        }
      } finally {
        await client.close();
      }
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const roots = configList(context.config[CONFIG_ROOTS]).map(parseFtpRoot);
    const target = roots.find((root): root is FtpRoot => root !== null);

    if (!target) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message:
          roots.length === 0
            ? 'Add one or more FTP addresses to search them.'
            : 'The configured FTP addresses are not valid ftp:// URLs.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/ftp-directory.md',
      };
    }

    const startedAt = context.now();
    let client: FtpClient | null = null;
    try {
      client = await FtpClient.connect({
        host: target.host,
        port: target.port,
        user: context.config['username'] ?? 'anonymous',
        password: context.config['password'] ?? 'auralis@example.invalid',
        connectTimeoutMs: 4_000,
        commandTimeoutMs: 5_000,
        policy: this.policy,
        signal: context.signal,
      });
      return {
        providerId: this.id,
        status: 'ready',
        message: `Connected to ${target.host}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/ftp-directory.md',
      };
    } catch (error) {
      const authFailure =
        error instanceof Error && error.message.toLowerCase().includes('credentials');
      return {
        providerId: this.id,
        status: authFailure ? 'auth_required' : 'unavailable',
        message: authFailure
          ? 'The server rejected the stored credentials.'
          : 'The FTP server could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/ftp-directory.md',
      };
    } finally {
      await client?.close();
    }
  }
}
