import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import { AuralisError } from '../domain/errors.js';
import type { SafeFetchFn, SafeFetchOptions, SafeFetchResponse } from '../domain/provider.js';
import { classifyIp } from './ip-rules.js';
import {
  assertUrlAllowed,
  hostMatches,
  normaliseHostname,
  UnsafeUrlError,
  type DnsResolver,
  type ResolvedTarget,
  type UrlSafetyPolicy,
} from './url-safety.js';

/**
 * The single approved outbound HTTP client.
 *
 * Guarantees:
 *  - every URL, including every redirect target, passes the URL safety service
 *  - connections are pinned to the exact IP that was validated, and the socket's
 *    peer address is re-checked after connect (DNS rebinding defence)
 *  - responses are hard-capped in bytes and wall-clock time
 *  - credential headers are dropped when a redirect changes host
 *  - redirect chains are bounded
 *
 * It deliberately does not support proxies: an HTTP proxy would resolve the
 * host itself, which would void the IP-pinning guarantee.
 */

export const USER_AGENT = 'Auralis/0.1 (+https://github.com/auralis; audio discovery)';

const CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'cookie', 'proxy-authorization'];

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// eslint-disable-next-line no-control-regex -- deliberately matching control bytes
const HEADER_VALUE_FORBIDDEN = /[\u0000-\u001f\u007f]/;

export interface SafeFetchDeps {
  readonly policy: UrlSafetyPolicy;
  readonly resolver?: DnsResolver;
  readonly now?: () => number;
}

class ResponseBodyTooLargeError extends AuralisError {
  constructor(limit: number) {
    super('payload_too_large', 'That file is larger than Auralis will download in one step.', {
      details: { limitBytes: limit },
    });
    this.name = 'ResponseBodyTooLargeError';
  }
}

function sanitiseRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new AuralisError('invalid_request', 'A request header name was not valid.');
    }
    const value = String(rawValue);
    if (HEADER_VALUE_FORBIDDEN.test(value)) {
      throw new AuralisError('invalid_request', 'A request header value was not valid.');
    }
    out[name] = value;
  }
  return out;
}

