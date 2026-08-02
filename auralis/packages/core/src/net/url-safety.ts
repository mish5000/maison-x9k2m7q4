import { promises as dnsPromises } from 'node:dns';

import { AuralisError } from '../domain/errors.js';
import { classifyIp } from './ip-rules.js';

/**
 * The single approved URL-safety service.
 *
 * SECURITY INVARIANT: no other module in Auralis is permitted to build an
 * outbound request from a URL that has not passed through `assertUrlAllowed`.
 * The `no-raw-fetch` lint rule and the `network-guard` hook enforce this.
 */

export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

export interface UrlSafetyPolicy {
  /** Only these hosts may be contacted. Empty means "any public host". */
  readonly allowHosts: readonly string[];
  /** Hosts that are never contacted, even if otherwise public. */
  readonly denyHosts: readonly string[];
  /** Permit plain http. Off by default; enabled for local fixtures and dev. */
  readonly allowInsecureHttp: boolean;
  /**
   * Permit connections to private/loopback ranges. Enabled ONLY for the
   * bundled fixture origin in development and tests, never in production.
   */
  readonly allowPrivateAddresses: boolean;
  /**
   * Extra TCP ports permitted beyond the default HTTP set. Used so a locally
   * bound fixture or a source on a non-standard port can be reached without
   * widening the default policy for everything else.
   */
  readonly additionalPorts: readonly number[];
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export const PRODUCTION_URL_POLICY: UrlSafetyPolicy = Object.freeze({
  allowHosts: Object.freeze([] as const),
  denyHosts: Object.freeze([] as const),
  allowInsecureHttp: false,
  allowPrivateAddresses: false,
  additionalPorts: Object.freeze([] as const),
  maxRedirects: 4,
  maxResponseBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
});

export interface ResolvedTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  /** Addresses that passed classification. Connections are pinned to these. */
  readonly addresses: readonly ResolvedAddress[];
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Hostnames that resolve to the local machine by definition. */
const ALWAYS_DENIED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // Cloud metadata service names.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** TLDs reserved for private/internal use that must never be resolved. */
const DENIED_TLDS: readonly string[] = ['.local', '.internal', '.localdomain', '.home.arpa'];

export interface UrlSafetyFailure {
  readonly rule: string;
  readonly message: string;
}

export class UnsafeUrlError extends AuralisError {
  readonly rule: string;

  constructor(failure: UrlSafetyFailure) {
    super('unsafe_url', failure.message, { details: { rule: failure.rule } });
    this.name = 'UnsafeUrlError';
    this.rule = failure.rule;
  }
}

function fail(rule: string, message: string): never {
  throw new UnsafeUrlError({ rule, message });
}

/** Structural checks that need no network access. Safe to run on user input. */
export function assertUrlStructurallySafe(rawUrl: string, policy: UrlSafetyPolicy): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    fail('url:empty', 'That link is not a valid web address.');
  }
  if (rawUrl.length > 2048) {
    fail('url:too-long', 'That link is too long to be processed.');
  }
  // Control characters and whitespace are how header and redirect injection starts.
  // eslint-disable-next-line no-control-regex -- matching control bytes is the point
  if (/[\u0000-\u0020\u007f-\u009f]/.test(rawUrl)) {
    fail('url:control-characters', 'That link contains characters that are not allowed.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail('url:unparseable', 'That link is not a valid web address.');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    fail('url:scheme', `Links using ${url.protocol.replace(':', '')} are not supported.`);
  }
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) {
    fail('url:insecure-scheme', 'Only secure https links can be opened.');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    fail('url:embedded-credentials', 'Links containing credentials are not accepted.');
  }

  const hostname = normaliseHostname(url.hostname);
  if (hostname.length === 0) fail('url:no-host', 'That link has no host name.');
  if (ALWAYS_DENIED_HOSTNAMES.has(hostname)) {
    fail('url:denied-hostname', 'That link points at this machine and cannot be opened.');
  }
  for (const tld of DENIED_TLDS) {
    if (hostname.endsWith(tld)) {
      fail('url:denied-tld', 'That link points at a private network name and cannot be opened.');
    }
  }

  // A literal IP in the URL is classified immediately — no DNS involved.
  const literal = literalAddressOf(hostname);
  if (literal && !policy.allowPrivateAddresses) {
    const verdict = classifyIp(literal);
    if (verdict.disposition === 'blocked') {
      fail(`ip:${verdict.rule}`, 'That link points at a private network address.');
    }
  }

  if (policy.denyHosts.some((h) => hostMatches(hostname, h))) {
    fail('url:deny-list', 'That source is not available.');
  }
  if (policy.allowHosts.length > 0 && !policy.allowHosts.some((h) => hostMatches(hostname, h))) {
    fail('url:not-in-allow-list', 'That source is outside the configured search scope.');
  }

  const port = effectivePort(url);
  if (!isAllowedPort(port, policy.additionalPorts)) {
    fail('url:port', 'That link uses a network port that is not allowed.');
  }

  return url;
}

