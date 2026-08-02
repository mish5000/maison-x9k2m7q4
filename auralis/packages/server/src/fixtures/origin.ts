import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildFixtures, type FixtureFile } from './generate.js';

/**
 * A small origin server that publishes the fixture set as an HTTP directory
 * listing with byte-range support.
 *
 * This is what makes a local demonstration honest: the HTTP directory adapter
 * really crawls a real index page, really issues range requests, and really
 * verifies the bytes it gets back. Nothing about the search path is stubbed.
 */

export interface FixtureOriginOptions {
  readonly port?: number;
  readonly host?: string;
  /** Extra latency per request, used to exercise timeout handling. */
  readonly delayMs?: number;
  /** When set, requests for this filename hang until the client gives up. */
  readonly blackholeFilename?: string;
}

export interface FixtureOrigin {
  readonly server: Server;
  readonly port: number;
  readonly baseUrl: string;
  readonly fixtures: readonly FixtureFile[];
  close(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIndex(fixtures: readonly FixtureFile[]): string {
  const rows = fixtures
    .map(
      (fixture) =>
        `<a href="${encodeURIComponent(fixture.name)}">${escapeHtml(fixture.name)}</a>` +
        `                    2026-01-01 00:00  ${fixture.bytes.length}`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html><head><title>Index of /audio/</title></head>
<body>
<h1>Index of /audio/</h1>
<pre><a href="../">../</a>
${rows}
</pre>
</body></html>
`;
}

/** Parses a single `bytes=start-end` range against a known total length. */
export function parseRangeHeader(
  header: string | undefined,
  totalLength: number,
): { readonly start: number; readonly end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;

  if (startText === '' && endText !== '') {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, totalLength - suffixLength), end: totalLength - 1 };
  }

  const start = Number(startText);
  if (!Number.isFinite(start) || start < 0 || start >= totalLength) return null;
  const end = endText === '' ? totalLength - 1 : Math.min(Number(endText), totalLength - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

export async function startFixtureOrigin(
  options: FixtureOriginOptions = {},
): Promise<FixtureOrigin> {
  const fixtures = buildFixtures();
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const host = options.host ?? '127.0.0.1';

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    const path = decodeURIComponent(url.pathname);

    if (path === '/' || path === '/audio' || path === '/audio/') {
      const body = renderIndex(fixtures);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }

    const name = path.startsWith('/audio/') ? path.slice('/audio/'.length) : path.slice(1);
    const fixture = byName.get(name);

    if (!fixture) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }

    if (options.blackholeFilename && name === options.blackholeFilename) {
      // Deliberately never responds, so timeout handling can be tested.
      return;
    }

    const total = fixture.bytes.length;
    const range = parseRangeHeader(request.headers['range'], total);

    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'content-type': fixture.contentType,
        'content-length': String(total),
        'accept-ranges': 'bytes',
      });
      response.end();
      return;
    }

    if (range) {
      const slice = fixture.bytes.subarray(range.start, range.end + 1);
      response.writeHead(206, {
        'content-type': fixture.contentType,
        'content-length': String(slice.length),
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
        'accept-ranges': 'bytes',
      });
      response.end(Buffer.from(slice));
      return;
    }

    response.writeHead(200, {
      'content-type': fixture.contentType,
      'content-length': String(total),
      'accept-ranges': 'bytes',
      // Published archives commonly mark whole-file responses as downloads;
      // mirroring that keeps the demonstration honest.
      'content-disposition': `attachment; filename="${fixture.name}"`,
    });
    response.end(Buffer.from(fixture.bytes));
  };

  const server = createServer((request, response) => {
    if (options.delayMs && options.delayMs > 0) {
      setTimeout(() => handle(request, response), options.delayMs);
    } else {
      handle(request, response);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    server,
    port,
    baseUrl: `http://${host}:${port}/audio/`,
    fixtures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
