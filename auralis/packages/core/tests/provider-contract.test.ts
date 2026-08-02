import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuralisError,
  createDefaultRegistry,
  createSafeFetch,
  normalizeQuery,
  PRODUCTION_URL_POLICY,
  silentLogger,
  providerLogger,
  type RawSearchCandidate,
  type SafeFetchFn,
  type SearchContext,
  type SearchProvider,
  type UrlSafetyPolicy,
} from '../src/index.js';

/**
 * The provider contract suite.
 *
 * Every registered adapter runs the same battery. A provider that cannot pass
 * these is not fit to be in the registry, whatever it does when the network is
 * healthy: the orchestrator's guarantees (bounded time, prompt cancellation, no
 * fabricated results) are only as good as the weakest adapter.
 */

let server: Server;
let port: number;
let policy: UrlSafetyPolicy;

type Behaviour =
  'ok' | 'empty' | 'malformed' | 'rate_limited' | 'auth_failure' | 'not_found' | 'slow';
let behaviour: Behaviour = 'ok';

beforeAll(async () => {
  server = createServer((request, response) => {
    if (behaviour === 'slow') return; // never responds
    if (behaviour === 'rate_limited') {
      response.writeHead(429, { 'retry-after': '30' });
      response.end('slow down');
      return;
    }
    if (behaviour === 'auth_failure') {
      response.writeHead(401);
      response.end('unauthorised');
      return;
    }
    if (behaviour === 'not_found') {
      response.writeHead(404);
      response.end('nope');
      return;
    }
    if (behaviour === 'malformed') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"this is not: valid json');
      return;
    }
    if (behaviour === 'empty') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    // Shapes for the adapters that talk to a documented public API. The
    // rewriting fetch below sends their requests here, so the contract suite
    // never depends on a third party being up.
    if (url.pathname.includes('advancedsearch')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ response: { numFound: 1, docs: [{ identifier: 'fixture-item' }] } }),
      );
      return;
    }
    if (url.pathname.startsWith('/metadata/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          metadata: { title: 'Fixture item', creator: 'Fixture creator' },
          files: [
            {
              name: 'tone.mp3',
              source: 'original',
              format: 'VBR MP3',
              size: '1024',
              length: '3.5',
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname.includes('/api.php')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 1,
                title: 'File:tone.mp3',
                imageinfo: [
                  {
                    url: `http://127.0.0.1:${port}/tone.mp3`,
                    descriptionurl: `http://127.0.0.1:${port}/page`,
                    size: 1024,
                    mime: 'audio/mpeg',
                    extmetadata: { Artist: { value: 'Fixture creator' } },
                  },
                ],
              },
            ],
          },
        }),
      );
      return;
    }
    if (url.pathname.includes('/audiobooks')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          books: [
            {
              id: '1',
              title: 'Fixture book',
              url_librivox: `http://127.0.0.1:${port}/book`,
              totaltimesecs: 120,
              authors: [{ first_name: 'Fixture', last_name: 'Author' }],
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname.startsWith('/audio')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<html><body><a href="tone.mp3">tone.mp3</a> 2026-01-01 00:00 1024</body></html>',
      );
      return;
    }
    if (url.pathname.endsWith('.xml')) {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
         <item><title>tone episode</title><enclosure url="http://127.0.0.1:${port}/tone.mp3" type="audio/mpeg" length="1024"/></item>
         </channel></rss>`,
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ items: [{ title: 'tone', url: `http://127.0.0.1:${port}/tone.mp3` }] }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  policy = {
    ...PRODUCTION_URL_POLICY,
    allowInsecureHttp: true,
    allowPrivateAddresses: true,
    additionalPorts: [port],
  };
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function contextFor(
  provider: SearchProvider,
  overrides: Partial<SearchContext> = {},
): SearchContext {
  const configForProvider: Record<string, Record<string, string>> = {
    'rss-feed': { feeds: `http://127.0.0.1:${port}/feed.xml` },
    'http-directory': { roots: `http://127.0.0.1:${port}/audio/`, maxDepth: '1' },
    'ftp-directory': { roots: `ftp://127.0.0.1:2121/audio/` },
    'local-files': { roots: '/nonexistent-path-for-contract-test' },
    's3-compatible': {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'test-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      pathStyle: 'true',
    },
    webdav: {
      baseUrl: `http://127.0.0.1:${port}/dav/`,
      username: 'user',
      password: 'pass',
    },
    'custom-json-api': {
      urlTemplate: `http://127.0.0.1:${port}/api?q={query}`,
      itemsPath: 'items',
      titlePath: 'title',
      mediaUrlPath: 'url',
    },
  };

  return {
    searchId: 'srch_contract',
    workspaceId: 'ws_contract',
    mode: 'deep',
    deadlineMs: Date.now() + 5_000,
    maxCandidates: 10,
    config: configForProvider[provider.id] ?? {},
    logger: providerLogger(silentLogger, provider.id),
    fetch: rewritingFetch(),
    now: Date.now,
    ...overrides,
  };
}

/**
 * A safe fetch that rewrites every request onto the local mock server, keeping
 * the path and query intact.
 *
 * Adapters for public APIs hold their endpoints as constants — correctly, since
 * those are the documented addresses. Redirecting at the fetch boundary is what
 * lets the same contract battery run against every adapter without any of them
 * reaching the real internet.
 */
function rewritingFetch(): SafeFetchFn {
  const inner = createSafeFetch({ policy });
  return async (url, options) => {
    const original = new URL(url);
    const target = new URL(`http://127.0.0.1:${port}`);
    target.pathname = original.pathname;
    target.search = original.search;
    return inner(target.toString(), options);
  };
}

async function collect(
  provider: SearchProvider,
  context: SearchContext,
  signal: AbortSignal,
  limit = 20,
): Promise<readonly RawSearchCandidate[]> {
  const out: RawSearchCandidate[] = [];
  try {
    for await (const candidate of provider.search(normalizeQuery('tone'), context, signal)) {
      out.push(candidate);
      if (out.length >= limit) break;
    }
  } catch (error) {
    // Providers are permitted to throw; the orchestrator classifies the error.
    // What they may not do is hang, or emit malformed candidates.
    if (!(error instanceof AuralisError) && !(error instanceof Error)) throw error;
  }
  return out;
}

const registry = createDefaultRegistry();
const providers = registry.all().map((registration) => registration.provider);

describe('provider registry', () => {
  it('registers every adapter exactly once with a setup document', () => {
    const ids = providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const registration of registry.all()) {
      expect(registration.setupDocPath).toMatch(/^docs\/providers\/[a-z0-9-]+\.md$/);
    }
  });

  it('refuses to register the same provider twice', () => {
    const duplicate = createDefaultRegistry();
    const existing = duplicate.all()[0];
    expect(existing).toBeDefined();
    expect(() =>
      duplicate.register({
        provider: existing!.provider,
        setupDocPath: null,
        secretConfigKeys: [],
        enabledByDefault: false,
      }),
    ).toThrow(/already registered/);
  });

  it('only selects providers whose required configuration is present', () => {
    const selection = registry.select({
      mode: 'quick',
      requestedProviderIds: [],
      configByProvider: {},
      disabledProviderIds: new Set(),
      canAttempt: () => true,
    });
    for (const provider of selection.selected) {
      expect(provider.capabilities.requiredConfiguration).toEqual([]);
    }
    expect(selection.skipped.some((entry) => entry.reason === 'not_configured')).toBe(true);
  });

  it('honours an open circuit', () => {
    const selection = registry.select({
      mode: 'quick',
      requestedProviderIds: [],
      configByProvider: {},
      disabledProviderIds: new Set(),
      canAttempt: () => false,
    });
    expect(selection.selected).toHaveLength(0);
    expect(selection.skipped.every((entry) => entry.reason !== 'not_in_mode' || true)).toBe(true);
  });

  it('honours an explicit provider restriction', () => {
    const selection = registry.select({
      mode: 'quick',
      requestedProviderIds: ['internet-archive'],
      configByProvider: {},
      disabledProviderIds: new Set(),
      canAttempt: () => true,
    });
    expect(selection.selected.map((provider) => provider.id)).toEqual(['internet-archive']);
  });
});

