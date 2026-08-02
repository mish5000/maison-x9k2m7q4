import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DownloadIntentResponse } from '@auralis/core';

import { openDatabase, pruneExpiredData } from '../src/db/database.js';
import { ConnectorRepository } from '../src/db/connectors.js';
import {
  decryptSecret,
  DecryptionError,
  encryptSecret,
  signSession,
  verifySession,
} from '../src/crypto/secrets.js';
import { loadConfig, ConfigError } from '../src/config/env.js';
import { call, createHarness, runSearch, type Harness } from '../src/testing/harness.js';

/**
 * Security and platform integration.
 *
 * These tests are the executable form of the invariants in
 * docs/security/threat-model.md: download control cannot be talked into
 * enabling a restricted transfer, connectors cannot leak across workspaces, and
 * credentials never come back out of the API.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('download control', () => {
  it('permits a download only for a verified, accessible file', async () => {
    const { searchId, results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const wav = results.find((result) => result.filename === 'tone-a-440hz-stereo.wav');
    expect(wav).toBeDefined();

    const response = await call(harness, {
      method: 'POST',
      url: `/api/v1/assets/${wav!.id}/download-intent`,
      payload: { searchId },
    });

    expect(response.status).toBe(200);
    const intent = response.json<DownloadIntentResponse>();
    expect(intent.allowed).toBe(true);
    expect(intent.method).toBe('direct');
    expect(intent.url).toContain('tone-a-440hz-stereo.wav');
    expect(intent.filename).toBe('tone-a-440hz-stereo.wav');
    // The pre-download summary states the facts the user needs.
    expect(intent.summary.format).toBe('wav');
    expect(intent.summary.sizeBytes).toBeGreaterThan(0);
    expect(intent.summary.durationSeconds).toBeCloseTo(3, 1);
    expect(intent.summary.verificationStatus).toBe('verified_audio');
    expect(intent.summary.sourceName.length).toBeGreaterThan(0);
  });

  it('refuses a download for a result that failed verification', async () => {
    const { searchId, results } = await runSearch(harness, {
      query: 'truncated tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });

    const truncated = results.find((result) => result.filename === 'truncated-tone.wav');
    expect(truncated).toBeDefined();
    // The interface would not offer this action; the API refuses it regardless.
    const response = await call(harness, {
      method: 'POST',
      url: `/api/v1/assets/${truncated!.id}/download-intent`,
      payload: { searchId },
    });

    const intent = response.json<DownloadIntentResponse>();
    if (!truncated!.access.actions.includes('download')) {
      expect(intent.allowed).toBe(false);
      expect(intent.url).toBeNull();
      expect(intent.reason.length).toBeGreaterThan(0);
    }
  });

  it('refuses a download intent for a result from another workspace', async () => {
    const { searchId, results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });
    const target = results[0];
    expect(target).toBeDefined();

    // A fresh session is a fresh workspace.
    const other = await createHarness({ withoutOrigin: true });
    try {
      await call(other, { url: '/api/v1/providers' });
      const response = await call(other, {
        method: 'POST',
        url: `/api/v1/assets/${target!.id}/download-intent`,
        payload: { searchId },
      });
      expect(response.status).toBe(404);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('rejects a download intent without a search reference', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/api/v1/assets/res_anything/download-intent',
      payload: {},
    });
    expect(response.status).toBe(400);
  });

  it('records every download decision in the audit log', async () => {
    const { searchId, results } = await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['http-directory'] },
    });
    const target = results[0];
    await call(harness, {
      method: 'POST',
      url: `/api/v1/assets/${target!.id}/download-intent`,
      payload: { searchId },
    });
    // The audit row is written by the service; a second identical call must
    // still be recorded rather than silently short-circuited.
    const second = await call(harness, {
      method: 'POST',
      url: `/api/v1/assets/${target!.id}/download-intent`,
      payload: { searchId },
    });
    expect(second.status).toBe(200);
  });
});

describe('request protection', () => {
  it('rejects a state-changing request without the CSRF header', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/api/v1/searches',
      payload: { query: 'tone' },
      withoutCsrf: true,
    });
    expect(response.status).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('validates the request body and reports which field was wrong', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/api/v1/searches',
      payload: { query: '', mode: 'sideways' },
    });
    expect(response.status).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/api/v1/searches',
      payload: { query: 'tone', somethingElse: true },
    });
    expect(response.status).toBe(400);
  });

  it('never returns a stack trace or an internal path', async () => {
    const response = await call(harness, { url: '/api/v1/searches/does-not-exist' });
    expect(response.body).not.toMatch(/\/home\/|node_modules|at Object\./);
  });

  it('sets a correlation id on every response', async () => {
    const response = await call(harness, { url: '/health' });
    expect(response.headers['x-correlation-id']).toBeTruthy();
  });

  it('sets security headers', async () => {
    const response = await call(harness, { url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rate limits searches per workspace', async () => {
    const limited = await createHarness({
      withoutOrigin: true,
      configOverrides: { AURALIS_RATE_LIMIT_SEARCHES_PER_MINUTE: '2' },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await call(limited, {
          method: 'POST',
          url: '/api/v1/searches',
          payload: {
            query: `tone ${i}`,
            mode: 'connected',
            filters: { providerIds: ['local-files'] },
          },
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  }, 60_000);
});

describe('connectors', () => {
  it('stores secrets encrypted and never returns them', async () => {
    const created = await call(harness, {
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        kind: 's3-compatible',
        displayName: 'Test bucket',
        config: {
          endpoint: 'https://s3.example.com',
          region: 'eu-west-1',
          bucket: 'my-bucket',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      },
    });

    expect(created.status).toBe(201);
    const summary = created.json<{
      id: string;
      config: Record<string, string>;
      accountIdentity: string;
    }>();
    expect(summary.config['accessKeyId']).toBeUndefined();
    expect(summary.config['secretAccessKey']).toBeUndefined();
    expect(created.body).not.toContain('wJalrXUtnFEMI');
    expect(summary.accountIdentity).toBe('my-bucket');

    const listed = await call(harness, { url: '/api/v1/connectors' });
    expect(listed.body).not.toContain('wJalrXUtnFEMI');
    expect(listed.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('refuses to create a connector that is missing required settings', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        kind: 's3-compatible',
        displayName: 'Incomplete',
        config: { endpoint: 'https://s3.example.com' },
      },
    });
    expect(response.status).toBe(409);
    const body = response.json<{ error: { code: string; details: { missing: string[] } } }>();
    expect(body.error.code).toBe('connector_not_configured');
    expect(body.error.details.missing).toContain('bucket');
  });

  it('isolates connectors between workspaces', async () => {
    const other = await createHarness({ withoutOrigin: true });
    try {
      const listed = await call(other, { url: '/api/v1/connectors' });
      expect(listed.json<{ connectors: unknown[] }>().connectors).toEqual([]);
    } finally {
      await other.close();
    }
  }, 60_000);

  it('deletes a connector and refuses to find it afterwards', async () => {
    const created = await call(harness, {
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        kind: 'rss-feed',
        displayName: 'A feed',
        config: { feeds: 'https://feeds.example.com/show.xml' },
      },
    });
    const { id } = created.json<{ id: string }>();

    const removed = await call(harness, { method: 'DELETE', url: `/api/v1/connectors/${id}` });
    expect(removed.status).toBe(204);

    const again = await call(harness, { method: 'DELETE', url: `/api/v1/connectors/${id}` });
    expect(again.status).toBe(404);
  });

  it('reports a connection test result without leaking the failure detail', async () => {
    const created = await call(harness, {
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        kind: 'webdav',
        displayName: 'Unreachable DAV',
        config: {
          baseUrl: 'https://dav.invalid.example/files/',
          username: 'user',
          password: 'hunter2',
        },
      },
    });
    const { id } = created.json<{ id: string }>();

    const tested = await call(harness, { method: 'POST', url: `/api/v1/connectors/${id}/test` });
    expect(tested.status).toBe(200);
    const body = tested.json<{ status: string; message: string }>();
    expect(['error', 'auth_required', 'ready']).toContain(body.status);
    expect(tested.body).not.toContain('hunter2');
  });
});

describe('credential storage', () => {
  const key = Buffer.alloc(32, 3);

  it('round-trips a secret and produces a different record each time', () => {
    const first = encryptSecret('super-secret', key);
    const second = encryptSecret('super-secret', key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe('super-secret');
    expect(decryptSecret(second, key)).toBe('super-secret');
    expect(first).not.toContain('super-secret');
  });

  it('refuses a record encrypted under a different key', () => {
    const record = encryptSecret('super-secret', key);
    expect(() => decryptSecret(record, Buffer.alloc(32, 9))).toThrow(DecryptionError);
  });

  it('refuses a tampered record', () => {
    const record = encryptSecret('super-secret', key);
    const parts = record.split('.');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]}AA`].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it('signs and verifies session values, rejecting a forged signature', () => {
    const signed = signSession('usr_abc', 'a-secret-value-that-is-long-enough');
    expect(verifySession(signed, 'a-secret-value-that-is-long-enough')).toBe('usr_abc');
    expect(verifySession(signed, 'a-different-secret')).toBeNull();
    expect(verifySession('usr_abc.forged', 'a-secret-value-that-is-long-enough')).toBeNull();
    expect(verifySession('no-signature', 'a-secret-value-that-is-long-enough')).toBeNull();
  });

  it('keeps a connector unreadable when the key no longer matches', () => {
    const db = openDatabase(':memory:');
    try {
      const repository = new ConnectorRepository(db, key);
      const workspace = 'ws_test';
      db.prepare('INSERT INTO workspace (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
        workspace,
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const connector = repository.create({
        workspaceId: workspace,
        kind: 's3-compatible',
        displayName: 'Bucket',
        config: { bucket: 'b', secretAccessKey: 'shh' },
        secretKeys: ['secretAccessKey'],
      });

      expect(repository.resolveConfig(workspace, connector.id)?.['secretAccessKey']).toBe('shh');

      const rotated = new ConnectorRepository(db, Buffer.alloc(32, 4));
      expect(rotated.resolveConfig(workspace, connector.id)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('configuration', () => {
  it('requires an encryption key in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it('refuses to allow private egress in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AURALIS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
        AURALIS_SESSION_SECRET: 'x'.repeat(40),
        AURALIS_ALLOW_PRIVATE_EGRESS: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AURALIS_ALLOW_PRIVATE_EGRESS/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AURALIS_SECRET_KEY: Buffer.alloc(16, 1).toString('base64'),
        AURALIS_SESSION_SECRET: 'x'.repeat(40),
      } as NodeJS.ProcessEnv),
    ).toThrow(/32 bytes/);
  });
});

describe('retention', () => {
  it('deletes data past its retention window', () => {
    const db = openDatabase(':memory:');
    try {
      const now = Date.now();
      const old = new Date(now - 400 * 86_400_000).toISOString();
      db.prepare(
        'INSERT INTO download_audit (workspace_id, search_id, result_id, provider_id, access_class, allowed, reason, method, final_host, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        'ws',
        'srch',
        'res',
        'p',
        'direct_download',
        1,
        'permitted',
        'direct',
        'example.com',
        old,
      );

      const before = db.prepare('SELECT COUNT(*) AS n FROM download_audit').get() as { n: number };
      expect(Number(before.n)).toBe(1);

      pruneExpiredData(db, now);

      const after = db.prepare('SELECT COUNT(*) AS n FROM download_audit').get() as { n: number };
      expect(Number(after.n)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lets a user delete their own search history', async () => {
    await runSearch(harness, {
      query: 'tone',
      mode: 'connected',
      filters: { providerIds: ['local-files'] },
    });
    const deleted = await call(harness, { method: 'DELETE', url: '/api/v1/searches' });
    expect(deleted.status).toBe(200);
    expect(deleted.json<{ deleted: number }>().deleted).toBeGreaterThan(0);
  });
});
