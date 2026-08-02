---
description: The contract every source adapter must satisfy.
globs: ['auralis/packages/core/src/providers/**/*.ts']
---

# Provider adapters

An adapter turns a source into a stream of `RawSearchCandidate`. That is all it
does.

## The contract

```ts
interface SearchProvider {
  id: string; // lowercase-hyphenated, unique
  displayName: string;
  capabilities: ProviderCapabilities;
  search(query, context, signal): AsyncIterable<RawSearchCandidate>;
  healthCheck(context): Promise<ProviderHealth>;
}
```

## Obligations

- **Stream.** `yield` each candidate as you find it. Do not collect and return
  at the end — the interface shows results as they arrive.
- **Stop.** Check `signal.aborted` and `msRemaining(context)` in every loop.
- **Stay inside the budget.** Never emit more than `context.maxCandidates`.
- **Use `context.fetch`.** See `network-egress.md`.
- **Build candidates with `buildCandidate`.** It sanitises every string. Source
  output is untrusted and ends up rendered in a browser.
- **Declare honestly.** `declaredAccess` is a conservative starting point, not a
  wish. If you have no media URL, do not declare `direct_download`.
- **Never fabricate a URL.** If the source does not publish a per-file address,
  emit `mediaUrl: null` and let the access classifier do its job.
- **Fail quietly.** A malformed response yields nothing. Log at `warn` with a
  reason code; never throw a raw upstream error at the orchestrator.

## Forbidden

- Making access decisions (that is `classifyAccess`, and only it)
- Verifying media (that is `verifyCandidate`)
- Reading or writing credentials directly (they arrive in `context.config`)
- Any network I/O outside `context.fetch`
- Caching anything itself

## Capabilities

Declare every field truthfully; the orchestrator relies on them.

`requiresAuthentication: true` **requires** `producesPrivateResults: true`.
Otherwise the results could be written to a shared cache key. The contract suite
asserts this.

## Registration

Add the provider to `createDefaultRegistry` in `providers/index.ts` with its
`setupDocPath` and `secretConfigKeys`. An adapter that is not registered is not
reachable, and one registered without a setup document fails the contract suite.

## Tests

Every adapter runs the same battery in
`packages/core/tests/provider-contract.test.ts`: valid query, empty result,
malformed response, rate limit, authentication failure, cancellation, deadline,
health check, candidate cap. Add a mock shape to the contract server if your
adapter needs one — never let the suite reach a real service.
