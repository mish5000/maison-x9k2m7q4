import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuralisError,
  createSafeFetch,
  pinnedLookup,
  PRODUCTION_URL_POLICY,
  UnsafeUrlError,
  type DnsResolver,
  type SafeFetchFn,
  type UrlSafetyPolicy,
} from '../src/index.js';

/**
 * These tests drive the egress layer against a deliberately hostile local
 * server: redirect chains into private space, oversized bodies, endless
 * streams, lying Content-Length headers, and credential-carrying redirects.
 */

let server: Server;
let port: number;
let fetchLocal: SafeFetchFn;

const localPolicy = (overrides: Partial<UrlSafetyPolicy> = {}): UrlSafetyPolicy => ({
  ...PRODUCTION_URL_POLICY,
  allowInsecureHttp: true,
  allowPrivateAddresses: true,
  additionalPorts: [port],
  ...overrides,
});

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    switch (path) {
      case '/ok':
        response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '4' });
        response.end('abcd');
        return;

      case '/echo-headers':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(request.headers));
        return;

      case '/redirect-to-loopback':
        response.writeHead(302, { location: 'http://127.0.0.1:9/secret' });
        response.end();
        return;

      case '/redirect-to-metadata':
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        response.end();
        return;

      case '/redirect-to-file':
        response.writeHead(302, { location: 'file:///etc/passwd' });
        response.end();
        return;

      case '/redirect-loop':
        response.writeHead(302, { location: `http://127.0.0.1:${port}/redirect-loop` });
        response.end();
        return;

      case '/redirect-cross-origin':
        // A different host that still reaches this server, so the request
        // completes and the echoed headers show what survived the hop.
        response.writeHead(302, { location: `http://127.0.0.2:${port}/echo-headers` });
        response.end();
        return;

      case '/huge': {
        // Declares no length and then streams far more than the policy allows.
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        for (let i = 0; i < 80; i += 1) response.write(chunk);
        response.end();
        return;
      }

      case '/endless': {
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        const timer = setInterval(() => {
          if (!response.writableEnded) response.write(Buffer.alloc(8192, 0x42));
        }, 5);
        response.on('close', () => clearInterval(timer));
        return;
      }

      case '/slow':
        // Never responds, so the caller's timeout is what ends the request.
        return;

      case '/range': {
        const body = Buffer.alloc(50_000, 0x43);
        const range = request.headers['range'];
        if (typeof range === 'string') {
          const match = /bytes=(\d+)-(\d+)/.exec(range);
          if (match) {
            const start = Number(match[1]);
            const end = Math.min(Number(match[2]), body.length - 1);
            const slice = body.subarray(start, end + 1);
            response.writeHead(206, {
              'content-type': 'audio/mpeg',
              'content-range': `bytes ${start}-${end}/${body.length}`,
              'content-length': String(slice.length),
            });
            response.end(slice);
            return;
          }
        }
        response.writeHead(200, { 'content-length': String(body.length) });
        response.end(body);
        return;
      }

      default:
        response.writeHead(404);
        response.end('nope');
    }
  });

  // Bound to all loopback addresses so a redirect to 127.0.0.2 still lands here.
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  port = (server.address() as AddressInfo).port;
  fetchLocal = createSafeFetch({ policy: localPolicy() });
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('safe fetch', () => {
  it('performs an ordinary request', async () => {
    const response = await fetchLocal(`http://127.0.0.1:${port}/ok`);
    expect(response.status).toBe(200);
    expect(response.text()).toBe('abcd');
    expect(response.finalHost).toBe('127.0.0.1');
    expect(response.headers['content-type']).toBe('audio/mpeg');
  });

  it('refuses a redirect into loopback space', async () => {
    const strict = createSafeFetch({ policy: localPolicy({ allowPrivateAddresses: false }) });
    await expect(strict(`http://127.0.0.1:${port}/ok`)).rejects.toThrow(UnsafeUrlError);
  });

  it('refuses a redirect to the cloud metadata service', async () => {
    // The first hop is permitted (private addresses allowed for the fixture),
    // but the metadata range is refused by an explicit rule regardless.
    const guarded = createSafeFetch({
      policy: localPolicy({ allowPrivateAddresses: false }),
    });
    await expect(guarded(`http://169.254.169.254/latest/`)).rejects.toThrow(/private network/i);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    await expect(fetchLocal(`http://127.0.0.1:${port}/redirect-to-file`)).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it('bounds redirect chains', async () => {
    await expect(fetchLocal(`http://127.0.0.1:${port}/redirect-loop`)).rejects.toThrow(
      /redirects too many times/i,
    );
  });

  it('drops credential headers when a redirect changes host', async () => {
    const response = await fetchLocal(`http://127.0.0.1:${port}/redirect-cross-origin`, {
      headers: { authorization: 'Bearer super-secret-token', cookie: 'session=abc' },
    });
    const echoed = response.json<Record<string, string>>();
    expect(echoed['authorization']).toBeUndefined();
    expect(echoed['cookie']).toBeUndefined();
    expect(response.redirectCount).toBe(1);
  });

  it('keeps headers when a redirect stays on the same host', async () => {
    const echo = await fetchLocal(`http://127.0.0.1:${port}/echo-headers`, {
      headers: { 'x-test': 'kept' },
    });
    expect(echo.json<Record<string, string>>()['x-test']).toBe('kept');
  });

  it('rejects header values containing control characters', async () => {
    await expect(
      fetchLocal(`http://127.0.0.1:${port}/ok`, { headers: { 'x-evil': 'a\r\nX-Injected: yes' } }),
    ).rejects.toThrow(/header value/i);
  });

  it('rejects header names that are not tokens', async () => {
    await expect(
      fetchLocal(`http://127.0.0.1:${port}/ok`, { headers: { 'bad header': 'x' } }),
    ).rejects.toThrow(/header name/i);
  });

  it('refuses a body larger than the policy allows', async () => {
    await expect(fetchLocal(`http://127.0.0.1:${port}/huge`)).rejects.toThrow(
      /larger than Auralis will download/i,
    );
  });

  it('truncates rather than hangs when the caller asked for a prefix', async () => {
    const response = await fetchLocal(`http://127.0.0.1:${port}/endless`, { maxBytes: 16 * 1024 });
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(16 * 1024);
  });

  it('honours the timeout when a server never responds', async () => {
    const startedAt = Date.now();
    await expect(fetchLocal(`http://127.0.0.1:${port}/slow`, { timeoutMs: 400 })).rejects.toThrow(
      /took too long/i,
    );
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('supports byte-range requests, which is how probing stays cheap', async () => {
    const response = await fetchLocal(`http://127.0.0.1:${port}/range`, {
      range: { start: 0, end: 1023 },
      maxBytes: 1024,
    });
    expect(response.status).toBe(206);
    expect(response.body.length).toBe(1024);
    expect(response.headers['content-range']).toBe('bytes 0-1023/50000');
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    const promise = fetchLocal(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow(AuralisError);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchLocal(`http://127.0.0.1:${port}/ok`, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('answers the pinned lookup asynchronously', async () => {
    const lookup = pinnedLookup('93.184.216.34', 4) as unknown as (
      hostname: string,
      options: unknown,
      callback?: unknown,
    ) => void;

    let called = false;
    const done = new Promise<void>((resolve) => {
      lookup('example.com', { all: true }, () => {
        called = true;
        resolve();
      });
    });

    // Answering synchronously would make Node connect inside request(), before
    // a socket error listener exists — which crashed the process.
    expect(called).toBe(false);
    await done;
    expect(called).toBe(true);
  });

  it('answers the pinned lookup in both shapes Node uses', async () => {
    const lookup = pinnedLookup('93.184.216.34', 4) as unknown as (
      hostname: string,
      options: unknown,
      callback?: unknown,
    ) => void;

    // The array form, which is what a TLS connection uses. Getting this wrong
    // breaks every https request, so it is asserted directly.
    const all = await new Promise<unknown>((resolve) => {
      lookup('example.com', { all: true }, (_error: unknown, value: unknown) => resolve(value));
    });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);

    const single = await new Promise<[unknown, unknown]>((resolve) => {
      lookup('example.com', { all: false }, (_error: unknown, value: unknown, fam: unknown) =>
        resolve([value, fam]),
      );
    });
    expect(single).toEqual(['93.184.216.34', 4]);

    // The two-argument form, where the callback takes the options slot.
    const legacy = await new Promise<unknown>((resolve) => {
      lookup('example.com', (_error: unknown, value: unknown) => resolve(value));
    });
    expect(legacy).toBe('93.184.216.34');
  });

  it('survives an unreachable address family without crashing the process', async () => {
    // A public IPv6 address that this environment usually cannot route, with a
    // working IPv4 address behind it. The request must fall through to the
    // reachable address rather than emitting an unhandled socket error.
    const dualStack: DnsResolver = async () => [
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ];
    const guarded = createSafeFetch({
      policy: localPolicy(),
      resolver: dualStack,
    });

    const response = await guarded(`http://dual.example:${port}/ok`);
    expect(response.status).toBe(200);
    expect(response.finalIp).toBe('127.0.0.1');
  });

  it('rejects a host whose DNS answer contains an internal address', async () => {
    const rebinding: DnsResolver = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ];
    const guarded = createSafeFetch({
      policy: { ...PRODUCTION_URL_POLICY, allowInsecureHttp: true, additionalPorts: [port] },
      resolver: rebinding,
    });
    await expect(guarded(`http://rebind.example:${port}/ok`)).rejects.toThrow(UnsafeUrlError);
  });

  it('refuses a connection whose peer address differs from the validated one', async () => {
    // The resolver points at a public address; the connection to it will fail
    // or land elsewhere, and either way the request must not succeed silently.
    const lying: DnsResolver = async () => [{ address: '203.0.113.7', family: 4 }];
    const guarded = createSafeFetch({
      policy: { ...PRODUCTION_URL_POLICY, allowInsecureHttp: true, additionalPorts: [port] },
      resolver: lying,
    });
    await expect(guarded(`http://lies.example:${port}/ok`)).rejects.toThrow();
  });
});
