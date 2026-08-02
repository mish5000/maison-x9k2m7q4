import { AuralisError } from '../domain/errors.js';
import {
  EMPTY_TAGS,
  EMPTY_TECHNICAL,
  UNVERIFIED,
  type MediaTags,
  type MediaTechnicalMetadata,
  type VerificationRecord,
} from '../domain/media.js';
import type { SafeFetchFn, SafeFetchResponse } from '../domain/provider.js';
import { detectPlaylistFormat } from '../media/playlist.js';
import { probeMedia } from '../media/probe.js';
import { extensionFromPath } from '../media/signatures.js';
import { UnsafeUrlError } from '../net/url-safety.js';

/**
 * Candidate verification: the network half of media validation.
 *
 * The rule is that identifying a file must never require downloading it. A
 * HEAD request plus at most two small range requests is always enough for the
 * formats Auralis supports, and the byte caps here are what make that true even
 * when a server lies about Content-Length or streams forever.
 */

export const HEAD_SAMPLE_BYTES = 64 * 1024;
export const TAIL_SAMPLE_BYTES = 32 * 1024;

export interface VerifyOptions {
  readonly fetch: SafeFetchFn;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Skip the tail probe in modes that trade completeness for speed. */
  readonly fetchTail: boolean;
  readonly maxHeadBytes?: number;
  readonly maxTailBytes?: number;
}

