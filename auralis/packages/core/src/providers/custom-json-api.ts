import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import {
  buildCandidate,
  capabilities,
  isConfigured,
  msRemaining,
  parseDuration,
  parseSize,
} from './helpers.js';

/**
 * Custom JSON API connector.
 *
 * Lets an organisation point Auralis at an internal catalogue without writing
 * code: the administrator supplies a URL template and a field mapping, and this
 * adapter walks the response with those paths. No code is evaluated — mappings
 * are dotted paths resolved against plain JSON, so a malicious configuration
 * cannot execute anything.
 *
 * Configuration:
 *   urlTemplate  — e.g. https://media.example.org/api/search?q={query}&limit={limit}
 *   itemsPath    — dotted path to the result array, e.g. data.results
 *   titlePath, mediaUrlPath — required field mappings
 * Optional:
 *   creatorPath, pageUrlPath, filenamePath, durationPath, sizePath,
 *   bitratePath, mimeTypePath, publishedAtPath, artworkPath, idPath,
 *   authHeaderName, authHeaderValue (secret), accessClassification
 */

export const CUSTOM_API_REQUIRED_CONFIG = [
  'urlTemplate',
  'itemsPath',
  'titlePath',
  'mediaUrlPath',
] as const;
export const CUSTOM_API_SECRET_CONFIG_KEYS = ['authHeaderValue'] as const;

const MAX_ITEMS = 200;

/** Resolves a dotted path such as `data.items.0.title` against parsed JSON. */
export function resolvePath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    // Only own enumerable properties: prototype keys are never traversed.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function expandTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? ''),
  );
}

export class CustomJsonApiProvider implements SearchProvider {
  readonly id = 'custom-json-api';
  readonly displayName = 'Custom JSON API';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: true,
    supportsPreview: true,
    supportsServerSideSearch: true,
    requiresAuthentication: true,
    rateLimit: { kind: 'token_bucket', capacity: 6, refillPerSec: 3 },
    robotsPosture: 'user_configured',
    timeoutMs: 12_000,
    exposesFileSize: true,
    exposesDuration: true,
    exposesBitrate: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'organisation_repository',
    modes: ['connected', 'deep'],
    producesPrivateResults: true,
    requiredConfiguration: [...CUSTOM_API_REQUIRED_CONFIG],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    if (!isConfigured(context, CUSTOM_API_REQUIRED_CONFIG)) return;

    const template = context.config['urlTemplate'] ?? '';
    const limit = String(context.mode === 'deep' ? 50 : 20);
    const url = expandTemplate(template, {
      query: query.variants[0]?.text ?? query.normalized,
      limit,
      locale: query.locale,
    });

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      context.logger.warn('The configured API address is not a valid URL');
      return;
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    const authName = context.config['authHeaderName'];
    const authValue = context.config['authHeaderValue'];
    if (authName && authValue) headers[authName.toLowerCase()] = authValue;

    let payload: unknown;
    try {
      const response = await context.fetch(url, {
        headers,
        signal,
        timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
        maxBytes: 4 * 1024 * 1024,
        allowHosts: [host],
      });
      if (response.status === 401 || response.status === 403) {
        context.logger.warn('The custom API rejected the stored credentials');
        return;
      }
      if (response.status !== 200) return;
      payload = response.json();
    } catch (error) {
      context.logger.warn('The custom API could not be reached', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }

    const items = resolvePath(payload, context.config['itemsPath'] ?? '');
    if (!Array.isArray(items)) {
      context.logger.warn('The configured items path did not resolve to a list');
      return;
    }

    const declared = normaliseClassification(context.config['accessClassification']);
    let emitted = 0;

    for (const item of items.slice(0, MAX_ITEMS)) {
      if (signal.aborted || emitted >= context.maxCandidates) return;

      const title = asString(resolvePath(item, context.config['titlePath'] ?? ''));
      const mediaUrl = asString(resolvePath(item, context.config['mediaUrlPath'] ?? ''));
      if (!title) continue;

      const pick = (key: string): string | null => {
        const path = context.config[key];
        return path ? asString(resolvePath(item, path)) : null;
      };

      yield buildCandidate({
        providerId: this.id,
        providerDisplayName: context.config['displayName'] ?? this.displayName,
        category: 'organisation_repository',
        providerAssetId: pick('idPath') ?? mediaUrl ?? title,
        title,
        creator: pick('creatorPath'),
        filename: pick('filenamePath'),
        mediaUrl,
        pageUrl: pick('pageUrlPath'),
        publishedAt: pick('publishedAtPath'),
        artworkUrl: pick('artworkPath'),
        attribution: context.config['displayName'] ?? null,
        declaredAccess: mediaUrl ? declared : 'metadata_only',
        claimed: {
          durationSeconds: parseDuration(pick('durationPath')),
          sizeBytes: parseSize(pick('sizePath')),
          bitrateBps: normaliseBitrate(pick('bitratePath')),
          mimeType: pick('mimeTypePath'),
        },
        extras: { apiHost: host },
      });
      emitted += 1;
    }
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const missing = CUSTOM_API_REQUIRED_CONFIG.filter((key) => !context.config[key]);
    if (missing.length > 0) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: `Configure this API to search it. Missing: ${missing.join(', ')}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/custom-json-api.md',
      };
    }

    const startedAt = context.now();
    const url = expandTemplate(context.config['urlTemplate'] ?? '', {
      query: 'test',
      limit: '1',
      locale: 'en',
    });

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      const authName = context.config['authHeaderName'];
      const authValue = context.config['authHeaderValue'];
      if (authName && authValue) headers[authName.toLowerCase()] = authValue;

      const response = await context.fetch(url, {
        headers,
        signal: context.signal,
        timeoutMs: 6_000,
        maxBytes: 512 * 1024,
        allowHosts: [new URL(url).hostname],
      });

      if (response.status === 200) {
        const items = resolvePath(response.json(), context.config['itemsPath'] ?? '');
        return {
          providerId: this.id,
          status: Array.isArray(items) ? 'ready' : 'degraded',
          message: Array.isArray(items)
            ? 'Connected and the item path resolved correctly.'
            : 'Connected, but the configured items path did not resolve to a list.',
          checkedAt: new Date().toISOString(),
          latencyMs: context.now() - startedAt,
          setupDocPath: 'docs/providers/custom-json-api.md',
        };
      }
      return {
        providerId: this.id,
        status: response.status === 401 || response.status === 403 ? 'auth_required' : 'degraded',
        message:
          response.status === 401 || response.status === 403
            ? 'The stored credentials were rejected.'
            : `The API responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/custom-json-api.md',
      };
    } catch {
      return {
        providerId: this.id,
        status: 'unavailable',
        message: 'The API could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/custom-json-api.md',
      };
    }
  }
}

function normaliseClassification(value: string | undefined): RawSearchCandidate['declaredAccess'] {
  switch (value) {
    case 'direct_download':
      return 'direct_download';
    case 'source_download':
      return 'source_download';
    case 'preview_only':
      return 'preview_only';
    case 'metadata_only':
      return 'metadata_only';
    default:
      // Anything unconfigured or unrecognised stays private-by-default.
      return 'connected_private';
  }
}

function normaliseBitrate(value: string | null): number | null {
  const parsed = parseSize(value);
  if (parsed === null) return null;
  // Accept either bits per second or kbps and normalise upward.
  return parsed < 10_000 ? parsed * 1000 : parsed;
}
