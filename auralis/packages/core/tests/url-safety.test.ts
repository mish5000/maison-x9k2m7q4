import { describe, expect, it } from 'vitest';

import {
  assertUrlAllowed,
  assertUrlStructurallySafe,
  classifyIp,
  displayHost,
  hostMatches,
  isAllowedPort,
  literalAddressOf,
  parseIpv6,
  PRODUCTION_URL_POLICY,
  UnsafeUrlError,
  type DnsResolver,
} from '../src/index.js';

const policy = PRODUCTION_URL_POLICY;

describe('IP classification', () => {
  it.each([
    ['127.0.0.1', 'ipv4:loopback'],
    ['127.1.2.3', 'ipv4:loopback'],
    ['10.0.0.1', 'ipv4:private-10/8'],
    ['172.16.0.1', 'ipv4:private-172.16/12'],
    ['172.31.255.255', 'ipv4:private-172.16/12'],
    ['192.168.1.1', 'ipv4:private-192.168/16'],
    ['169.254.169.254', 'ipv4:metadata-service'],
    ['169.254.1.1', 'ipv4:link-local'],
    ['0.0.0.0', 'ipv4:this-network'],
    ['100.64.0.1', 'ipv4:carrier-grade-nat'],
    ['224.0.0.1', 'ipv4:multicast'],
    ['255.255.255.255', 'ipv4:reserved'],
    ['198.18.0.1', 'ipv4:benchmarking'],
  ])('blocks %s as %s', (address, rule) => {
    const verdict = classifyIp(address);
    expect(verdict.disposition).toBe('blocked');
    expect(verdict.rule).toBe(rule);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['93.184.216.34'], ['207.241.224.2']])(
    'permits the public address %s',
    (address) => {
      expect(classifyIp(address).disposition).toBe('public');
    },
  );

  it('rejects octal-looking octets rather than guessing their meaning', () => {
    expect(classifyIp('010.0.0.1').disposition).toBe('blocked');
    expect(classifyIp('0177.0.0.1').rule).toBe('ipv4:malformed');
  });

  it('blocks IPv6 loopback, link-local and unique-local ranges', () => {
    expect(classifyIp('::1').rule).toBe('ipv6:loopback');
    expect(classifyIp('fe80::1').rule).toBe('ipv6:link-local');
    expect(classifyIp('fc00::1').rule).toBe('ipv6:unique-local');
    expect(classifyIp('fd12:3456::1').rule).toBe('ipv6:unique-local');
    expect(classifyIp('ff02::1').rule).toBe('ipv6:multicast');
  });

  it('sees through IPv4-mapped IPv6 addresses', () => {
    expect(classifyIp('::ffff:127.0.0.1').rule).toBe('ipv6:v4-mapped/ipv4:loopback');
    expect(classifyIp('::ffff:169.254.169.254').rule).toBe('ipv6:v4-mapped/ipv4:metadata-service');
    expect(classifyIp('::ffff:8.8.8.8').disposition).toBe('public');
  });

  it('sees through NAT64-prefixed addresses', () => {
    expect(classifyIp('64:ff9b::7f00:1').rule).toContain('nat64');
  });

  it('parses IPv6 forms correctly', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('gggg::1')).toBeNull();
  });
});

