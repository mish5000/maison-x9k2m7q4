import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { writeFixtures } from '../fixtures/generate.js';
import {
  startFixtureOrigin,
  type FixtureOrigin,
  type FixtureOriginOptions,
} from '../fixtures/origin.js';

/**
 * Test harness.
 *
 * Builds the whole application against a temporary database and a real local
 * fixture origin. Nothing is stubbed: the search really crawls a directory
 * listing, really issues range requests and really parses container bytes, so
 * a passing test says something about the product rather than about mocks.
 */

export interface HarnessOptions {
  readonly originOptions?: FixtureOriginOptions;
  readonly configOverrides?: Partial<Record<string, string>>;
  /** Extra provider configuration merged into the static config. */
  readonly extraProviderConfig?: Record<string, Record<string, string>>;
  /** Skip starting the fixture origin (for tests that only need the API). */
  readonly withoutOrigin?: boolean;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly origin: FixtureOrigin | null;
  readonly config: AppConfig;
  readonly fixtureDir: string;
  /** Cookie jar value carried between requests to keep one workspace. */
  cookie: string | null;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'auralis-test-'));
  const fixtureDir = join(directory, 'fixtures');
  writeFixtures(fixtureDir);

  const origin = options.withoutOrigin
    ? null
    : await startFixtureOrigin(options.originOptions ?? {});

  const config = loadConfig({
    NODE_ENV: 'test',
    AURALIS_DATABASE_PATH: join(directory, 'test.db'),
    AURALIS_LOG_LEVEL: 'error',
    AURALIS_ALLOW_PRIVATE_EGRESS: 'true',
    AURALIS_ALLOW_INSECURE_HTTP: 'true',
    AURALIS_FIXTURE_DIR: fixtureDir,
    // Only set when an origin is running; the schema requires a real port.
    ...(origin ? { AURALIS_FIXTURE_ORIGIN_PORT: String(origin.port) } : {}),
    AURALIS_SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    AURALIS_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...options.configOverrides,
  } as NodeJS.ProcessEnv);

  const staticProviderConfig: Record<string, Record<string, string>> = {
    ...(origin ? { 'http-directory': { roots: origin.baseUrl, maxDepth: '1' } } : {}),
    'local-files': { roots: fixtureDir },
    ...options.extraProviderConfig,
  };

  const app = await buildApp({ config, staticProviderConfig });
  await app.ready();

  return {
    app,
    origin,
    config,
    fixtureDir,
    cookie: null,
    async close() {
      await app.close();
      await origin?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export interface InjectOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly payload?: unknown;
  readonly headers?: Record<string, string>;
  /** Omit the CSRF header, to prove the guard actually rejects the request. */
  readonly withoutCsrf?: boolean;
}

/** Injects a request, carrying the session cookie so one workspace is reused. */
export async function call(
  harness: Harness,
  options: InjectOptions,
): Promise<{
  status: number;
  json: <T = unknown>() => T;
  body: string;
  headers: Record<string, unknown>;
}> {
  const headers: Record<string, string> = {
    ...(options.withoutCsrf ? {} : { 'x-auralis-csrf': '1' }),
    ...(harness.cookie ? { cookie: harness.cookie } : {}),
    ...(options.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
  };

  const response = await harness.app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    ...(options.payload !== undefined ? { payload: JSON.stringify(options.payload) } : {}),
  });

  const setCookie = response.headers['set-cookie'];
  if (setCookie) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (raw) harness.cookie = raw.split(';')[0] ?? null;
  }

  return {
    status: response.statusCode,
    json: <T = unknown>() => response.json() as T,
    body: response.body,
    headers: response.headers as Record<string, unknown>,
  };
}

/** Runs a search and waits for it to finish, returning the final results. */
export async function runSearch(
  harness: Harness,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ searchId: string; status: string; results: SearchResultLike[] }> {
  const created = await call(harness, { method: 'POST', url: '/api/v1/searches', payload });
  if (created.status !== 201) {
    throw new Error(`Search creation failed with ${created.status}: ${created.body}`);
  }
  const { searchId } = created.json<{ searchId: string }>();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(harness, { url: `/api/v1/searches/${searchId}` });
    const body = response.json<{ status: string; results: SearchResultLike[] }>();
    if (body.status !== 'running') return { searchId, status: body.status, results: body.results };
    if (Date.now() > deadline)
      throw new Error(`Search ${searchId} did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface SearchResultLike {
  readonly id: string;
  readonly title: string;
  readonly filename: string | null;
  readonly mediaUrl: string | null;
  readonly badges: readonly string[];
  readonly access: {
    readonly classification: string;
    readonly actions: readonly string[];
    readonly reason: string;
  };
  readonly verification: {
    readonly status: string;
    readonly evidence: readonly string[];
    readonly signatureAgreement: boolean;
  };
  readonly technical: {
    readonly format: string;
    readonly codec: string;
    readonly durationSeconds: number | null;
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly bitDepth: number | null;
    readonly sizeBytes: number | null;
    readonly lossless: boolean;
    readonly bitrate: {
      readonly averageBps: number | null;
      readonly mode: string;
      readonly estimated: boolean;
    };
    readonly corruptionSignals: readonly string[];
  };
  readonly compatibility: readonly { readonly profileId: string; readonly verdict: string }[];
  readonly quality: { readonly total: number };
  readonly ranking: { readonly total: number; readonly explanation: readonly string[] };
  readonly duplicateCount: number;
  readonly variants: readonly { readonly id: string; readonly differsBy: readonly string[] }[];
}

/** Collects SSE events from a search until it terminates. */
export async function collectEvents(
  harness: Harness,
  searchId: string,
  timeoutMs = 30_000,
): Promise<readonly { type: string; seq: number; [key: string]: unknown }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(harness, { url: `/api/v1/searches/${searchId}` });
    const body = response.json<{ status: string }>();
    if (body.status !== 'running') break;
    if (Date.now() > deadline) throw new Error('Search did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const stream = await call(harness, { url: `/api/v1/searches/${searchId}/events` });
  return parseSseBody(stream.body);
}

export function parseSseBody(
  body: string,
): readonly { type: string; seq: number; [key: string]: unknown }[] {
  const events: { type: string; seq: number; [key: string]: unknown }[] = [];
  for (const block of body.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; seq?: number };
      if (typeof parsed.type === 'string') {
        events.push({ ...parsed, type: parsed.type, seq: parsed.seq ?? 0 });
      }
    } catch {
      // Heartbeat comments and the stream_closed marker are not JSON events.
    }
  }
  return events;
}
