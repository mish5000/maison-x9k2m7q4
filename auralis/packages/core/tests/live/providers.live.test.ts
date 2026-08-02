import { describe, expect, it } from 'vitest';

import {
  createDefaultRegistry,
  createSafeFetch,
  normalizeQuery,
  PRODUCTION_URL_POLICY,
  providerLogger,
  silentLogger,
  type RawSearchCandidate,
  type SearchContext,
  type SearchProvider,
} from '../../src/index.js';

/**
 * The opt-in live suite.
 *
 * These tests call real third-party services and are excluded from the default
 * run, because a public API being slow or down must never be able to fail this
 * project's build. Run them deliberately:
 *
 *   npm run test:live
 *
 * A failure here means "that source changed or is unavailable", which is
 * information about the world, not about the code.
 */

const enabled = process.env['AURALIS_LIVE_TESTS'] === '1';
const describeLive = enabled ? describe : describe.skip;

const policy = PRODUCTION_URL_POLICY;
const safeFetch = createSafeFetch({ policy });
const registry = createDefaultRegistry();

const ZERO_CONFIG_PROVIDERS = ['internet-archive', 'wikimedia-commons', 'librivox'];

function contextFor(provider: SearchProvider): SearchContext {
  return {
    searchId: 'srch_live',
    workspaceId: 'ws_live',
    mode: 'quick',
    deadlineMs: Date.now() + 25_000,
    maxCandidates: 5,
    config: {},
    logger: providerLogger(silentLogger, provider.id),
    fetch: safeFetch,
    now: Date.now,
  };
}

async function collect(provider: SearchProvider, query: string): Promise<RawSearchCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const out: RawSearchCandidate[] = [];
  try {
    for await (const candidate of provider.search(
      normalizeQuery(query),
      contextFor(provider),
      controller.signal,
    )) {
      out.push(candidate);
      if (out.length >= 5) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return out;
}

describeLive('live providers', () => {
  it.each(ZERO_CONFIG_PROVIDERS)(
    '%s reports itself reachable',
    async (providerId) => {
      const provider = registry.get(providerId);
      expect(provider).not.toBeNull();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const health = await provider!.healthCheck({
          config: {},
          fetch: safeFetch,
          signal: controller.signal,
          now: Date.now,
        });
        expect(health.status).toBe('ready');
      } finally {
        clearTimeout(timer);
      }
    },
    40_000,
  );

  it('Internet Archive returns real, well-formed candidates', async () => {
    const provider = registry.get('internet-archive');
    const candidates = await collect(provider!, 'gettysburg address');

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.mediaUrl).toMatch(/^https:\/\/archive\.org\/download\//);
      expect(candidate.pageUrl).toMatch(/^https:\/\/archive\.org\/details\//);
      expect(candidate.source.category).toBe('open_archive');
    }
  }, 60_000);

  it('Wikimedia Commons returns direct file URLs with licence information', async () => {
    const provider = registry.get('wikimedia-commons');
    const candidates = await collect(provider!, 'piano');

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.mediaUrl).toMatch(/^https:\/\//);
      expect(candidate.source.category).toBe('open_data');
    }
  }, 60_000);

  it('LibriVox returns audiobook listings without inventing media URLs', async () => {
    const provider = registry.get('librivox');
    const candidates = await collect(provider!, 'pride and prejudice');

    for (const candidate of candidates) {
      // LibriVox exposes item pages, not per-chapter media URLs, so the
      // adapter must not fabricate one.
      expect(candidate.mediaUrl).toBeNull();
      expect(candidate.declaredAccess).toBe('source_download');
    }
  }, 60_000);

  it('verifies a real remote file without downloading all of it', async () => {
    const provider = registry.get('internet-archive');
    const candidates = await collect(provider!, 'gettysburg address');
    const withUrls = candidates.filter((candidate) => candidate.mediaUrl !== null);
    expect(withUrls.length).toBeGreaterThan(0);

    const { verifyCandidate } = await import('../../src/orchestrate/verify.js');
    const outcomes: { status: string; bytes: number }[] = [];

    for (const candidate of withUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const result = await verifyCandidate(candidate.mediaUrl!, {
          fetch: safeFetch,
          signal: controller.signal,
          timeoutMs: 20_000,
          fetchTail: true,
        });
        outcomes.push({
          status: result.verification.status,
          bytes: result.verification.bytesInspected,
        });

        // Whatever the verdict, identification must stay cheap. Archive items
        // are routinely tens of megabytes; Auralis reads a bounded sample.
        expect(result.verification.bytesInspected).toBeLessThan(200_000);

        // Some archive items are access-restricted and answer 401. Reporting
        // that honestly — rather than assuming the file is fine — is the
        // behaviour under test.
        if (result.verification.status === 'verification_failed') {
          expect(result.technical.format).toBe('unknown');
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // At least one publicly readable item must have verified from its bytes.
    expect(
      outcomes.some(
        (outcome) => outcome.status === 'verified_audio' || outcome.status === 'probable_audio',
      ),
      `no candidate verified: ${JSON.stringify(outcomes)}`,
    ).toBe(true);
  }, 90_000);
});