describe('structural URL validation', () => {
  it('rejects non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com',
      'ftp://example.com',
      'javascript:alert(1)',
    ]) {
      expect(() => assertUrlStructurallySafe(url, policy)).toThrow(UnsafeUrlError);
    }
  });

  it('rejects plain http unless the policy allows it', () => {
    expect(() => assertUrlStructurallySafe('http://example.com/a.mp3', policy)).toThrow(
      UnsafeUrlError,
    );
    expect(() =>
      assertUrlStructurallySafe('http://example.com/a.mp3', { ...policy, allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it('rejects embedded credentials', () => {
    expect(() => assertUrlStructurallySafe('https://user:pass@example.com/a.mp3', policy)).toThrow(
      /credentials/i,
    );
  });

  it('rejects hostnames that name this machine', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'metadata.google.internal',
      'foo.local',
      'bar.internal',
    ]) {
      expect(() => assertUrlStructurallySafe(`https://${host}/a.mp3`, policy)).toThrow(
        UnsafeUrlError,
      );
    }
  });

  it('rejects control characters used for request smuggling', () => {
    expect(() => assertUrlStructurallySafe('https://example.com/a\r\nHost: evil', policy)).toThrow(
      UnsafeUrlError,
    );
  });

  it('resolves alternative IP literal encodings before classifying them', () => {
    expect(literalAddressOf('2130706433')).toBe('127.0.0.1');
    expect(literalAddressOf('0x7f000001')).toBe('127.0.0.1');
    expect(() => assertUrlStructurallySafe('https://2130706433/a.mp3', policy)).toThrow(
      UnsafeUrlError,
    );
    expect(() => assertUrlStructurallySafe('https://0x7f000001/a.mp3', policy)).toThrow(
      UnsafeUrlError,
    );
  });

  it('ignores a trailing DNS root dot when matching denied hosts', () => {
    expect(() => assertUrlStructurallySafe('https://localhost./a.mp3', policy)).toThrow(
      UnsafeUrlError,
    );
  });

  it('restricts ports to the HTTP set plus explicit additions', () => {
    expect(isAllowedPort(443)).toBe(true);
    expect(isAllowedPort(6379)).toBe(false);
    expect(isAllowedPort(6379, [6379])).toBe(true);
    expect(() => assertUrlStructurallySafe('https://example.com:6379/a.mp3', policy)).toThrow(
      /network port/i,
    );
    expect(() =>
      assertUrlStructurallySafe('https://example.com:6379/a.mp3', {
        ...policy,
        additionalPorts: [6379],
      }),
    ).not.toThrow();
  });

  it('enforces allow and deny lists', () => {
    const restricted = { ...policy, allowHosts: ['archive.org', '*.example.com'] };
    expect(() => assertUrlStructurallySafe('https://archive.org/a.mp3', restricted)).not.toThrow();
    expect(() =>
      assertUrlStructurallySafe('https://cdn.example.com/a.mp3', restricted),
    ).not.toThrow();
    expect(() => assertUrlStructurallySafe('https://elsewhere.org/a.mp3', restricted)).toThrow(
      /outside the configured search scope/i,
    );

    const denied = { ...policy, denyHosts: ['blocked.example'] };
    expect(() => assertUrlStructurallySafe('https://blocked.example/a.mp3', denied)).toThrow(
      UnsafeUrlError,
    );
  });

  it('shortens a domain for display but never an address literal', () => {
    expect(displayHost('download.archive.org')).toBe('archive.org');
    expect(displayHost('archive.org')).toBe('archive.org');
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('192.168.10.20')).toBe('192.168.10.20');
    expect(displayHost('::1')).toBe('::1');
  });

  it('matches wildcard host patterns without matching the bare domain', () => {
    expect(hostMatches('cdn.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
  });
});

describe('DNS-aware URL validation', () => {
  const resolverReturning =
    (addresses: string[]): DnsResolver =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('rejects a host that resolves to a private address', async () => {
    await expect(
      assertUrlAllowed('https://rebind.example/a.mp3', policy, resolverReturning(['192.168.0.5'])),
    ).rejects.toThrow(/private network address/i);
  });

  it('rejects a host with any internal address, even alongside public ones', async () => {
    await expect(
      assertUrlAllowed(
        'https://mixed.example/a.mp3',
        policy,
        resolverReturning(['8.8.8.8', '127.0.0.1']),
      ),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it('rejects a host that resolves to the cloud metadata service', async () => {
    await expect(
      assertUrlAllowed('https://meta.example/a', policy, resolverReturning(['169.254.169.254'])),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it('returns the validated addresses so the connection can be pinned', async () => {
    const target = await assertUrlAllowed(
      'https://good.example/a.mp3',
      policy,
      resolverReturning(['93.184.216.34']),
    );
    expect(target.hostname).toBe('good.example');
    expect(target.port).toBe(443);
    expect(target.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('reports resolution failure without leaking the DNS error', async () => {
    const failing: DnsResolver = async () => {
      throw new Error('ENOTFOUND internal-detail');
    };
    await expect(assertUrlAllowed('https://nope.example/a', policy, failing)).rejects.toThrow(
      /could not be reached/i,
    );
  });
});
