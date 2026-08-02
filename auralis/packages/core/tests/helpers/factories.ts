import {
  EMPTY_TAGS,
  EMPTY_TECHNICAL,
  normalizeQuery,
  UNVERIFIED,
  type MediaTechnicalMetadata,
  type NormalizedSearchQuery,
  type SearchResult,
} from '../../src/index.js';

/** Builders for test data, so each test states only what it cares about. */

export function makeTechnical(overrides: Partial<MediaTechnicalMetadata>): MediaTechnicalMetadata {
  return {
    ...EMPTY_TECHNICAL,
    format: 'wav',
    codec: 'pcm_s16le',
    durationSeconds: 180,
    sampleRateHz: 44100,
    bitDepth: 16,
    channels: 2,
    channelLayout: 'stereo',
    sizeBytes: 31_752_044,
    lossless: true,
    confidence: 'high',
    ...overrides,
    bitrate: { ...EMPTY_TECHNICAL.bitrate, ...(overrides.bitrate ?? {}) },
    loudness: { ...EMPTY_TECHNICAL.loudness, ...(overrides.loudness ?? {}) },
  };
}

export function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  const technical = overrides.technical ?? makeTechnical({});
  return {
    id: 'res_1',
    searchId: 'srch_1',
    title: 'A Recording',
    creator: 'An Artist',
    filename: 'a-recording.wav',
    source: {
      providerId: 'internet-archive',
      providerDisplayName: 'Internet Archive',
      category: 'open_archive',
      sourceHost: 'archive.org',
      pageUrl: 'https://archive.org/details/item',
      collection: 'Test collection',
      attribution: 'An Artist via Internet Archive',
      rightsStatement: 'Public domain',
      publishedAt: '2020-01-01T00:00:00.000Z',
      artworkUrl: null,
    },
    pageUrl: 'https://archive.org/details/item',
    mediaUrl: 'https://archive.org/download/item/a-recording.wav',
    technical,
    tags: EMPTY_TAGS,
    claimed: {
      format: null,
      mimeType: null,
      sizeBytes: null,
      durationSeconds: null,
      bitrateBps: null,
      sampleRateHz: null,
      channels: null,
    },
    verification: { ...UNVERIFIED, status: 'verified_audio', signatureAgreement: true },
    access: {
      classification: 'direct_download',
      actions: ['preview', 'download', 'copy_direct_url', 'inspect_metadata'],
      reason: 'This source publishes the file directly.',
      evidence: [],
    },
    compatibility: [],
    quality: { total: 0.9, breakdown: [], warnings: [] },
    ranking: {
      total: 0.8,
      relevance: 0.8,
      quality: 0.9,
      accessCertainty: 1,
      breakdown: [],
      explanation: [],
    },
    badges: ['verified_audio'],
    duplicateGroupId: null,
    duplicateCount: 0,
    variants: [],
    discoveredAt: '2026-01-01T00:00:00.000Z',
    previewUrl: null,
    providerExtras: {},
    ...overrides,
  };
}

/** A leader/variant pair plus a normalised query, used by several suites. */
export function buildCacheKeyFixtures(): {
  readonly leader: SearchResult;
  readonly variant: SearchResult;
  readonly query: NormalizedSearchQuery;
} {
  const leader = makeResult({
    id: 'res_leader',
    technical: makeTechnical({ format: 'flac', codec: 'flac', lossless: true }),
    quality: { total: 0.95, breakdown: [], warnings: [] },
    ranking: {
      total: 0.9,
      relevance: 0.9,
      quality: 0.95,
      accessCertainty: 1,
      breakdown: [],
      explanation: [],
    },
  });

  const variant = makeResult({
    id: 'res_variant',
    source: {
      ...leader.source,
      providerId: 'wikimedia-commons',
      providerDisplayName: 'Wikimedia Commons',
    },
    technical: makeTechnical({
      format: 'mp3',
      codec: 'mp3',
      lossless: false,
      bitDepth: null,
      sizeBytes: 4_000_000,
      bitrate: {
        nominalBps: 192_000,
        averageBps: 192_000,
        mode: 'cbr',
        estimated: false,
        confidence: 'high',
      },
    }),
    quality: { total: 0.7, breakdown: [], warnings: [] },
    ranking: {
      total: 0.6,
      relevance: 0.8,
      quality: 0.7,
      accessCertainty: 0.85,
      breakdown: [],
      explanation: [],
    },
    access: {
      classification: 'source_download',
      actions: ['download', 'inspect_metadata'],
      reason: 'Download runs through this source’s own download page.',
      evidence: [],
    },
  });

  return { leader, variant, query: normalizeQuery('a recording') };
}
