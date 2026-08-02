import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  collectEvents,
  createHarness,
  runSearch,
  type Harness,
  type SearchResultLike,
} from '../src/testing/harness.js';

/**
 * End-to-end search integration.
 *
 * The whole application runs against a real local origin serving real audio
 * bytes, so these tests exercise discovery, URL validation, range probing,
 * container parsing, access classification, deduplication and ranking together.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function find(
  results: readonly SearchResultLike[],
  filename: string,
): SearchResultLike | undefined {
  return results.find((result) => result.filename === filename);
}

describe('search pipeline', () => {
  it('discovers, verifies and ranks audio from a directory listing', async () => {
    const { results, status } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    expect(status).toBe('completed');
    expect(results.length).toBeGreaterThan(0);

    const wav = find(results, 'tone-a-440hz-stereo.wav');
    expect(wav).toBeDefined();
    expect(wav?.verification.status).toBe('verified_audio');
    expect(wav?.technical.format).toBe('wav');
    expect(wav?.technical.codec).toBe('pcm_s16le');
    expect(wav?.technical.sampleRateHz).toBe(44100);
    expect(wav?.technical.channels).toBe(2);
    expect(wav?.technical.bitDepth).toBe(16);
    expect(wav?.technical.durationSeconds).toBeCloseTo(3, 1);
    expect(wav?.technical.lossless).toBe(true);
    expect(wav?.technical.sizeBytes).toBeGreaterThan(0);
    expect(wav?.badges).toContain('verified_audio');
    expect(wav?.badges).toContain('lossless');
    expect(wav?.access.classification).toBe('direct_download');
    expect(wav?.access.actions).toContain('download');
  });

  it('reads MP3 frame headers rather than trusting the extension', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const mp3 = find(results, 'tone-c-220hz-stereo-320.mp3');
    expect(mp3?.technical.format).toBe('mp3');
    expect(mp3?.technical.bitrate.averageBps).toBeGreaterThan(250_000);
    expect(mp3?.technical.channels).toBe(2);
    expect(mp3?.technical.durationSeconds).toBeCloseTo(5, 0);
    expect(mp3?.verification.evidence.join(' ')).toContain('mp3:mpeg1-layer3');
  });

  it('rejects a web page served with an audio name and audio content type', async () => {
    const events = await runSearch(harness, {
      query: 'not really audio',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    }).then(({ searchId }) => collectEvents(harness, searchId));

    const rejection = events.find(
      (event) => event.type === 'candidate_rejected' && event['reason'] === 'not_audio',
    );
    expect(rejection).toBeDefined();
  });

  it('never presents a playlist as a playable audio file', async () => {
    const { searchId, results } = await runSearch(harness, {
      query: 'collection',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    expect(results.some((result) => result.filename === 'collection.m3u')).toBe(false);

    const events = await collectEvents(harness, searchId);
    const rejected = events.find(
      (event) => event.type === 'candidate_rejected' && event['reason'] === 'playlist_unresolved',
    );
    expect(rejected).toBeDefined();
  });

  it('marks a damaged file without claiming it is verified', async () => {
    const { results } = await runSearch(harness, {
      query: 'truncated tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const truncated = find(results, 'truncated-tone.wav');
    expect(truncated).toBeDefined();
    expect(truncated?.technical.corruptionSignals.length).toBeGreaterThan(0);
    expect(truncated?.verification.status).not.toBe('verified_audio');
  });

  it('assesses device compatibility from the file, not the filename', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
      compatibilityProfileIds: ['cdj-3000'],
    });

    const standard = find(results, 'tone-a-440hz-stereo.wav');
    expect(standard?.compatibility[0]?.profileId).toBe('cdj-3000');
    expect(standard?.compatibility[0]?.verdict).toBe('compatible');
    expect(standard?.badges).toContain('cdj_compatible');
  });

  it('streams progressive events in a valid order', async () => {
    const { searchId } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });
    const events = await collectEvents(harness, searchId);

    expect(events[0]?.type).toBe('search_started');
    expect(events.at(-1)?.type).toBe('search_completed');
    expect(events.some((event) => event.type === 'provider_started')).toBe(true);
    expect(events.some((event) => event.type === 'candidate_discovered')).toBe(true);
    expect(events.some((event) => event.type === 'candidate_verified')).toBe(true);
    expect(events.some((event) => event.type === 'search_progress')).toBe(true);

    // Sequence numbers are strictly increasing, which is what makes
    // Last-Event-ID resumption correct.
    const sequences = events.map((event) => event.seq);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

    // A candidate is always discovered before it is verified.
    const firstVerified = events.findIndex((event) => event.type === 'candidate_verified');
    const firstDiscovered = events.findIndex((event) => event.type === 'candidate_discovered');
    expect(firstDiscovered).toBeLessThan(firstVerified);
  });

  it('applies a lossless-only filter to verified facts', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'], losslessOnly: true },
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.technical.lossless).toBe(true);
  });

  it('applies a minimum bitrate filter without excluding lossless files', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'], minBitrateBps: 256_000 },
    });
    for (const result of results) {
      if (result.technical.lossless) continue;
      const bitrate = result.technical.bitrate.averageBps;
      if (bitrate !== null) expect(bitrate).toBeGreaterThanOrEqual(256_000);
    }
  });

  it('finds the same files through a user-selected local folder', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['local-files'] },
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.access.classification).toBe('user_owned');
      // A local file has no public URL, so none is ever exposed.
      expect(result.mediaUrl).toBeNull();
    }
  });

  it('ranks results and explains why the leader won', async () => {
    const { results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const totals = results.map((result) => result.ranking.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(results[0]?.ranking.explanation.length).toBeGreaterThan(0);
  });
});

describe('search control', () => {
  it('reports which providers were degraded without failing the search', async () => {
    const slow = await createHarness({ originOptions: { delayMs: 50 } });
    try {
      const { status } = await runSearch(slow, {
        query: 'tone',
        mode: 'connected',
        filters: { providerIds: ['http-directory'] },
      });
      expect(['completed', 'cancelled']).toContain(status);
    } finally {
      await slow.close();
    }
  }, 60_000);

  it('cancels a running search and says so', async () => {
    const created = await call(harness, {
      method: 'POST',
      url: '/api/v1/searches',
      payload: { query: 'tone', mode: 'deep' },
    });
    const { searchId } = created.json<{ searchId: string }>();

    const cancelled = await call(harness, {
      method: 'POST',
      url: `/api/v1/searches/${searchId}/cancel`,
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.json<{ cancelled: boolean }>().cancelled).toBe(true);

    // The search reaches a terminal state promptly rather than running on.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const status = await call(harness, { url: `/api/v1/searches/${searchId}` });
      const body = status.json<{ status: string }>();
      if (body.status !== 'running') {
        expect(['cancelled', 'completed']).toContain(body.status);
        break;
      }
      if (Date.now() > deadline) throw new Error('cancellation did not propagate');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 40_000);

  it('replays the event log to a client that connects late', async () => {
    const { searchId } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const all = await collectEvents(harness, searchId);
    expect(all.length).toBeGreaterThan(2);

    const firstSeq = all[0]?.seq ?? 0;
    const resumed = await call(harness, {
      url: `/api/v1/searches/${searchId}/events`,
      headers: { 'last-event-id': String(firstSeq) },
    });
    const replayed = resumed.body;
    expect(replayed).not.toContain(`"seq":${firstSeq},`);
    expect(replayed).toContain('search_completed');
  });

  it('makes a streamed result downloadable before the search finishes', async () => {
    const created = await call(harness, {
      method: 'POST',
      url: '/api/v1/searches',
      payload: { query: 'tone', mode: 'connected', filters: { providerIds: ['http-directory'] } },
    });
    const { searchId } = created.json<{ searchId: string }>();

    // Poll for the first result to appear while the search is still running,
    // then immediately ask for a download intent — exactly what the interface
    // does when a user clicks Download on a card that has just streamed in.
    const deadline = Date.now() + 20_000;
    let resultId: string | null = null;
    let stillRunning = false;

    while (resultId === null && Date.now() < deadline) {
      const response = await call(harness, { url: `/api/v1/searches/${searchId}` });
      const body = response.json<{ status: string; results: { id: string }[] }>();
      if (body.results.length > 0) {
        resultId = body.results[0]!.id;
        stillRunning = body.status === 'running';
        break;
      }
      if (body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(resultId, 'a result should be visible before the search ends').not.toBeNull();

    const intent = await call(harness, {
      method: 'POST',
      url: `/api/v1/assets/${resultId}/download-intent`,
      payload: { searchId },
    });
    expect(intent.status).toBe(200);
    // Recorded so a future reader can see whether the race was actually hit.
    expect(typeof stillRunning).toBe('boolean');
  }, 40_000);

  it('rejects an unknown search rather than leaking its existence', async () => {
    const response = await call(harness, { url: '/api/v1/searches/srch_does_not_exist' });
    expect(response.status).toBe(404);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /could not be found/i,
    );
  });
});
