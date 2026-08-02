import { createHash, createHmac } from 'node:crypto';

import type { RawSearchCandidate } from '../domain/candidate.js';
import type {
  ProviderHealth,
  ProviderHealthContext,
  SearchContext,
  SearchProvider,
} from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { coverage } from '../scoring/relevance.js';
import { findChildren, parseXml, textOf } from '../util/xml.js';
import {
  buildCandidate,
  capabilities,
  isConfigured,
  looksLikeAudioFilename,
  msRemaining,
  parseSize,
} from './helpers.js';

/**
 * S3-compatible object storage connector (AWS S3, MinIO, Backblaze B2 S3,
 * Cloudflare R2, Wasabi, and others speaking the same API).
 *
 * Uses ListObjectsV2 with SigV4 request signing, and issues short-lived
 * presigned GET URLs for downloads so credentials never leave the server and
 * the object is never proxied through Auralis.
 *
 * Configuration (all required):
 *   endpoint        — e.g. https://s3.eu-west-1.amazonaws.com
 *   region          — e.g. eu-west-1
 *   bucket          — bucket name
 *   accessKeyId     — secret, encrypted at rest
 *   secretAccessKey — secret, encrypted at rest
 * Optional:
 *   prefix          — restrict the search to a key prefix
 *   pathStyle       — "true" to force path-style addressing (MinIO default)
 */

export const S3_REQUIRED_CONFIG = [
  'endpoint',
  'region',
  'bucket',
  'accessKeyId',
  'secretAccessKey',
] as const;
export const S3_SECRET_CONFIG_KEYS = ['accessKeyId', 'secretAccessKey'] as const;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const MAX_KEYS = 1000;

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

/** RFC 3986 encoding; S3 requires `/` to stay unescaped in the canonical path. */
export function uriEncode(value: string, encodeSlash: boolean): string {
  return value
    .split('')
    .map((character) => {
      if (/[A-Za-z0-9_.~-]/.test(character)) return character;
      if (character === '/') return encodeSlash ? '%2F' : '/';
      return Array.from(new TextEncoder().encode(character))
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    })
    .join('');
}

export function amzDate(now: Date): { readonly full: string; readonly short: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full, short: full.slice(0, 8) };
}

function signingKey(secret: string, short: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, short), region), service), 'aws4_request');
}

export interface S3SignInput {
  readonly method: string;
  readonly url: URL;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
  readonly service?: string;
}

/** Signs a request with SigV4 using headers (used for ListObjectsV2). */
export function signS3Request(input: S3SignInput): Record<string, string> {
  const service = input.service ?? 's3';
  const { full, short } = amzDate(input.now);
  const host = input.url.host;

  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    input.method,
    uriEncode(input.url.pathname, false),
    canonicalQuery,
    `host:${host}\nx-amz-content-sha256:${UNSIGNED_PAYLOAD}\nx-amz-date:${full}\n`,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const credentialScope = `${short}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, full, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.secretAccessKey, short, input.region, service),
  )
    .update(stringToSign)
    .digest('hex');

  return {
    'x-amz-date': full,
    'x-amz-content-sha256': UNSIGNED_PAYLOAD,
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface PresignInput extends S3SignInput {
  readonly expiresInSeconds: number;
}

/** Builds a presigned GET URL. The URL is short-lived and never cached. */
export function presignS3Url(input: PresignInput): string {
  const service = input.service ?? 's3';
  const { full, short } = amzDate(input.now);
  const url = new URL(input.url.toString());
  const credentialScope = `${short}/${input.region}/${service}/aws4_request`;

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  url.searchParams.set('X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`);
  url.searchParams.set('X-Amz-Date', full);
  url.searchParams.set('X-Amz-Expires', String(input.expiresInSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');

  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    uriEncode(url.pathname, false),
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, full, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.secretAccessKey, short, input.region, service),
  )
    .update(stringToSign)
    .digest('hex');

  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

