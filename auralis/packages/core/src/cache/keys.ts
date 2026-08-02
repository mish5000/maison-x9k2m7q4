import { createHash } from 'node:crypto';

import type { NormalizedSearchQuery } from '../domain/query.js';

/**
 * Cache key construction.
 *
 * SECURITY INVARIANT: a key is either `shared:` or `ws:<workspaceId>:`. Private
 * providers can only ever produce workspace-scoped keys, and `buildProviderKey`
 * throws if asked to do otherwise. This is what stops one tenant's connector
 * results being served to another.
 */

export const CACHE_SCHEMA_VERSION = 1;

export class CacheScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheScopeViolationError';
  }
}

export interface ProviderKeyInput {
  readonly providerId: string;
  readonly query: NormalizedSearchQuery;
  readonly workspaceId: string;
  /** True when this provider's results are private to the workspace. */
  readonly producesPrivateResults: boolean;
  /** Stable identifier of the credential set in use, if any. */
  readonly credentialFingerprint: string | null;
}

function digest(parts: readonly (string | number | boolean | null)[]): string {
  return createHash('sha256')
    .update(parts.map((p) => String(p)).join(''))
    .digest('hex')
    .slice(0, 32);
}

function filterSignature(query: NormalizedSearchQuery): string {
  const { filters } = query;
  return digest([
    filters.formats.join(','),
    filters.extensions.join(','),
    filters.minBitrateBps,
    filters.duration.min,
    filters.duration.max,
    filters.accessTypes.join(','),
    filters.providerIds.join(','),
    filters.losslessOnly,
  ]);
}

export function buildProviderKey(input: ProviderKeyInput): string {
  const body = digest([
    CACHE_SCHEMA_VERSION,
    input.providerId,
    input.query.normalized,
    input.query.phrases.join('|'),
    input.query.excluded.join('|'),
    input.query.mode,
    input.query.locale,
    filterSignature(input.query),
    input.credentialFingerprint,
  ]);

  if (input.producesPrivateResults || input.credentialFingerprint !== null) {
    if (!input.workspaceId) {
      throw new CacheScopeViolationError(
        `Provider ${input.providerId} produces private results but no workspace was supplied`,
      );
    }
    return `ws:${input.workspaceId}:provider:${input.providerId}:${body}`;
  }

  return `shared:provider:${input.providerId}:${body}`;
}

/** Technical metadata is a property of the bytes, so it is safe to share — */
/** but only for public sources. Private assets get a workspace-scoped key. */
export function buildTechnicalKey(
  canonicalUrl: string,
  isPrivate: boolean,
  workspaceId: string | null,
): string {
  const body = digest([CACHE_SCHEMA_VERSION, canonicalUrl]);
  if (isPrivate) {
    if (!workspaceId) {
      throw new CacheScopeViolationError('Private asset metadata requires a workspace scope');
    }
    return `ws:${workspaceId}:technical:${body}`;
  }
  return `shared:technical:${body}`;
}

export function buildHealthKey(providerId: string, workspaceId: string | null): string {
  return workspaceId ? `ws:${workspaceId}:health:${providerId}` : `shared:health:${providerId}`;
}

export function buildCompatibilityKey(
  technicalDigest: string,
  profileId: string,
  profileVersion: string,
): string {
  return `shared:compat:${profileId}:${profileVersion}:${technicalDigest}`;
}

export function workspacePrefix(workspaceId: string): string {
  return `ws:${workspaceId}:`;
}

export function connectorPrefix(workspaceId: string, providerId: string): string {
  return `ws:${workspaceId}:provider:${providerId}:`;
}

/** True when a key may be served to any workspace. */
export function isSharedKey(key: string): boolean {
  return key.startsWith('shared:');
}

/**
 * A signed URL must not be cached beyond its own validity. Returns the TTL to
 * use, clamped to the URL's expiry when one is embedded.
 */
export function ttlForUrl(rawUrl: string, requestedTtlMs: number, now: number): number {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return requestedTtlMs;
  }

  const expiresParam =
    url.searchParams.get('Expires') ??
    url.searchParams.get('expires') ??
    url.searchParams.get('X-Amz-Expires');
  const dateParam = url.searchParams.get('X-Amz-Date');

  if (expiresParam !== null) {
    const value = Number(expiresParam);
    if (Number.isFinite(value) && value > 0) {
      // X-Amz-Expires is a duration in seconds from X-Amz-Date; a bare
      // `Expires` is an absolute epoch second.
      const absoluteMs =
        url.searchParams.has('X-Amz-Expires') && dateParam
          ? parseAmzDate(dateParam) + value * 1000
          : value * 1000;
      const remaining = absoluteMs - now;
      if (remaining <= 0) return 0;
      return Math.min(requestedTtlMs, remaining);
    }
  }

  // Any URL that looks signed is treated as short-lived even without an expiry.
  if (url.searchParams.has('X-Amz-Signature') || url.searchParams.has('Signature')) {
    return Math.min(requestedTtlMs, 60_000);
  }

  return requestedTtlMs;
}

function parseAmzDate(value: string): number {
  // Format: 20240131T101500Z
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
