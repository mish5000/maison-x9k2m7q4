/**
 * IP range classification used by the URL safety service.
 *
 * SECURITY INVARIANT: every IP address Auralis connects to is checked here,
 * both before connecting and at socket-connect time (see safe-fetch.ts), so a
 * DNS record that changes between resolution and connection cannot be used to
 * reach an internal address.
 */

export type IpDisposition = 'public' | 'blocked';

export interface IpVerdict {
  readonly disposition: IpDisposition;
  /** Identifier of the rule that matched, e.g. `ipv4:link-local`. */
  readonly rule: string;
}

const PUBLIC_VERDICT: IpVerdict = Object.freeze({ disposition: 'public', rule: 'ipv4:public' });
const PUBLIC_V6_VERDICT: IpVerdict = Object.freeze({ disposition: 'public', rule: 'ipv6:public' });

function blocked(rule: string): IpVerdict {
  return { disposition: 'blocked', rule };
}

export function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    // Reject octal-ish and other ambiguous encodings outright.
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function parseHexGroups(text: string): number[] | null {
  if (text.length === 0) return [];
  const out: number[] = [];
  for (const group of text.split(':')) {
    if (group.length === 0 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

/** Expands an IPv6 string into 8 16-bit groups, or null when malformed. */
export function parseIpv6(value: string): readonly number[] | null {
  let text = value;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zoneIndex = text.indexOf('%');
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  if (text.length === 0 || !text.includes(':')) return null;

  // Rewrite a trailing dotted-quad (e.g. ::ffff:127.0.0.1) into two hex groups
  // so the rest of the parser only ever deals with the hexadecimal form.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const head = parseHexGroups(halves[0] ?? '');
    const tail = parseHexGroups(halves[1] ?? '');
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }

  const groups = parseHexGroups(text);
  if (!groups || groups.length !== 8) return null;
  return groups;
}

export function classifyIpv4(value: string): IpVerdict {
  const o = parseIpv4(value);
  if (!o) return blocked('ipv4:malformed');
  const [a = 0, b = 0, c = 0] = o;

  if (a === 0) return blocked('ipv4:this-network');
  if (a === 10) return blocked('ipv4:private-10/8');
  if (a === 127) return blocked('ipv4:loopback');
  // Cloud instance metadata services live inside link-local; named separately
  // because it is the range that matters most in an SSRF report.
  if (a === 169 && b === 254 && c === 169) return blocked('ipv4:metadata-service');
  if (a === 169 && b === 254) return blocked('ipv4:link-local');
  if (a === 172 && b >= 16 && b <= 31) return blocked('ipv4:private-172.16/12');
  if (a === 192 && b === 0 && c === 0) return blocked('ipv4:ietf-protocol');
  if (a === 192 && b === 0 && c === 2) return blocked('ipv4:documentation');
  if (a === 192 && b === 168) return blocked('ipv4:private-192.168/16');
  if (a === 198 && (b === 18 || b === 19)) return blocked('ipv4:benchmarking');
  if (a === 198 && b === 51 && c === 100) return blocked('ipv4:documentation');
  if (a === 203 && b === 0 && c === 113) return blocked('ipv4:documentation');
  if (a === 100 && b >= 64 && b <= 127) return blocked('ipv4:carrier-grade-nat');
  if (a >= 224 && a <= 239) return blocked('ipv4:multicast');
  if (a >= 240) return blocked('ipv4:reserved');

  return PUBLIC_VERDICT;
}

export function classifyIpv6(value: string): IpVerdict {
  const g = parseIpv6(value);
  if (!g) return blocked('ipv6:malformed');
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;

  const isAllZeroExceptLast = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;

  if (isAllZeroExceptLast && g6 === 0 && g7 === 0) return blocked('ipv6:unspecified');
  if (isAllZeroExceptLast && g6 === 0 && g7 === 1) return blocked('ipv6:loopback');

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses inherit v4 rules.
  if (isAllZeroExceptLast) {
    const asV4 = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join('.');
    const v4 = classifyIpv4(asV4);
    if (v4.disposition === 'blocked') return blocked(`ipv6:v4-compatible/${v4.rule}`);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const asV4 = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join('.');
    const v4 = classifyIpv4(asV4);
    if (v4.disposition === 'blocked') return blocked(`ipv6:v4-mapped/${v4.rule}`);
    return PUBLIC_V6_VERDICT;
  }
  // NAT64 well-known prefix 64:ff9b::/96 also wraps IPv4.
  if (g0 === 0x64 && g1 === 0xff9b) {
    const asV4 = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join('.');
    const v4 = classifyIpv4(asV4);
    if (v4.disposition === 'blocked') return blocked(`ipv6:nat64/${v4.rule}`);
  }

  if ((g0 & 0xfe00) === 0xfc00) return blocked('ipv6:unique-local');
  if ((g0 & 0xffc0) === 0xfe80) return blocked('ipv6:link-local');
  if ((g0 & 0xff00) === 0xff00) return blocked('ipv6:multicast');
  if (g0 === 0x2001 && g1 === 0x0db8) return blocked('ipv6:documentation');
  if (g0 === 0x2001 && (g1 & 0xff00) === 0x0000) return blocked('ipv6:ietf-protocol');
  if (g0 === 0x0100 && g1 === 0) return blocked('ipv6:discard-only');

  return PUBLIC_V6_VERDICT;
}

/** Classify a literal IP address of either family. */
export function classifyIp(value: string): IpVerdict {
  if (value.includes(':')) return classifyIpv6(value);
  return classifyIpv4(value);
}

export function isPublicIp(value: string): boolean {
  return classifyIp(value).disposition === 'public';
}