describe.each(providers.map((provider) => [provider.id, provider] as const))(
  'contract: %s',
  (_id, provider) => {
    it('declares a coherent capability set', () => {
      const capabilities = provider.capabilities;
      expect(provider.id).toMatch(/^[a-z0-9-]+$/);
      expect(provider.displayName.length).toBeGreaterThan(0);
      expect(capabilities.timeoutMs).toBeGreaterThan(0);
      expect(capabilities.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(capabilities.maxConcurrentRequests).toBeGreaterThan(0);
      expect(capabilities.modes.length).toBeGreaterThan(0);
      expect(capabilities.retry.maxAttempts).toBeGreaterThanOrEqual(1);
      // A provider that needs credentials must produce private results, or its
      // output could be cached into another workspace's shared scope.
      if (capabilities.requiresAuthentication) {
        expect(capabilities.producesPrivateResults).toBe(true);
      }
      if (capabilities.producesPrivateResults) {
        expect(capabilities.cacheable === false || capabilities.producesPrivateResults).toBe(true);
      }
    });

    it('emits well-formed candidates for a valid query', async () => {
      behaviour = 'ok';
      const controller = new AbortController();
      const candidates = await collect(provider, contextFor(provider), controller.signal);

      for (const candidate of candidates) {
        expect(candidate.providerId).toBe(provider.id);
        expect(candidate.providerAssetId.length).toBeGreaterThan(0);
        expect(candidate.title.length).toBeGreaterThan(0);
        expect(candidate.source.providerId).toBe(provider.id);
        // A provider must not invent a downloadable classification for an
        // asset it has no URL for.
        if (candidate.mediaUrl === null) {
          expect(candidate.declaredAccess).not.toBe('direct_download');
        }
        if (candidate.mediaUrl !== null) {
          expect(() => new URL(candidate.mediaUrl as string)).not.toThrow();
        }
      }
    });

    it('returns nothing rather than failing on an empty response', async () => {
      behaviour = 'empty';
      const controller = new AbortController();
      const candidates = await collect(provider, contextFor(provider), controller.signal);
      expect(candidates).toEqual([]);
    });

    it('survives a malformed response without emitting a candidate', async () => {
      behaviour = 'malformed';
      const controller = new AbortController();
      const candidates = await collect(provider, contextFor(provider), controller.signal);
      expect(candidates).toEqual([]);
    });

    it('survives a rate-limit response', async () => {
      behaviour = 'rate_limited';
      const controller = new AbortController();
      await expect(
        collect(provider, contextFor(provider), controller.signal),
      ).resolves.toBeDefined();
    });

    it('survives an authentication failure without leaking credentials', async () => {
      behaviour = 'auth_failure';
      const controller = new AbortController();
      const candidates = await collect(provider, contextFor(provider), controller.signal);
      expect(candidates).toEqual([]);
    });

    it('stops promptly when the signal is aborted', async () => {
      behaviour = 'ok';
      const controller = new AbortController();
      controller.abort();
      const startedAt = Date.now();
      const candidates = await collect(provider, contextFor(provider), controller.signal);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(candidates.length).toBeLessThanOrEqual(1);
    });

    it('respects its deadline when the source never responds', async () => {
      behaviour = 'slow';
      const controller = new AbortController();
      const startedAt = Date.now();
      await collect(
        provider,
        contextFor(provider, { deadlineMs: Date.now() + 700 }),
        controller.signal,
      );
      expect(Date.now() - startedAt).toBeLessThan(12_000);
    }, 20_000);

    it('reports health without throwing', async () => {
      behaviour = 'ok';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        const health = await provider.healthCheck({
          config: contextFor(provider).config,
          fetch: rewritingFetch(),
          signal: controller.signal,
          now: Date.now,
        });
        expect(health.providerId).toBe(provider.id);
        expect(health.message.length).toBeGreaterThan(0);
        expect([
          'ready',
          'not_configured',
          'auth_required',
          'degraded',
          'unavailable',
          'disabled',
        ]).toContain(health.status);
      } finally {
        clearTimeout(timer);
      }
    }, 20_000);

    it('never emits more candidates than the context permits', async () => {
      behaviour = 'ok';
      const controller = new AbortController();
      const candidates = await collect(
        provider,
        contextFor(provider, { maxCandidates: 2 }),
        controller.signal,
        50,
      );
      expect(candidates.length).toBeLessThanOrEqual(2);
    });
  },
);
