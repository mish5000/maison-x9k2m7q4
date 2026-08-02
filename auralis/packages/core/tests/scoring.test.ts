import { describe, expect, it } from 'vitest';

import { buildCacheKeyFixtures, makeTechnical } from './helpers/factories.js';
import {
  buildCompatibilityKey,
  buildProviderKey,
  buildTechnicalKey,
  CacheScopeViolationError,
  CACHE_TTL_MS,
  canonicaliseUrl,
  computeFingerprints,
  contentDispositionAttachment,
  DuplicateIndex,
  describeDifferences,
  evaluateCompatibility,
  evaluateDefaultProfiles,
  isSharedKey,
  MemoryCacheStore,
  profileById,
  sanitiseFilename,
  scoreQuality,
  ttlForUrl,
  UNVERIFIED,
  type VerificationRecord,
} from '../src/index.js';

const verified: VerificationRecord = {
  ...UNVERIFIED,
  status: 'verified_audio',
  signatureAgreement: true,
};

describe('device compatibility', () => {
  const cdj = profileById('cdj-3000');

  it('accepts a standard 44.1 kHz 16-bit stereo WAV', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'wav',
        codec: 'pcm_s16le',
        lossless: true,
        bitDepth: 16,
        confidence: 'high',
      }),
      cdj!,
    );
    expect(assessment.verdict).toBe('compatible');
    expect(assessment.profileVersion).toBe('2024.1');
  });

  it('rejects a format the device does not list', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({ format: 'opus', codec: 'opus', confidence: 'high' }),
      cdj!,
    );
    expect(assessment.verdict).toBe('incompatible');
    expect(assessment.firedRules).toContain('format:not-supported');
  });

  it('recommends transcoding for an out-of-range sample rate', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'wav',
        codec: 'pcm_s16le',
        lossless: true,
        bitDepth: 16,
        sampleRateHz: 192_000,
        confidence: 'high',
      }),
      cdj!,
    );
    expect(assessment.verdict).toBe('transcoding_recommended');
    expect(assessment.firedRules).toContain('sample-rate:out-of-range');
  });

  it('recommends transcoding above the lossy bitrate ceiling', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'mp3',
        codec: 'mp3',
        lossless: false,
        bitrate: {
          nominalBps: 512_000,
          averageBps: 512_000,
          mode: 'cbr',
          estimated: false,
          confidence: 'high',
        },
        confidence: 'high',
      }),
      cdj!,
    );
    expect(assessment.verdict).toBe('transcoding_recommended');
    expect(assessment.firedRules).toContain('bitrate:above-maximum');
  });

  it('does not apply a lossy bitrate ceiling to a lossless file', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'flac',
        codec: 'flac',
        lossless: true,
        bitDepth: 24,
        sampleRateHz: 96_000,
        bitrate: {
          nominalBps: null,
          averageBps: 4_000_000,
          mode: 'lossless',
          estimated: true,
          confidence: 'high',
        },
        confidence: 'high',
      }),
      cdj!,
    );
    expect(assessment.firedRules).not.toContain('bitrate:above-maximum');
    expect(assessment.verdict).toBe('compatible');
  });

  it('returns unknown rather than guessing when facts are missing', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'unknown',
        codec: 'unknown',
        sampleRateHz: null,
        channels: null,
        confidence: 'none',
      }),
      cdj!,
    );
    expect(assessment.verdict).toBe('unknown');
  });

  it('never returns plain "compatible" on low-confidence metadata', () => {
    const assessment = evaluateCompatibility(
      makeTechnical({
        format: 'wav',
        codec: 'pcm_s16le',
        lossless: true,
        bitDepth: 16,
        confidence: 'medium',
      }),
      cdj!,
    );
    expect(assessment.verdict).toBe('probably_compatible');
  });

  it('evaluates the requested profiles only', () => {
    const assessments = evaluateDefaultProfiles(makeTechnical({}), ['cdj-3000']);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.profileId).toBe('cdj-3000');
  });
});

