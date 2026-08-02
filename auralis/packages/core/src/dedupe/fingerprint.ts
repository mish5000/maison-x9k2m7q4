import { createHash } from 'node:crypto';

import type { MediaTags, MediaTechnicalMetadata } from '../domain/media.js';
import { comparisonKey } from '../query/normalize.js';

/**
 * Progressive duplicate detection keys, cheapest first.
 *
 * Nothing here downloads a whole file. The strongest key Auralis computes by
 * default is derived from bytes it already fetched during verification.
 */

export type FingerprintLevel =
  | 'canonical_url'
  | 'final_url'
  | 'provider_asset'
  | 'content_hash'
  | 'partial_signature'
  | 'metadata_exact'
  | 'size_duration'
  | 'creator_title_duration'
  | 'filename';

export interface Fingerprint {
  readonly level: FingerprintLevel;
  readonly key: string;
  /** Higher means a stronger claim that two candidates are the same file. */
  readonly strength: number;
}

export const LEVEL_STRENGTH: Record<FingerprintLevel, number> = {
  content_hash: 100,
  final_url: 90,
  canonical_url: 85,
  provider_asset: 80,
  partial_signature: 70,
  metadata_exact: 60,
  size_duration: 50,
  creator_title_duration: 40,
  filename: 20,
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Strips volatile query parameters so mirrors of one file collapse together. */
export function canonicaliseUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const volatile = [
    'token',
    'signature',
    'sig',
    'expires',
    'x-amz-signature',
    'x-amz-date',
    'x-amz-credential',
    'x-amz-expires',
    'x-amz-security-token',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'ref',
    'source',
  ];
  for (const key of [...url.searchParams.keys()]) {
    if (volatile.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  // A trailing slash on a file path is never meaningful.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

export interface FingerprintInput {
  readonly providerId: string;
  readonly providerAssetId: string;
  readonly mediaUrl: string | null;
  readonly finalUrl: string | null;
  readonly title: string;
  readonly creator: string | null;
  readonly filename: string | null;
  readonly tags: MediaTags;
  readonly technical: MediaTechnicalMetadata;
  /** Bytes already fetched during verification, used for a partial signature. */
  readonly headSample: Uint8Array | null;
  /** Hash published by the source, when it provides one. */
  readonly publishedHash: string | null;
}

const DURATION_BUCKET_SECONDS = 2;

export function computeFingerprints(input: FingerprintInput): readonly Fingerprint[] {
  const prints: Fingerprint[] = [];

  const add = (level: FingerprintLevel, key: string | null): void => {
    if (!key) return;
    prints.push({ level, key: `${level}:${key}`, strength: LEVEL_STRENGTH[level] });
  };

  if (input.publishedHash) add('content_hash', input.publishedHash.toLowerCase());

  if (input.finalUrl) add('final_url', canonicaliseUrl(input.finalUrl));
  if (input.mediaUrl) add('canonical_url', canonicaliseUrl(input.mediaUrl));

  add('provider_asset', `${input.providerId}/${input.providerAssetId}`);

  if (input.headSample && input.headSample.length >= 4096) {
    // A hash of the first 4 KiB after any leading tag is stable across mirrors
    // that re-tag a file, and costs nothing extra: these bytes are already here.
    add('partial_signature', sha256(input.headSample.subarray(0, 4096)));
  }

  const duration = input.technical.durationSeconds;
  const size = input.technical.sizeBytes;

  const titleKey = comparisonKey(input.tags.title ?? input.title);
  const creatorKey = comparisonKey(input.tags.artist ?? input.creator ?? '');

  if (titleKey.length > 0 && creatorKey.length > 0 && duration !== null) {
    add(
      'metadata_exact',
      sha256(`${titleKey}|${creatorKey}|${bucketDuration(duration)}|${input.technical.format}`),
    );
  }

  if (size !== null && duration !== null && size > 0) {
    add('size_duration', sha256(`${size}|${bucketDuration(duration)}`));
  }

  if (titleKey.length > 0 && duration !== null) {
    add('creator_title_duration', sha256(`${creatorKey}|${titleKey}|${bucketDuration(duration)}`));
  }

  if (input.filename) {
    const base = input.filename.replace(/\.[a-z0-9]{1,5}$/i, '');
    const key = comparisonKey(base);
    if (key.length >= 6) add('filename', key);
  }

  return prints;
}

function bucketDuration(seconds: number): number {
  return Math.round(seconds / DURATION_BUCKET_SECONDS);
}