export interface VerifyResult {
  readonly verification: VerificationRecord;
  readonly technical: MediaTechnicalMetadata;
  readonly tags: MediaTags;
  /** Head bytes retained for fingerprinting. Never persisted. */
  readonly headSample: Uint8Array | null;
  /** Set when the URL turned out to be a playlist rather than a media file. */
  readonly playlist: { readonly format: string; readonly text: string } | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failure(
  status: VerificationRecord['status'],
  evidence: readonly string[],
  partial?: Partial<VerificationRecord>,
): VerifyResult {
  return {
    verification: {
      ...UNVERIFIED,
      status,
      evidence,
      checkedAt: nowIso(),
      ...partial,
    },
    technical: EMPTY_TECHNICAL,
    tags: EMPTY_TAGS,
    headSample: null,
    playlist: null,
  };
}

function headerNumber(response: SafeFetchResponse, name: string): number | null {
  const raw = response.headers[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parses `bytes 0-1023/45678` and returns the total size. */
function totalFromContentRange(value: string | undefined): number | null {
  if (!value) return null;
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(value);
  if (!match?.[1]) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export async function verifyCandidate(url: string, options: VerifyOptions): Promise<VerifyResult> {
  const startedAt = Date.now();
  const evidence: string[] = [];
  const maxHead = options.maxHeadBytes ?? HEAD_SAMPLE_BYTES;
  const maxTail = options.maxTailBytes ?? TAIL_SAMPLE_BYTES;

  const remaining = (): number => Math.max(0, options.timeoutMs - (Date.now() - startedAt));

  let declaredSize: number | null = null;
  let declaredMime: string | null = null;
  let acceptsRanges = false;
  let finalUrl = url;
  let finalHost: string | null = null;
  let redirectCount = 0;
  let bytesInspected = 0;

  // Step 1 — HEAD. Cheap, and many sources answer it honestly. A source that
  // rejects HEAD is not penalised; the range probe covers the same ground.
  try {
    const head = await options.fetch(url, {
      method: 'HEAD',
      signal: options.signal,
      timeoutMs: Math.min(remaining(), 5_000),
    });
    finalUrl = head.finalUrl;
    finalHost = head.finalHost;
    redirectCount = head.redirectCount;
    if (head.status >= 200 && head.status < 300) {
      declaredSize = headerNumber(head, 'content-length');
      declaredMime = head.headers['content-type'] ?? null;
      acceptsRanges = (head.headers['accept-ranges'] ?? '').toLowerCase().includes('bytes');
      evidence.push(`head:${head.status}`);
      if (declaredMime) evidence.push(`head:content-type=${declaredMime.split(';')[0]}`);
      if (declaredSize !== null) evidence.push(`head:content-length=${declaredSize}`);
      if (acceptsRanges) evidence.push('head:accept-ranges=bytes');
    } else {
      evidence.push(`head:${head.status}-not-usable`);
    }
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return failure('verification_failed', [...evidence, `unsafe:${error.rule}`]);
    }
    if (error instanceof AuralisError && error.code === 'cancelled') throw error;
    evidence.push('head:unsupported');
  }

  if (options.signal.aborted) throw new AuralisError('cancelled', 'The search was cancelled.');
  if (remaining() <= 0) {
    return failure('verification_failed', [...evidence, 'probe:timeout-before-body'], {
      finalUrl,
      finalHost,
      redirectCount,
    });
  }

  // Step 2 — bounded range request for the head of the file.
  let headResponse: SafeFetchResponse;
  try {
    headResponse = await options.fetch(finalUrl, {
      method: 'GET',
      signal: options.signal,
      timeoutMs: remaining(),
      maxBytes: maxHead,
      range: { start: 0, end: maxHead - 1 },
    });
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return failure('verification_failed', [...evidence, `unsafe:${error.rule}`]);
    }
    if (error instanceof AuralisError && error.code === 'cancelled') throw error;
    return failure('verification_failed', [...evidence, 'probe:body-fetch-failed'], {
      finalUrl,
      finalHost,
      redirectCount,
    });
  }

  finalUrl = headResponse.finalUrl;
  finalHost = headResponse.finalHost;
  redirectCount = Math.max(redirectCount, headResponse.redirectCount);
  bytesInspected += headResponse.body.length;

  if (headResponse.status >= 400) {
    return failure('verification_failed', [...evidence, `body:${headResponse.status}`], {
      finalUrl,
      finalHost,
      redirectCount,
      bytesInspected,
    });
  }

  const servedPartial = headResponse.status === 206;
  if (servedPartial) {
    evidence.push('body:206-partial-content');
    acceptsRanges = true;
  } else {
    evidence.push(`body:${headResponse.status}`);
  }

  const rangeTotal = totalFromContentRange(headResponse.headers['content-range']);
  const bodyMime = headResponse.headers['content-type'] ?? declaredMime;
  const totalSizeBytes =
    rangeTotal ??
    declaredSize ??
    (!headResponse.truncated && !servedPartial ? headResponse.body.length : null);

  if (declaredSize !== null && rangeTotal !== null && declaredSize !== rangeTotal) {
    evidence.push('mismatch:content-length-vs-content-range');
  }

  // Step 3 — playlist detection before anything is treated as a media file.
  const extension = extensionFromPath(new URL(finalUrl).pathname);
  const asText = decodePrefixAsText(headResponse.body, 4096);
  const playlistFormat = detectPlaylistFormat(asText, extension);
  if (playlistFormat !== null && !looksBinary(headResponse.body)) {
    return {
      verification: {
        ...UNVERIFIED,
        status: 'playlist',
        evidence: [...evidence, `playlist:${playlistFormat}`],
        bytesInspected,
        checkedAt: nowIso(),
        finalHost,
        finalUrl,
        redirectCount,
        declaredMimeType: bodyMime,
        detectedSignature: playlistFormat,
        signatureAgreement: false,
      },
      technical: EMPTY_TECHNICAL,
      tags: EMPTY_TAGS,
      headSample: headResponse.body,
      playlist: { format: playlistFormat, text: asText },
    };
  }

  // Step 4 — tail sample, needed for exact Ogg duration, ID3v1 and trailing moov.
  let tailBytes: Uint8Array | null = null;
  if (
    options.fetchTail &&
    acceptsRanges &&
    totalSizeBytes !== null &&
    totalSizeBytes > maxHead + 1024 &&
    remaining() > 500 &&
    !options.signal.aborted
  ) {
    try {
      const start = Math.max(0, totalSizeBytes - maxTail);
      const tail = await options.fetch(finalUrl, {
        method: 'GET',
        signal: options.signal,
        timeoutMs: remaining(),
        maxBytes: maxTail,
        range: { start, end: totalSizeBytes - 1 },
      });
      if (tail.status === 206) {
        tailBytes = tail.body;
        bytesInspected += tail.body.length;
        evidence.push('probe:tail-sample-fetched');
      }
    } catch (error) {
      if (error instanceof AuralisError && error.code === 'cancelled') throw error;
      evidence.push('probe:tail-sample-unavailable');
    }
  }

  // Step 5 — pure, bounded parsing of the sampled bytes.
  const probe = probeMedia({
    head: headResponse.body,
    tail: tailBytes,
    totalSizeBytes,
    declaredMimeType: bodyMime,
    filenameOrPath: new URL(finalUrl).pathname,
  });

  const technical: MediaTechnicalMetadata = {
    ...probe.technical,
    sizeBytes: probe.technical.sizeBytes ?? totalSizeBytes,
  };

  return {
    verification: {
      status: probe.status,
      evidence: [...evidence, ...probe.evidence],
      bytesInspected,
      checkedAt: nowIso(),
      finalHost,
      finalUrl,
      redirectCount,
      declaredMimeType: bodyMime,
      detectedSignature: probe.signature?.signature ?? probe.nonAudio?.signature ?? null,
      signatureAgreement: probe.signatureAgreement,
    },
    technical,
    tags: probe.tags,
    headSample: headResponse.body,
    playlist: null,
  };
}

function decodePrefixAsText(bytes: Uint8Array, limit: number): string {
  const slice = bytes.subarray(0, Math.min(bytes.length, limit));
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

/** Heuristic: a high proportion of NUL/control bytes means this is not text. */
function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
  if (sample.length === 0) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.length > 0.1;
}
