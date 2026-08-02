# ADR 0004 — SSRF-hardened egress with IP pinning

## Status

Accepted — 2026-08-02

## Context

Auralis fetches URLs that it did not choose. Providers return media URLs from
public archives, RSS feeds and user-configured directory listings; users
configure roots, feed addresses and API endpoints themselves; every one of those
can redirect. That is the textbook shape of a server-side request forgery
target: an authenticated, network-privileged process that will fetch an
attacker-influenced address.

The specific threats:

- Direct requests to loopback, private, link-local, carrier-grade-NAT or
  reserved ranges, including cloud instance metadata at `169.254.169.254`.
- Encoded literals — `http://2130706433/`, `http://0x7f000001/`,
  `http://[::ffff:127.0.0.1]/`, NAT64-wrapped IPv4.
- Redirect chains where hop 1 is public and hop 3 is internal.
- **DNS rebinding**: a hostname that resolves to a public address during
  validation and to an internal address microseconds later when the socket is
  opened.
- Port scanning of non-HTTP services (SMTP, Redis, databases) on public hosts.
- Credential leakage across an origin boundary via redirect.
- Unbounded responses used as a memory-exhaustion vector.

## Decision

One egress path, and connections pinned to the exact IP address that passed
validation.

`net/safe-fetch.ts` `createSafeFetch(policy)` is the only function in the system
that builds an outbound HTTP request, and its docblock lists the guarantees:

> - every URL, including every redirect target, passes the URL safety service
> - connections are pinned to the exact IP that was validated, and the socket's
>   peer address is re-checked after connect (DNS rebinding defence)
> - responses are hard-capped in bytes and wall-clock time
> - credential headers are dropped when a redirect changes host
> - redirect chains are bounded
>
> It deliberately does not support proxies: an HTTP proxy would resolve the
> host itself, which would void the IP-pinning guarantee.

### Validation

`net/url-safety.ts` runs structural checks first (no network needed):
scheme ∈ `{http:, https:}`, length ≤ 2048, no control characters or whitespace,
no embedded credentials, denied hostnames (`localhost`, `metadata`,
`metadata.google.internal`, `instance-data`, …), denied TLDs (`.local`,
`.internal`, `.localdomain`, `.home.arpa`), deny/allow host lists, and a port
allow-list (`80, 443, 8080, 8443, 8000, 3000, 5000` plus configured extras).
Literal addresses — including bare-decimal and hex forms, expanded by
`literalAddressOf` — are classified immediately without DNS.

`assertUrlAllowed` then resolves the host and classifies **every** returned
address with `net/ip-rules.ts` `classifyIp`. If any one is blocked, the whole
host is rejected: _"a host with any internal address is a rebinding risk even if
other addresses look public."_ `ip-rules.ts` implements its own IPv4 and IPv6
parsers so that ambiguous encodings (leading-zero octets, `::ffff:` mapped,
`::` compatible, `64:ff9b::/96` NAT64) are resolved to a canonical form before
classification rather than after.

### Pinning

`performRequest` passes `lookup: pinnedLookup(address, family)` to
`http.request` / `https.request`. The hook ignores the hostname and returns the
pre-validated address, so the socket cannot be pointed elsewhere by a second DNS
answer. `servername` is still set to the hostname, so SNI and certificate
validation stay tied to the name. `agent: false` means no connection reuse and
no redirect handling inside Node — every hop is revalidated by the caller.

Then, belt and braces: on `socket.connect`, `socket.remoteAddress` is
re-classified with `classifyIp` and compared against the pinned address. A
mismatch fails with `connect:address-mismatch`.

### The two bugs this design surfaced

Both are documented in the `pinnedLookup` docblock, because both were
discovered the hard way and both would silently return if the code were
"simplified".

1. **Node calls `lookup` with two different callback shapes.** The modern form
   is `(hostname, options, callback)` where `options.all === true` means the
   callback expects an **array** of `{ address, family }`; the older form is
   `(hostname, callback)` where the callback expects `(err, address, family)`.
   **TLS connections use the array form.** Handle only one shape and every
   `https` request fails.

2. **Answering synchronously breaks error handling.** A real resolver is
   asynchronous. If `pinnedLookup` calls back synchronously, Node connects
   _inside_ `request()` itself — before the caller has had a chance to attach a
   socket `error` listener. A failed connect then surfaces as an unhandled
   `'error'` event and terminates the process. The fix is the `setImmediate`
   wrapper around the callback, and it is load-bearing, not cosmetic.

The related third defence is in the same file: a `socket` handler attaches an
`error` listener immediately, because _"without this, a connect-level failure
(an unreachable address family, for instance) is emitted on the socket with no
listener and takes the whole process down."_

### Other bounds

- `maxRedirects: 4`; `Location` is resolved against the current URL and each hop
  re-enters `assertUrlAllowed`.
- Credential headers (`authorization`, `cookie`, `proxy-authorization`) are
  stripped when the redirect target's host does not match.
- 303, and 302 on a POST, downgrade the method to GET and drop the body.
- Byte caps are enforced on the `data` handler — the allowed prefix is kept and
  the response destroyed — so a server lying about `content-length`, or
  streaming forever, cannot exhaust memory. `PRODUCTION_URL_POLICY` caps at
  2 MiB, `connectTimeoutMs: 5_000`, `totalTimeoutMs: 15_000`; per-call options
  can only narrow these.