function collectHeaders(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

type LookupAllCallback = (
  err: Error | null,
  addresses: readonly { address: string; family: number }[],
) => void;
type LookupSingleCallback = (err: Error | null, address: string, family: number) => void;

/**
 * Builds a `lookup` implementation that always returns the pre-validated
 * address, so the socket cannot be pointed elsewhere by a second DNS answer.
 *
 * Node calls `lookup` with two different shapes: `(host, options, callback)`
 * where `options.all` may be true — in which case the callback expects an
 * array — and the older `(host, callback)` form. TLS connections use the
 * array form, so both have to be handled or every https request fails.
 *
 * The callback is deferred deliberately. A real resolver is asynchronous, and
 * answering synchronously makes Node connect inside `request()` itself — before
 * the caller can attach a socket error listener, so a failed connect surfaces
 * as an unhandled 'error' event and terminates the process.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
    const options =
      typeof optionsOrCallback === 'function'
        ? {}
        : ((optionsOrCallback ?? {}) as { all?: boolean });
    const callback = (
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    ) as LookupAllCallback | LookupSingleCallback | undefined;
    if (typeof callback !== 'function') return;

    setImmediate(() => {
      if (options.all === true) {
        (callback as LookupAllCallback)(null, [{ address, family }]);
        return;
      }
      (callback as LookupSingleCallback)(null, address, family);
    });
  }) as unknown as LookupFunction;
}

interface SingleRequestResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
  readonly remoteAddress: string;
}

async function performRequest(
  target: ResolvedTarget,
  address: string,
  family: 4 | 6,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  maxBytes: number,
  timeoutMs: number,
  connectTimeoutMs: number,
  externalSignal: AbortSignal | undefined,
  allowPrivateAddresses: boolean,
): Promise<SingleRequestResult> {
  const isHttps = target.url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  return await new Promise<SingleRequestResult>((resolve, reject) => {
    if (externalSignal?.aborted) {
      reject(new AuralisError('cancelled', 'The request was cancelled.'));
      return;
    }

    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      externalSignal?.removeEventListener('abort', onAbort);
      fn();
    };

    const failWith = (error: Error): void => {
      finish(() => {
        req.destroy();
        reject(error);
      });
    };

    const totalTimer = setTimeout(() => {
      failWith(new AuralisError('timeout', 'That source took too long to respond.'));
    }, timeoutMs);

    const onAbort = (): void => {
      failWith(new AuralisError('cancelled', 'The request was cancelled.'));
    };
    externalSignal?.addEventListener('abort', onAbort, { once: true });

    const req: ClientRequest = requestFn({
      protocol: target.url.protocol,
      host: target.hostname,
      // `servername` keeps SNI and certificate validation tied to the hostname
      // even though the connection is pinned to a specific IP.
      servername: isHttps ? target.hostname : undefined,
      port: target.port,
      method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: { ...headers, host: hostHeaderFor(target) },
      lookup: pinnedLookup(address, family),
      timeout: connectTimeoutMs,
      // Redirects are handled explicitly by the caller so each hop is revalidated.
      agent: false,
    });

    req.on('socket', (socket) => {
      // Without this, a connect-level failure (an unreachable address family,
      // for instance) is emitted on the socket with no listener and takes the
      // whole process down.
      socket.on('error', () => {
        failWith(new AuralisError('provider_unavailable', 'That source could not be reached.'));
      });

      socket.on('connect', () => {
        const peer = socket.remoteAddress ?? '';
        if (!allowPrivateAddresses) {
          const verdict = classifyIp(peer);
          if (verdict.disposition === 'blocked') {
            failWith(
              new UnsafeUrlError({
                rule: `connect:${verdict.rule}`,
                message: 'That source resolved to a private network address.',
              }),
            );
            return;
          }
        }
        if (peer !== address) {
          failWith(
            new UnsafeUrlError({
              rule: 'connect:address-mismatch',
              message: 'That source could not be verified.',
            }),
          );
        }
      });
    });

    req.on('timeout', () => {
      failWith(new AuralisError('timeout', 'That source took too long to respond.'));
    });

    req.on('error', () => {
      // Network-level detail is deliberately not surfaced to callers.
      failWith(new AuralisError('provider_unavailable', 'That source could not be reached.'));
    });

    req.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;

      if (method === 'HEAD') {
        res.resume();
        res.on('end', () => {
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: collectHeaders(res),
              body: new Uint8Array(0),
              truncated: false,
              remoteAddress: res.socket?.remoteAddress ?? address,
            }),
          );
        });
        return;
      }

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          // Keep exactly the allowed prefix and stop reading. This is what makes
          // range-probing safe against servers that lie about content-length.
          const keep = maxBytes - (received - chunk.length);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          truncated = true;
          res.destroy();
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: collectHeaders(res),
              body: Buffer.concat(chunks),
              truncated,
              remoteAddress: res.socket?.remoteAddress ?? address,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        finish(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: collectHeaders(res),
            body: Buffer.concat(chunks),
            truncated,
            remoteAddress: res.socket?.remoteAddress ?? address,
          }),
        );
      });

      res.on('error', () => {
        failWith(new AuralisError('provider_unavailable', 'That source could not be reached.'));
      });
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
}

function hostHeaderFor(target: ResolvedTarget): string {
  const isDefaultPort =
    (target.url.protocol === 'https:' && target.port === 443) ||
    (target.url.protocol === 'http:' && target.port === 80);
  const host = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
  return isDefaultPort ? host : `${host}:${target.port}`;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Creates a fetch function bound to a policy. This is the only egress path. */
export function createSafeFetch(deps: SafeFetchDeps): SafeFetchFn {
  const { policy, resolver } = deps;

  return async function safeFetch(
    rawUrl: string,
    options: SafeFetchOptions = {},
  ): Promise<SafeFetchResponse> {
    const startedAt = Date.now();
    const method = options.method ?? 'GET';
    const maxBytes = Math.min(options.maxBytes ?? policy.maxResponseBytes, policy.maxResponseBytes);
    const totalTimeout = Math.min(
      options.timeoutMs ?? policy.totalTimeoutMs,
      policy.totalTimeoutMs,
    );

    const effectivePolicy: UrlSafetyPolicy =
      options.allowHosts && options.allowHosts.length > 0
        ? { ...policy, allowHosts: [...policy.allowHosts, ...options.allowHosts] }
        : policy;

    let currentUrl = rawUrl;
    let redirectCount = 0;
    let headers = sanitiseRequestHeaders({
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...(options.headers ?? {}),
      ...(options.range ? { range: `bytes=${options.range.start}-${options.range.end}` } : {}),
      ...(options.body !== undefined && !options.headers?.['content-type']
        ? { 'content-type': 'application/json' }
        : {}),
    });
    let currentMethod = method;
    let currentBody = options.body;

    for (;;) {
      const remaining = totalTimeout - (Date.now() - startedAt);
      if (remaining <= 0) {
        throw new AuralisError('timeout', 'That source took too long to respond.');
      }

      const target = await assertUrlAllowed(currentUrl, effectivePolicy, resolver);
      // IPv4 first: many hosts and containers have no IPv6 route, and trying a
      // reachable address before an unreachable one avoids a wasted timeout.
      const candidateAddresses = [...target.addresses]
        .sort((a, b) => a.family - b.family)
        .slice(0, 3);
      if (candidateAddresses.length === 0) {
        throw new UnsafeUrlError({
          rule: 'dns:no-records',
          message: 'That source could not be reached.',
        });
      }

      let result: SingleRequestResult | undefined;
      let lastError: unknown;
      for (const record of candidateAddresses) {
        try {
          result = await performRequest(
            target,
            record.address,
            record.family,
            currentMethod,
            headers,
            currentBody,
            maxBytes,
            Math.max(1, totalTimeout - (Date.now() - startedAt)),
            policy.connectTimeoutMs,
            options.signal,
            policy.allowPrivateAddresses,
          );
          break;
        } catch (error) {
          lastError = error;
          if (error instanceof UnsafeUrlError) throw error;
          if (error instanceof AuralisError && error.code === 'cancelled') throw error;
        }
      }
      if (!result) {
        throw lastError instanceof Error
          ? lastError
          : new AuralisError('provider_unavailable', 'That source could not be reached.');
      }

      const location = result.headers['location'];
      if (REDIRECT_STATUSES.has(result.status) && typeof location === 'string') {
        if (redirectCount >= policy.maxRedirects) {
          throw new UnsafeUrlError({
            rule: 'redirect:too-many',
            message: 'That link redirects too many times.',
          });
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, target.url).toString();
        } catch {
          throw new UnsafeUrlError({
            rule: 'redirect:unparseable-location',
            message: 'That source sent an invalid redirect.',
          });
        }
        const nextHost = normaliseHostname(new URL(nextUrl).hostname);
        if (!hostMatches(nextHost, target.hostname)) {
          // Never carry credentials across an origin boundary.
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())),
          );
        }
        if (result.status === 303 || (result.status === 302 && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
          delete headers['content-type'];
        }
        currentUrl = nextUrl;
        redirectCount += 1;
        continue;
      }

      if (
        result.truncated &&
        maxBytes === policy.maxResponseBytes &&
        options.maxBytes === undefined
      ) {
        // Only surfaced when the caller did not deliberately ask for a prefix.
        throw new ResponseBodyTooLargeError(maxBytes);
      }

      const bodyBytes = result.body;
      return {
        status: result.status,
        headers: result.headers,
        body: bodyBytes,
        truncated: result.truncated,
        finalUrl: target.url.toString(),
        finalHost: target.hostname,
        finalIp: result.remoteAddress,
        redirectCount,
        durationMs: Date.now() - startedAt,
        text(): string {
          return Buffer.from(bodyBytes).toString('utf8');
        },
        json<T = unknown>(): T {
          return JSON.parse(Buffer.from(bodyBytes).toString('utf8')) as T;
        },
      };
    }
  };
}