/** Full check: structure, then DNS resolution with per-address classification. */
export async function assertUrlAllowed(
  rawUrl: string,
  policy: UrlSafetyPolicy,
  resolver: DnsResolver = defaultResolver,
): Promise<ResolvedTarget> {
  const url = assertUrlStructurallySafe(rawUrl, policy);
  const hostname = normaliseHostname(url.hostname);
  const port = effectivePort(url);

  const literal = literalAddressOf(hostname);
  if (literal) {
    return {
      url,
      hostname,
      port,
      addresses: [{ address: literal, family: literal.includes(':') ? 6 : 4 }],
    };
  }

  let records: readonly ResolvedAddress[];
  try {
    records = await resolver(hostname);
  } catch {
    return fail('dns:resolution-failed', 'That source could not be reached.');
  }

  if (records.length === 0) fail('dns:no-records', 'That source could not be reached.');

  if (!policy.allowPrivateAddresses) {
    for (const record of records) {
      const verdict = classifyIp(record.address);
      if (verdict.disposition === 'blocked') {
        // Reject the whole host: a host with any internal address is a
        // rebinding risk even if other addresses look public.
        fail(`ip:${verdict.rule}`, 'That link resolves to a private network address.');
      }
    }
  }

  return { url, hostname, port, addresses: records };
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const defaultResolver: DnsResolver = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export function normaliseHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // A single trailing dot is the DNS root and is equivalent to its absence.
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export function literalAddressOf(hostname: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  if (hostname.includes(':')) return hostname;
  // Bare decimal / hex forms such as http://2130706433/ are IP literals too.
  if (/^\d+$/.test(hostname)) {
    const n = Number(hostname);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
    }
  }
  if (/^0x[0-9a-f]+$/.test(hostname)) {
    const n = Number.parseInt(hostname, 16);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
    }
  }
  return null;
}

export function effectivePort(url: URL): number {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Ports Auralis will talk to. Restricting this stops the fetcher being used to
 * probe non-HTTP services (SMTP, Redis, databases) on otherwise public hosts.
 */
const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443, 8000, 3000, 5000]);

export function isAllowedPort(port: number, additional: readonly number[] = []): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return ALLOWED_PORTS.has(port) || additional.includes(port);
}

/** Host match supporting a single leading `*.` wildcard. */
export function hostMatches(hostname: string, pattern: string): boolean {
  const p = normaliseHostname(pattern);
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // keeps the leading dot
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === p;
}

/** Registrable-ish host for display. Not a public-suffix implementation. */
export function displayHost(hostname: string): string {
  const normalised = normaliseHostname(hostname);
  // An address literal has no registrable part; shortening it would be wrong
  // and misleading (127.0.0.1 must never be shown as "0.1").
  if (literalAddressOf(normalised) !== null) return normalised;
  const parts = normalised.split('.');
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}