describe('quality scoring', () => {
  it('scores a verified lossless file above a low-bitrate lossy one', () => {
    const lossless = scoreQuality({
      technical: makeTechnical({
        format: 'flac',
        codec: 'flac',
        lossless: true,
        bitDepth: 16,
        confidence: 'high',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    const lossy = scoreQuality({
      technical: makeTechnical({
        format: 'mp3',
        codec: 'mp3',
        lossless: false,
        bitrate: {
          nominalBps: 96_000,
          averageBps: 96_000,
          mode: 'cbr',
          estimated: false,
          confidence: 'high',
        },
        confidence: 'high',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    expect(lossless.total).toBeGreaterThan(lossy.total);
  });

  it('never scores a high-bitrate transcode as high as a lossless original', () => {
    const transcode = scoreQuality({
      technical: makeTechnical({
        format: 'mp3',
        codec: 'mp3',
        lossless: false,
        bitrate: {
          nominalBps: 320_000,
          averageBps: 320_000,
          mode: 'cbr',
          estimated: false,
          confidence: 'high',
        },
        confidence: 'high',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    const original = scoreQuality({
      technical: makeTechnical({
        format: 'flac',
        codec: 'flac',
        lossless: true,
        bitDepth: 16,
        confidence: 'high',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    expect(transcode.total).toBeLessThan(original.total);
  });

  it('warns when the bitrate was estimated rather than measured', () => {
    const score = scoreQuality({
      technical: makeTechnical({
        format: 'mp3',
        codec: 'mp3',
        lossless: false,
        bitrate: {
          nominalBps: null,
          averageBps: 200_000,
          mode: 'vbr',
          estimated: true,
          confidence: 'medium',
        },
        confidence: 'medium',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    expect(score.warnings.some((warning) => /estimated/i.test(warning))).toBe(true);
  });

  it('penalises corruption signals and a size that disagrees with the source', () => {
    const clean = scoreQuality({
      technical: makeTechnical({ sizeBytes: 1000, confidence: 'high' }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: 1000,
    });
    const damaged = scoreQuality({
      technical: makeTechnical({
        sizeBytes: 1000,
        corruptionSignals: ['wav:invalid-sample-rate'],
        confidence: 'high',
      }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: 5000,
    });
    expect(damaged.total).toBeLessThan(clean.total);
    expect(damaged.warnings.length).toBeGreaterThan(clean.warnings.length);
  });

  it('publishes a breakdown that sums to the total', () => {
    const score = scoreQuality({
      technical: makeTechnical({ confidence: 'high' }),
      verification: verified,
      sourceCategory: 'open_archive',
      claimedSizeBytes: null,
    });
    const sum = score.breakdown.reduce((total, entry) => total + entry.contribution, 0);
    expect(Math.abs(sum - score.total)).toBeLessThan(0.02);
  });
});

describe('deduplication', () => {
  it('canonicalises URLs by removing volatile parameters', () => {
    expect(canonicaliseUrl('https://cdn.example.com/a.mp3?token=abc&utm_source=x')).toBe(
      'https://cdn.example.com/a.mp3',
    );
    expect(canonicaliseUrl('https://cdn.example.com/a.mp3#frag')).toBe(
      'https://cdn.example.com/a.mp3',
    );
    expect(canonicaliseUrl('not a url')).toBeNull();
  });

  it('produces fingerprints ordered by strength', () => {
    const prints = computeFingerprints({
      providerId: 'p',
      providerAssetId: 'a1',
      mediaUrl: 'https://example.com/a.mp3',
      finalUrl: 'https://cdn.example.com/a.mp3',
      title: 'Track',
      creator: 'Artist',
      filename: 'track.mp3',
      tags: {
        title: 'Track',
        artist: 'Artist',
        album: null,
        albumArtist: null,
        trackNumber: null,
        year: null,
        genre: null,
        comment: null,
      },
      technical: makeTechnical({ durationSeconds: 180, sizeBytes: 5_000_000 }),
      headSample: null,
      publishedHash: 'abc123',
    });
    const levels = prints.map((print) => print.level);
    expect(levels).toContain('content_hash');
    expect(levels).toContain('final_url');
    expect(levels).toContain('provider_asset');
    expect(prints[0]?.strength).toBeGreaterThanOrEqual(prints[prints.length - 1]?.strength ?? 0);
  });

  it('describes what actually differs between two copies', () => {
    const { leader, variant } = buildCacheKeyFixtures();
    const differences = describeDifferences(leader, variant);
    expect(differences.join(' ')).toMatch(/MP3|kbps|from /);
  });

  it('groups copies of one file and keeps a single leader', () => {
    const index = new DuplicateIndex();
    const { leader, variant } = buildCacheKeyFixtures();

    const first = index.add(leader, {
      providerId: 'a',
      providerAssetId: 'x',
      mediaUrl: 'https://example.com/x.flac',
      finalUrl: 'https://example.com/x.flac',
      title: leader.title,
      creator: leader.creator,
      filename: 'x.flac',
      tags: leader.tags,
      technical: leader.technical,
      headSample: null,
      publishedHash: 'same-hash',
    });
    expect(first.isNewGroup).toBe(true);

    const second = index.add(variant, {
      providerId: 'b',
      providerAssetId: 'y',
      mediaUrl: 'https://mirror.example.com/y.mp3',
      finalUrl: 'https://mirror.example.com/y.mp3',
      title: variant.title,
      creator: variant.creator,
      filename: 'y.mp3',
      tags: variant.tags,
      technical: variant.technical,
      headSample: null,
      publishedHash: 'same-hash',
    });
    expect(second.isNewGroup).toBe(false);
    expect(second.group.members).toHaveLength(2);
    // The better copy leads, whichever order they arrived in.
    expect(second.group.leaderId).toBe(leader.id);
  });
});

describe('filename sanitisation', () => {
  it('strips path components and traversal attempts', () => {
    expect(sanitiseFilename('../../etc/passwd', 'mp3').filename).toBe('passwd.mp3');
    expect(sanitiseFilename('..\\..\\windows\\system32\\evil', 'mp3').filename).toBe('evil.mp3');
    expect(sanitiseFilename('/absolute/path/song.mp3', null).filename).toBe('song.mp3');
  });

  it('removes characters that would break a Content-Disposition header', () => {
    const result = sanitiseFilename('evil"; filename="owned.exe', 'mp3');
    expect(result.filename).not.toContain('"');
    expect(result.filename).not.toContain(';');
    expect(contentDispositionAttachment(result)).not.toContain('owned.exe"');
  });

  it('refuses to produce an executable extension', () => {
    expect(sanitiseFilename('malware.exe', 'mp3').filename).toBe('malware.mp3');
    expect(sanitiseFilename('script.sh', null).filename).toBe('script');
    expect(sanitiseFilename('page.html', 'mp3').filename).toBe('page.mp3');
  });

  it('replaces reserved device names', () => {
    expect(sanitiseFilename('CON', 'mp3').filename).toBe('audio.mp3');
    expect(sanitiseFilename('nul.mp3', 'mp3').filename).toBe('audio.mp3');
  });

  it('keeps unicode in the primary name and provides an ASCII fallback', () => {
    const result = sanitiseFilename('Jóga — Björk.flac', 'flac');
    expect(result.filename).toContain('Jóga');
    expect(result.asciiFilename).toMatch(/^[\x20-\x7e]+$/);
    const header = contentDispositionAttachment(result);
    expect(header).toContain("filename*=UTF-8''");
  });

  it('falls back to a safe default for an empty name', () => {
    expect(sanitiseFilename('', 'mp3').filename).toBe('audio.mp3');
    expect(sanitiseFilename('   ', null).filename).toBe('audio');
  });
});

describe('cache scoping', () => {
  const { query } = buildCacheKeyFixtures();

  it('keys public provider results in the shared scope', () => {
    const key = buildProviderKey({
      providerId: 'internet-archive',
      query,
      workspaceId: 'ws_1',
      producesPrivateResults: false,
      credentialFingerprint: null,
    });
    expect(isSharedKey(key)).toBe(true);
  });

  it('keys private provider results under the workspace', () => {
    const key = buildProviderKey({
      providerId: 's3-compatible',
      query,
      workspaceId: 'ws_1',
      producesPrivateResults: true,
      credentialFingerprint: 'fp1',
    });
    expect(key.startsWith('ws:ws_1:')).toBe(true);
    expect(isSharedKey(key)).toBe(false);
  });

  it('gives different workspaces different keys for the same query', () => {
    const base = {
      providerId: 's3-compatible',
      query,
      producesPrivateResults: true,
      credentialFingerprint: 'fp1',
    };
    expect(buildProviderKey({ ...base, workspaceId: 'ws_1' })).not.toBe(
      buildProviderKey({ ...base, workspaceId: 'ws_2' }),
    );
  });

  it('invalidates a workspace key when the credential changes', () => {
    const base = {
      providerId: 's3-compatible',
      query,
      workspaceId: 'ws_1',
      producesPrivateResults: true,
    };
    expect(buildProviderKey({ ...base, credentialFingerprint: 'fp1' })).not.toBe(
      buildProviderKey({ ...base, credentialFingerprint: 'fp2' }),
    );
  });

  it('refuses to build a private key without a workspace', () => {
    expect(() =>
      buildProviderKey({
        providerId: 's3-compatible',
        query,
        workspaceId: '',
        producesPrivateResults: true,
        credentialFingerprint: null,
      }),
    ).toThrow(CacheScopeViolationError);

    expect(() => buildTechnicalKey('https://x/y.mp3', true, null)).toThrow(
      CacheScopeViolationError,
    );
  });

  it('varies the key with filters and mode', () => {
    const other = { ...query, mode: 'deep' as const };
    expect(
      buildProviderKey({
        providerId: 'p',
        query,
        workspaceId: 'w',
        producesPrivateResults: false,
        credentialFingerprint: null,
      }),
    ).not.toBe(
      buildProviderKey({
        providerId: 'p',
        query: other,
        workspaceId: 'w',
        producesPrivateResults: false,
        credentialFingerprint: null,
      }),
    );
  });

  it('includes the profile version in a compatibility key', () => {
    expect(buildCompatibilityKey('abc', 'cdj-3000', '2024.1')).not.toBe(
      buildCompatibilityKey('abc', 'cdj-3000', '2025.1'),
    );
  });

  it('never caches a signed URL beyond its stated validity', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const expiring = `https://bucket.example.com/a.mp3?X-Amz-Date=20260101T120000Z&X-Amz-Expires=60&X-Amz-Signature=deadbeef`;
    expect(ttlForUrl(expiring, CACHE_TTL_MS.technicalMetadata, now)).toBe(60_000);

    const expired = `https://bucket.example.com/a.mp3?X-Amz-Date=20260101T100000Z&X-Amz-Expires=60&X-Amz-Signature=deadbeef`;
    expect(ttlForUrl(expired, CACHE_TTL_MS.technicalMetadata, now)).toBe(0);

    const unsigned = 'https://archive.org/download/item/a.mp3';
    expect(ttlForUrl(unsigned, 5_000, now)).toBe(5_000);
  });

  it('treats any signature-bearing URL as short-lived even without an expiry', () => {
    const now = Date.now();
    const signed = 'https://cdn.example.com/a.mp3?Signature=abc';
    expect(ttlForUrl(signed, 24 * 3600_000, now)).toBeLessThanOrEqual(60_000);
  });
});

describe('memory cache', () => {
  it('expires entries and reports statistics', async () => {
    let now = 1000;
    const cache = new MemoryCacheStore({ maxEntries: 3, now: () => now });

    await cache.set('a', { value: 1 }, 100);
    expect(await cache.get('a')).toEqual({ value: 1 });

    now += 200;
    expect(await cache.get('a')).toBeNull();
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('evicts the least recently used entry when full', async () => {
    const cache = new MemoryCacheStore({ maxEntries: 2 });
    await cache.set('a', 1, 10_000);
    await cache.set('b', 2, 10_000);
    await cache.get('a');
    await cache.set('c', 3, 10_000);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).toBe(1);
    expect(cache.stats().evictions).toBe(1);
  });

  it('removes every key under a prefix, which is how a disconnect is enforced', async () => {
    const cache = new MemoryCacheStore();
    await cache.set('ws:1:provider:s3:a', 1, 10_000);
    await cache.set('ws:1:provider:s3:b', 2, 10_000);
    await cache.set('shared:provider:ia:c', 3, 10_000);
    expect(await cache.deleteByPrefix('ws:1:provider:s3:')).toBe(2);
    expect(await cache.get('shared:provider:ia:c')).toBe(3);
  });
});
