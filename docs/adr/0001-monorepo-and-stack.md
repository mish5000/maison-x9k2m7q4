# ADR 0001 — Monorepo and stack

## Status

Accepted — 2026-08-02

## Context

Auralis has three deliverables that share one domain vocabulary: an engine
(egress, media parsing, providers, orchestration, scoring), an HTTP API, and a
browser client. The vocabulary is large and safety-critical — `AccessDecision`,
`VerificationRecord`, `MediaTechnicalMetadata`, `SearchEvent` — and the whole
product depends on the client and the server agreeing about it exactly.

Two properties were treated as requirements from the start:

- A clean clone must build and run with `npm install && npm run build &&
npm run dev`. No native compilation step, no database server to provision, no
  external media tool to install (see ADRs 0002 and 0003).
- The engine must be independently testable without an HTTP server, and the API
  must be independently testable without a browser.

The engine is unavoidably a Node package: `net/safe-fetch.ts` uses `node:http`
and `node:https`, `net/url-safety.ts` uses `node:dns`, `net/ftp-client.ts` uses
`node:net`, and `cache/keys.ts`, `dedupe/fingerprint.ts` and `util/ids.ts` use
`node:crypto`. None of that can run in a browser.

## Decision

One repository, npm workspaces, three packages, TypeScript project references.

| Package           | Owns                                                                                        | Runtime dependencies                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@auralis/core`   | domain model, egress, media parsers, providers, orchestration, scoring, cache, API contract | `zod`                                                                             |
| `@auralis/server` | Fastify API, SSE, SQLite, connectors, download control, fixture origin                      | `@auralis/core`, `fastify`, `@fastify/{cookie,cors,helmet,static}`, `pino`, `zod` |
| `@auralis/web`    | React 19 client and design system                                                           | `@auralis/core` (types only), `react`, `react-dom`                                |

Supporting choices, all visible in `auralis/package.json` and the per-package
configs:

- `"type": "module"` everywhere; ESM with explicit `.js` specifiers in source.
- `engines.node >= 22.6.0`, which is the floor for `node:sqlite`.
- Root scripts compose the packages in dependency order:
  `build` runs core → server → web; `typecheck` is a single
  `tsc -b packages/core packages/server packages/web`.
- `npm run verify` is the release gate: `format:check && lint && typecheck &&
test && build && e2e`.
- Vitest for unit/contract/integration, Playwright (+ `@axe-core/playwright`)
  for browser journeys.
- ESLint carries two project-specific invariants as lint rules rather than
  conventions: raw `fetch`/`axios`/`node-fetch` are banned outside
  `packages/core/src/net/**`, and `eval`/`Function` are banned outright.

**The web package imports types only from core.** This is the load-bearing part
of the decision. `packages/web/src/api/types.ts` is a wall of `import type` /
`export type`, its docblock states the rule, and the runtime vocabularies the UI
needs are redeclared in `packages/web/src/api/vocabulary.ts`. Type imports are
erased by the compiler, so the browser bundle contains no core code at all while
the contract stays single-sourced.

## Consequences

### Positive

- One definition of every domain type. A change to `SearchResult` breaks
  `tsc -b` for both the server and the client in the same run, before anything
  ships.
- The engine is testable in isolation: `packages/core/tests/` covers access
  classification, safe fetch, URL safety, media probing, query normalisation,
  scoring and a shared provider-contract suite, with no HTTP server involved.
- Atomic cross-cutting changes. Adding a field to the event contract touches
  `domain/events.ts`, the orchestrator, the SSE route and the client reducer in
  one commit, and CI sees all of it together.
- No package publishing, no version negotiation between three components that
  are always deployed together.
- The `no-raw-fetch` lint rule can be scoped to a directory precisely because
  the directory layout is fixed by the monorepo.

### Negative

- `tsc -b` across three projects is the slowest step in the loop, and project
  references mean a stale `dist/` in `core` produces confusing errors downstream
  until it is rebuilt.
- The types-only rule is a convention the compiler enforces only accidentally.
  A single `import { something }` (value import) from `@auralis/core` in
  `packages/web` would compile and then fail at bundle time with a `node:dns`
  resolution error. There is no lint rule that catches it today — the guard is
  the docblock in `api/types.ts` and code review.
- `vocabulary.ts` duplicates constant lists that also exist in
  `packages/core/src/domain/`. They can drift; nothing checks that they have not.
- Everything shares one dependency tree and one `package-lock.json`, so an
  incompatible transitive upgrade blocks all three packages at once.
- One repository means one release cadence. The client cannot ship a fix without
  rebuilding the engine.

## Alternatives considered

| Alternative                                                 | Why rejected                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Three separate repositories with published packages**     | The domain contract changes constantly during development. Every change would become a publish-and-bump cycle across three repos, and the window where the client and server disagree about `AccessDecision` is exactly the window where a security-relevant type drifts.                  |
| **A single package with directory boundaries**              | Nothing would stop `packages/web` importing `node:dns` transitively, and the "engine has no HTTP dependency" property would be unenforceable. The workspace boundary is what makes `@auralis/core`'s single `zod` dependency a checkable fact.                                             |
| **Nx / Turborepo / Bazel**                                  | Three packages and a linear build order do not need a build graph tool. `npm run build` chaining three `tsc -b` invocations is comprehensible with no additional configuration language to learn or cache to invalidate.                                                                   |
| **Duplicating the domain types by hand in the client**      | This is what the types-only rule avoids. Hand-copied types drift silently and the drift surfaces as a runtime shape mismatch in the browser, which is the worst place to find it.                                                                                                          |
| **A shared `@auralis/contract` package holding only types** | Would work, and would make the types-only rule structural rather than conventional. Rejected as premature: it adds a fourth package and a fourth build step to solve a problem currently solved by one docblock. Worth revisiting if a value import ever does slip into the client bundle. |
| **Deno or Bun instead of Node**                             | `node:sqlite` (ADR 0002) and the `lookup`-hook-based IP pinning in `net/safe-fetch.ts` (ADR 0004) are both Node-specific. Neither has an equivalent with the same guarantees on another runtime.                                                                                           |
