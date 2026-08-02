---
description: Rules for any code that makes an outbound network request.
globs: ['auralis/packages/**/*.ts']
---

# Network egress

**There is exactly one way out of this process.** Every outbound HTTP request is
built by `createSafeFetch` in `auralis/packages/core/src/net/safe-fetch.ts`.

## Never

- `fetch(...)`, `globalThis.fetch`, `axios`, `node-fetch`, `got`, `undici`
- `http.request` / `https.request` / `net.connect` outside `packages/core/src/net/`
- Any URL built from user or provider input that has not passed
  `assertUrlAllowed`

The `no-restricted-syntax` ESLint rule and `.claude/hooks/network-guard.sh`
both reject these. If you find yourself disabling either, stop and reconsider.

## In a provider adapter

Use `context.fetch`. It is already bound to the active policy. Never capture a
fetch from module scope, and never construct your own.

```ts
const response = await context.fetch(url, {
  signal,
  timeoutMs: Math.min(msRemaining(context), this.capabilities.timeoutMs),
  maxBytes: 1024 * 1024,
});
```

Always pass `signal`, always pass a `timeoutMs` bounded by the context deadline,
and always pass a `maxBytes` appropriate to what you expect back.

## Adding an allowed host

Hosts are allowed by policy, not by code. Widen `UrlSafetyPolicy.allowHosts`
through configuration. A non-standard port needs `additionalPorts` — do not edit
`ALLOWED_PORTS`.

## Guarantees you can rely on

- Redirects are followed manually and every hop is revalidated
- Credential headers are dropped when a redirect changes host
- Connections are pinned to the validated IP and the peer is re-checked
- Bytes and wall-clock time are hard-capped
- Cancellation propagates

## Guarantees you must not break

- The pinned `lookup` callback must stay asynchronous. Answering synchronously
  makes Node connect inside `request()` before a socket error listener exists,
  and an unhandled socket error terminates the process.
- The `lookup` callback must handle both the `all: true` array shape and the
  single-address shape. TLS uses the array form.
