---
name: add-provider
description: Add a new source adapter to Auralis. Use when asked to support a new archive, API, feed, directory, or storage service as a searchable source.
---

# Adding a provider

## 0. Check it belongs

Read `docs/security/source-access-policy.md` first. A source qualifies only if
it is publicly published or explicitly connected by the user, can be searched
without guessing identifiers, and permits programmatic access. If a source only
becomes searchable by working around a control it puts in the way, stop here.

## 1. Write the adapter

`auralis/packages/core/src/providers/<id>.ts`

```ts
export class MyProvider implements SearchProvider {
  readonly id = 'my-provider';
  readonly displayName = 'My Provider';
  readonly capabilities = capabilities({/* declare honestly */});

  async *search(query, context, signal): AsyncIterable<RawSearchCandidate> {}
  async healthCheck(context): Promise<ProviderHealth> {}
}
```

Follow `.claude/rules/provider-adapters.md`. In particular: stream candidates,
honour `signal` and `context.deadlineMs`, use `context.fetch` only, build every
candidate with `buildCandidate`, and never fabricate a media URL.

Declare `requiredConfiguration` for anything the adapter cannot run without.
If `requiresAuthentication` is true, `producesPrivateResults` must also be true.

## 2. Register it

In `providers/index.ts`, inside `createDefaultRegistry`:

```ts
registry.register({
  provider: new MyProvider(),
  setupDocPath: 'docs/providers/my-provider.md',
  secretConfigKeys: ['apiKey'],
  enabledByDefault: false,
});
```

Export the module from the same file so its types are available.

## 3. If it takes credentials

- Add the kind to `connectorKindSchema` in `core/src/api/contract.ts`
- Map kind → provider id in `server/src/db/connectors.ts`
  (`CONNECTOR_PROVIDER_BY_KIND`), and add a scope description and an identity
  key there too
- List every secret key in `secretConfigKeys` so it is encrypted at rest

## 4. Add mock shapes to the contract suite

`packages/core/tests/provider-contract.test.ts` runs every adapter against one
local mock server, and rewrites all outbound requests onto it so no test ever
reaches a real service. Add a branch to the mock for your adapter's response
shape, and an entry to `configForProvider`.

The suite then runs automatically: valid query, empty result, malformed
response, rate limit, authentication failure, cancellation, deadline, health
check, candidate cap, capability coherence.

## 5. Write the documentation

`docs/providers/<id>.md`, following the structure of the existing pages: what it
searches, status, configuration table (marking secrets), setup steps, declared
capabilities, access classification, limits and caveats, troubleshooting.

Add a row to the table in `docs/providers/README.md`.

## 6. Optionally add a live test

`packages/core/tests/live/providers.live.test.ts`. This suite is opt-in and must
never be added to the default run.

## 7. Verify

```bash
cd auralis
npm run typecheck
npm test                # the contract suite must pass for the new adapter
npm run lint
```

## Done when

- [ ] The adapter streams and cancels promptly
- [ ] Capabilities are declared truthfully
- [ ] It is registered with a setup doc path
- [ ] Secret keys are listed and therefore encrypted
- [ ] The contract suite passes with no real network access
- [ ] The provider page exists and the index lists it