- Up to three candidate addresses are tried, IPv4 first, _"many hosts and
  containers have no IPv6 route"_.
- Network-level detail is never surfaced: failures become
  `AuralisError('provider_unavailable', 'That source could not be reached.')`.
- `net/ftp-client.ts` applies the same posture to FTP: the control target goes
  through the URL safety service, and the address in the PASV reply is
  re-classified before the data connection is opened.

### Enforcement

`eslint.config.js` bans `fetch(...)`, `globalThis.fetch`, `axios` and
`node-fetch` everywhere except `packages/core/src/net/**`. Providers never see a
global fetch — they receive `context.fetch: SafeFetchFn`.

`AURALIS_ALLOW_PRIVATE_EGRESS` exists so the bundled fixture origin can be
searched locally, and `loadConfig` refuses to start when it is set together with
`NODE_ENV=production`.

## Consequences

### Positive

- Auralis cannot be pointed at an internal service. That is a property of the
  code, not of a deployment's network policy.
- DNS rebinding is closed on both sides: pinning removes the second resolution,
  and the post-connect peer check catches anything that gets past it.
- Redirect chains cannot smuggle an internal target in at hop 3, and cannot
  carry credentials across an origin boundary.
- The port allow-list stops the fetcher being repurposed as a scanner for
  non-HTTP services on otherwise-legitimate hosts.
- Byte and time caps make hostile responses a bounded cost, which is what lets
  the verification budget be a real budget.
- One code path means one place to audit, one place to test
  (`core/tests/safe-fetch.test.ts`, `core/tests/url-safety.test.ts`), and one
  place to fix.
- Error messages are uniform and non-informative, so the egress layer is not a
  network-topology oracle.

### Negative

- **The egress layer cannot work behind an HTTP proxy.** This is the direct,
  unavoidable cost of pinning. A proxy is told a hostname and resolves it
  itself; the moment that happens, the address Auralis validated is not the
  address the connection reaches, and the guarantee is void. There is no
  `HTTP_PROXY` support and adding it would mean deleting the central property of
  this ADR. Any deployment that requires egress through a corporate proxy cannot
  run Auralis unmodified.
- **The `lookup` hook is deep Node internals.** Both bugs above — the dual
  callback shapes and the synchronous-callback process kill — are the kind of
  thing that reappears on a Node major upgrade, and neither has an obvious
  failure signature. The `setImmediate` and the dual-shape handling look like
  removable complexity to anyone who has not hit them.
- **`agent: false` means no connection pooling.** Every request, including every
  redirect hop and every range probe, opens a fresh TCP (and TLS) connection.
  For a verification that does HEAD + head range + tail range against one host,
  that is three handshakes where one connection would do.
- **DNS is resolved twice per request** — once in `assertUrlAllowed`, once
  nominally by the pinned hook (which answers from memory). The real cost is
  that there is no resolution caching, so a redirect chain resolves each hop.
- **Legitimate hosts get blocked.** A public service whose DNS also returns an
  internal address, a source on port 8081, or an intranet archive a user
  genuinely wants to search — all rejected. The failure is deliberate and the
  message is user-facing ("That link points at a private network address"), but
  it is a real capability the product does not have.
- **Whole-host rejection is coarse.** One bad address in a DNS response rejects
  the host even if the other addresses are fine. That is the correct call for
  rebinding, and it is still a false-positive generator.
- **The IP rules are hand-written and must be maintained.** New reserved ranges,
  new IPv6 transition mechanisms and new metadata-service addresses all need
  code changes in `ip-rules.ts`.
- `AURALIS_ALLOW_PRIVATE_EGRESS` is a real off switch. It is refused in
  production and needed for the fixture origin, but a misconfigured
  non-production environment does disable the address checks.

## Alternatives considered

| Alternative                                                            | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validate the URL, then use plain `fetch`**                           | The gap between validation and connection is exactly the DNS rebinding window. `fetch` resolves the hostname itself, so the address that was checked is not necessarily the address that is reached. This is the single most common way SSRF protection is written and the single most common way it fails.                                                                                                                            |
| **Network-level egress control (firewall, egress gateway, VPC rules)** | Correct as defence in depth, and Auralis should still run behind it. Rejected as _the_ mechanism because it is a property of a deployment, not of the software: a developer laptop, a CI runner and a self-hosted install all have different networks, and the guarantee would evaporate wherever the network was not configured. It also cannot express "drop credentials on cross-origin redirect" or "cap this response at 64 KiB". |
| **An off-the-shelf SSRF-safe HTTP library**                            | The candidates either do not pin (leaving the rebinding window open), do not re-check the peer after connect, or do not give the caller control of redirect revalidation and byte caps. The specific combination here is small enough to own outright, and owning it means the invariant is checkable in one file.                                                                                                                     |
| **Supporting proxies with an allow-list of proxy hosts**               | Moves the trust boundary to the proxy: whatever the proxy resolves, Auralis connects to. That is a coherent design for an environment that already trusts its proxy, but it is a different design from this one, and mixing the two would leave the guarantee conditional on configuration nobody can see from the code.                                                                                                               |
| **A DNS resolver that returns only public addresses**                  | Handles the resolution step but not the connection step, and does nothing about redirects, ports, byte caps or credential stripping.                                                                                                                                                                                                                                                                                                   |
| **Blocking by hostname only**                                          | Trivially bypassed by an attacker who controls DNS for a public name, which is the entire rebinding technique.                                                                                                                                                                                                                                                                                                                         |