export interface S3Object {
  readonly key: string;
  readonly sizeBytes: number | null;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export function parseListObjectsResponse(xml: string): {
  readonly objects: readonly S3Object[];
  readonly nextToken: string | null;
} {
  const document = parseXml(xml);
  const contents = document ? findChildren(document.children[0] ?? null, 'Contents') : [];
  const objects: S3Object[] = [];

  for (const node of contents) {
    const key = textOf(findChildren(node, 'Key')[0] ?? null);
    if (!key) continue;
    objects.push({
      key,
      sizeBytes: parseSize(textOf(findChildren(node, 'Size')[0] ?? null)),
      lastModified: textOf(findChildren(node, 'LastModified')[0] ?? null),
      etag: textOf(findChildren(node, 'ETag')[0] ?? null)?.replace(/"/g, '') ?? null,
    });
  }

  const nextToken = document
    ? textOf(findChildren(document.children[0] ?? null, 'NextContinuationToken')[0] ?? null)
    : null;

  return { objects, nextToken };
}

export function objectUrlFor(
  endpoint: string,
  bucket: string,
  key: string,
  pathStyle: boolean,
): URL {
  const base = new URL(endpoint);
  if (pathStyle) {
    base.pathname = `/${bucket}/${key
      .split('/')
      .map((part) => uriEncode(part, true))
      .join('/')}`;
  } else {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `/${key
      .split('/')
      .map((part) => uriEncode(part, true))
      .join('/')}`;
  }
  return base;
}

export class S3CompatibleProvider implements SearchProvider {
  readonly id = 's3-compatible';
  readonly displayName = 'S3-compatible storage';
  readonly capabilities = capabilities({
    supportsTextSearch: true,
    returnsDirectMediaUrls: false,
    supportsPreview: true,
    supportsServerSideSearch: false,
    requiresAuthentication: true,
    rateLimit: { kind: 'token_bucket', capacity: 10, refillPerSec: 5 },
    robotsPosture: 'not_applicable',
    timeoutMs: 15_000,
    exposesFileSize: true,
    supportsPagination: true,
    supportsIncrementalStreaming: true,
    maxConcurrentRequests: 2,
    sourceCategory: 'connected_storage',
    modes: ['connected'],
    producesPrivateResults: true,
    requiredConfiguration: [...S3_REQUIRED_CONFIG],
  });

  async *search(
    query: NormalizedSearchQuery,
    context: SearchContext,
    signal: AbortSignal,
  ): AsyncIterable<RawSearchCandidate> {
    if (!isConfigured(context, S3_REQUIRED_CONFIG)) return;

    const endpoint = context.config['endpoint'] ?? '';
    const region = context.config['region'] ?? '';
    const bucket = context.config['bucket'] ?? '';
    const accessKeyId = context.config['accessKeyId'] ?? '';
    const secretAccessKey = context.config['secretAccessKey'] ?? '';
    const prefix = context.config['prefix'] ?? '';
    const pathStyle = (context.config['pathStyle'] ?? '').toLowerCase() === 'true';

    const searchText = query.variants[0]?.text ?? query.normalized;
    let continuationToken: string | null = null;
    let emitted = 0;
    let pages = 0;

    do {
      if (signal.aborted || emitted >= context.maxCandidates || msRemaining(context) <= 0) return;

      const listUrl = pathStyle
        ? new URL(`/${bucket}`, endpoint)
        : (() => {
            const url = new URL(endpoint);
            url.hostname = `${bucket}.${url.hostname}`;
            url.pathname = '/';
            return url;
          })();

      listUrl.searchParams.set('list-type', '2');
      listUrl.searchParams.set('max-keys', String(MAX_KEYS));
      if (prefix) listUrl.searchParams.set('prefix', prefix);
      if (continuationToken) listUrl.searchParams.set('continuation-token', continuationToken);

      const headers = signS3Request({
        method: 'GET',
        url: listUrl,
        region,
        accessKeyId,
        secretAccessKey,
        now: new Date(context.now()),
      });

      let body: string;
      try {
        const response = await context.fetch(listUrl.toString(), {
          method: 'GET',
          headers,
          signal,
          timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
          maxBytes: 4 * 1024 * 1024,
          allowHosts: [listUrl.hostname],
        });
        if (response.status === 403 || response.status === 401) {
          context.logger.warn('S3 connector rejected the stored credentials');
          return;
        }
        if (response.status !== 200) return;
        body = response.text();
      } catch (error) {
        context.logger.warn('S3 connector could not list the bucket', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        return;
      }

      const { objects, nextToken } = parseListObjectsResponse(body);
      continuationToken = nextToken;
      pages += 1;

      for (const object of objects) {
        if (emitted >= context.maxCandidates) return;
        const name = object.key.substring(object.key.lastIndexOf('/') + 1);
        if (!looksLikeAudioFilename(name)) continue;
        if (coverage(searchText, object.key.replace(/\//g, ' ')) < 0.34) continue;

        yield buildCandidate({
          providerId: this.id,
          providerDisplayName: context.config['displayName'] ?? this.displayName,
          category: 'connected_storage',
          providerAssetId: `${bucket}/${object.key}`,
          title: name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' '),
          filename: name,
          // The media URL is minted at download time as a short-lived presigned
          // URL; it is never emitted during search.
          mediaUrl: null,
          pageUrl: null,
          collection: object.key.includes('/')
            ? object.key.slice(0, object.key.lastIndexOf('/'))
            : bucket,
          publishedAt: object.lastModified,
          declaredAccess: 'connected_private',
          claimed: { sizeBytes: object.sizeBytes },
          extras: { bucket, objectKey: object.key, etag: object.etag },
        });
        emitted += 1;
      }
    } while (continuationToken !== null && pages < (context.mode === 'deep' ? 5 : 2));
  }

  async healthCheck(context: ProviderHealthContext): Promise<ProviderHealth> {
    const missing = S3_REQUIRED_CONFIG.filter((key) => !context.config[key]);
    if (missing.length > 0) {
      return {
        providerId: this.id,
        status: 'not_configured',
        message: `Connect an S3-compatible bucket to search it. Missing: ${missing.join(', ')}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/s3-compatible.md',
      };
    }

    const startedAt = context.now();
    try {
      const endpoint = context.config['endpoint'] ?? '';
      const bucket = context.config['bucket'] ?? '';
      const pathStyle = (context.config['pathStyle'] ?? '').toLowerCase() === 'true';
      const url = pathStyle
        ? new URL(`/${bucket}`, endpoint)
        : (() => {
            const u = new URL(endpoint);
            u.hostname = `${bucket}.${u.hostname}`;
            return u;
          })();
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '1');

      const headers = signS3Request({
        method: 'GET',
        url,
        region: context.config['region'] ?? '',
        accessKeyId: context.config['accessKeyId'] ?? '',
        secretAccessKey: context.config['secretAccessKey'] ?? '',
        now: new Date(context.now()),
      });

      const response = await context.fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: context.signal,
        timeoutMs: 6_000,
        maxBytes: 256 * 1024,
        allowHosts: [url.hostname],
      });

      if (response.status === 200) {
        return {
          providerId: this.id,
          status: 'ready',
          message: `Connected to bucket ${bucket}.`,
          checkedAt: new Date().toISOString(),
          latencyMs: context.now() - startedAt,
          setupDocPath: 'docs/providers/s3-compatible.md',
        };
      }
      return {
        providerId: this.id,
        status: response.status === 403 || response.status === 401 ? 'auth_required' : 'degraded',
        message:
          response.status === 403 || response.status === 401
            ? 'The stored credentials were rejected. Reconnect this bucket.'
            : `The storage endpoint responded with status ${response.status}.`,
        checkedAt: new Date().toISOString(),
        latencyMs: context.now() - startedAt,
        setupDocPath: 'docs/providers/s3-compatible.md',
      };
    } catch {
      return {
        providerId: this.id,
        status: 'unavailable',
        message: 'The storage endpoint could not be reached.',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        setupDocPath: 'docs/providers/s3-compatible.md',
      };
    }
  }
}
