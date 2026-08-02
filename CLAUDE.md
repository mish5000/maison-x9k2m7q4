# Auralis — project instructions

## Mission

Auralis is a universal audio discovery engine: **find the sound, verify the file**. It searches
sources the operator is permitted to search, then — before showing a result — inspects the actual
bytes to establish what the file really is (format, codec, bitrate, duration, integrity), what may
legally and technically be done with it, and how it compares with every other copy found.

The product promise is honesty. A result card never claims more than the evidence supports. When
Auralis does not know something, it says so.

## Two applications live in this repository

| Path                                                                                                                      | What it is                                                                    | Rules                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `auralis/`                                                                                                                | The Auralis monorepo (npm workspaces). Everything in this file applies to it. | Active development.                                                                                              |
| Repo root: `index.html`, `sw.js`, `assets/`, `dishes.json`, `lineups.json`, `manifest.json`, `version.json`, `icon-*.png` | **PRIVÉE** — an unrelated, self-contained static PWA.                         | **Preserved. Never edit, move, reformat or lint these.** They are not part of Auralis and share no code with it. |

Nothing under `auralis/` imports from the PRIVÉE files, and nothing in PRIVÉE imports from Auralis.
If a tool wants to "clean up" the root files, the tool is wrong.

The root `README.md` belongs to neither application — it is the index that points at both, and it is
the only root file that may be edited. `CLAUDE.md`, `.claude/` and `docs/` are Auralis's.

## Source-access boundaries

Auralis searches **openly published, licensed, user-owned and explicitly connected** sources only.
It is not a piracy tool and must never become one.

Permitted, in summary: public archives and open-data collections; podcast and RSS feeds; documented
audio APIs; public HTTP/FTP directory listings; the user's own local directories; storage the user
has explicitly connected (S3-compatible, WebDAV, custom JSON APIs); an organisation's own repository.

Prohibited, in summary: circumventing DRM, paywalls, authentication or geo-restriction; stream-ripping
subscription services; torrent/DHT indexes and cyberlocker aggregators; scraping sources whose terms
forbid it. **Read `docs/security/source-access-policy.md` before adding any provider** — it is the
definitive list plus the eight access classifications.

## Architectural map

| Package / module                  | Responsibility                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@auralis/core` `domain/`         | Pure types and vocabularies. No I/O, no logic that can fail.                                                |
| `@auralis/core` `net/`            | The **only** outbound HTTP path: URL safety, IP classification, `createSafeFetch`.                          |
| `@auralis/core` `media/`          | In-house pure parsers (MP3, FLAC, RIFF/WAVE, AIFF, MP4/M4A/ALAC, Ogg, ID3, Vorbis comments) + `probeMedia`. |
| `@auralis/core` `access/`         | `classifyAccess` — the sole authority on whether a download may be offered.                                 |
| `@auralis/core` `compat/`         | Versioned device profiles (data) and the single compatibility evaluator (logic).                            |
| `@auralis/core` `dedupe/`         | Progressive fingerprinting and incremental duplicate grouping.                                              |
| `@auralis/core` `scoring/`        | Transparent quality, relevance and ranking scores with published breakdowns.                                |
| `@auralis/core` `query/`          | Query normalisation, operator parsing, bounded variant generation.                                          |
| `@auralis/core` `cache/`          | `CacheStore` interface, bounded in-process LRU, scope-safe key construction.                                |
| `@auralis/core` `observability/`  | Redacting logger and privacy-safe metrics.                                                                  |
| `@auralis/core` `orchestrate/`    | Circuit breakers, budgets, the search pipeline, verification.                                               |
| `@auralis/core` `providers/`      | Source adapters + registry. Adapters implement `SearchProvider` and nothing else.                           |
| `@auralis/core` `api/contract.ts` | Zod schemas — one source of truth for server validation and client types.                                   |
| `@auralis/server`                 | Fastify HTTP layer, SSE event stream, SQLite persistence, connector storage, download-intent enforcement.   |
| `@auralis/web`                    | React 19 + Vite client. Progressive result rendering, accessibility, design tokens.                         |

Dependency direction is one-way: `web → core`, `server → core`. Core never imports from server or web.

## Commands

All commands run from `auralis/`.

```sh
cd auralis && npm run build            # build core, then server, then web
cd auralis && npm run dev              # node scripts/dev.mjs
cd auralis && npm run start            # node --experimental-sqlite packages/server/dist/main.js
cd auralis && npm run fixtures:serve   # local fixture origin for offline tests
cd auralis && npm run db:migrate       # apply SQLite migrations
cd auralis && npm run typecheck        # tsc -b packages/core packages/server packages/web
cd auralis && npm run lint             # eslint .
cd auralis && npm run lint:fix
cd auralis && npm run format           # prettier --write
cd auralis && npm run format:check
cd auralis && npm run test             # vitest run
cd auralis && npm run test:watch
cd auralis && npm run test:live        # network-touching tests, opt-in
cd auralis && npm run e2e              # playwright test
cd auralis && npm run e2e:install      # playwright install chromium
cd auralis && npm run audit            # npm audit --omit=dev --audit-level=high
cd auralis && npm run verify           # format:check → lint → typecheck → test → build → e2e
```

`npm run verify` is the release gate. It is the command referenced everywhere below.

## Definition of done

A change is done when **all** of these hold:

1. `cd auralis && npm run verify` passes from a clean clone.
2. New behaviour has tests; new failure modes have tests that assert the failure.
3. Anything touching network, credentials, connectors or downloads has passed the security review
   checklist (`.claude/skills/security-review/SKILL.md`).
4. Docs that describe the changed behaviour are updated in the same change.
5. No new dependency was added without a recorded reason.
6. No `TODO`, no commented-out code, no `console.log`, no `any` escape hatches.

## Coding standards

- Node >= 22.6. TypeScript strict, ESM only, `verbatimModuleSyntax` — use `import type` for types.
- Relative imports carry the `.js` extension (`NodeNext` resolution). No path aliases in core.
- `noUncheckedIndexedAccess` is on: indexed reads are `T | undefined`. Handle it; do not assert.
- Prefer `readonly` fields and `ReadonlySet`/`ReadonlyMap` on anything crossing a module boundary.
- Errors crossing the API boundary are `AuralisError` with an `ErrorCode`. Raw messages and stack
  traces never reach a client.
- Public-facing strings are plain, non-technical sentences. Internal diagnostics go in `evidence[]`
  or `firedRules[]` arrays, never in user copy.
- Data and logic are separated: device limits, bitrate tables and rate-limit policies are values;
  decisions live in one evaluator per domain.
- British spelling in prose and new identifiers (`sanitise`, `normalise`, `behaviour`). Existing
  identifiers keep their spelling — do not rename `normalizeQuery`.

## Testing requirements

| Layer                                                             | Expectation                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pure logic (probe, parsers, scoring, dedupe, classify, normalise) | Unit tests with fixtures. Table-driven where the input space is enumerable.                                               |
| Media parsers                                                     | Fixture files per format **plus** hostile inputs: truncated, oversized declared lengths, wrong magic bytes, deep nesting. |
| `net/`                                                            | Tests use an injected `DnsResolver` and the local fixture origin. Never the public internet.                              |
| Providers                                                         | Must pass the shared contract-test suite (see `.claude/rules/provider-adapters.md`).                                      |
| API                                                               | Schema validation tests for every endpoint, including rejection cases.                                                    |
| UI                                                                | Accessibility assertions via `@axe-core/playwright`; keyboard-only paths for every action.                                |
| Live tests                                                        | Only under `npm run test:live`, gated by `AURALIS_LIVE_TESTS=1`. Never in `verify`'s unit run.                            |

## Security invariants

These are short on purpose. Memorise them.

1. **One egress path.** All outbound HTTP goes through `createSafeFetch`. No `fetch`, `axios`,
   `node:http` or `node:https` outside `packages/core/src/net/`.
2. **Pin the IP, re-check the peer.** Every URL and every redirect hop is revalidated; the socket's
   peer address is checked after connect. No HTTP proxy support — a proxy voids the pinning.
3. **`classifyAccess` decides downloads.** Nothing else may. The server re-derives it; a
   client-supplied classification is never trusted.
4. **Classification is monotonic downward.** A provider may declare something more restrictive and be
   honoured; it can never upgrade past what the verification evidence justifies.
5. **Media is hostile input.** Bounded loops, bounded allocations, no whole-file downloads, pure and
   synchronous so it can run in a worker.
6. **Cache keys are scoped.** `shared:` or `ws:<workspaceId>:`. Private providers cannot produce a
   shared key — `buildProviderKey` throws.
7. **Filenames pass `sanitiseFilename`.** Every one that reaches a header or a filesystem path.
8. **Secrets never land in logs.** The logger's forbidden-field list and URL redaction are not
   optional. Connector credentials are encrypted at rest.

## The provider-adapter contract

A provider is a source of _claims_, never a source of _truth_. It implements `SearchProvider` from
`packages/core/src/domain/provider.ts`: an `id`, a `displayName`, a static `capabilities` object that
the orchestrator reads without calling the provider, an async-iterable `search()` that yields
`RawSearchCandidate`s as it finds them, and a `healthCheck()`. It receives a `SearchContext` carrying
a workspace-scoped decrypted config, a `ProviderLogger`, and the SSRF-hardened `fetch` — it never sees
the HTTP request, cookies, or another tenant's data. It must honour the `AbortSignal` and
`context.deadlineMs`, must not perform network I/O outside `context.fetch`, must not verify media,
and must not make access decisions beyond declaring a conservative starting point. Full rules and the
mandatory contract-test suite: `.claude/rules/provider-adapters.md`.

## Design principles

- **Evidence over assertion.** Every claim on a result card traces to a check that ran.
- **Explainability is a feature.** Scores publish their breakdown; access decisions publish evidence.
- **Progressive disclosure.** Results stream; the UI reveals detail on request, not by default.
- **Fail visibly, degrade gracefully.** One dead provider is a note on the page, not a failed search.
- **Conservative defaults.** `unknown` never permits a download. Missing facts produce `unknown`
  verdicts, not optimistic guesses.
- **Configuration over conditionals.** Device limits, TTLs and policies are data.

## File ownership

| Owner                      | Paths                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `architecture-lead`        | `CLAUDE.md`, `.claude/**`, `docs/**`                                                                                     |
| `experience-design`        | `auralis/packages/web/**`                                                                                                |
| `source-integrations`      | `auralis/packages/core/src/providers/**`, `docs/providers/*` (content)                                                   |
| `media-forensics`          | `auralis/packages/core/src/media/**`, `auralis/packages/core/src/compat/**`                                              |
| `security-and-platform`    | `auralis/packages/core/src/net/**`, `auralis/packages/core/src/access/**`, `auralis/packages/core/src/util/filenames.ts` |
| `verification-performance` | test files, fixtures, `auralis/e2e/**`                                                                                   |
| `coordinator`              | `auralis/packages/core/**` (unclaimed), `auralis/packages/server/**`, root configs                                       |
| **nobody**                 | PRIVÉE root files. Preserved.                                                                                            |

Editing outside your ownership is a hand-off, not a commit.

## Agent delegation

- Implementation work goes to the domain agent that owns the path.
- Every change touching network, credentials, connectors or downloads is reviewed by
  `security-and-platform` **before** `verification-performance` runs the gate.
- Cross-domain disagreements are resolved by `architecture-lead`, who records the outcome as an ADR
  when it changes a decision.
- `coordinator` integrates only after both review gates pass.
- Agent definitions: `.claude/agents/`. Path rules: `.claude/rules/`. Procedures: `.claude/skills/`.

## Prohibited shortcuts

- Disabling a lint rule, a type check or a test to make a build pass.
- `@ts-ignore`, `@ts-expect-error` without a referenced issue, or `as any`.
- Adding a network call outside `net/`, "just for now".
- Shelling out to `ffmpeg`/`ffprobe` or any external binary for media inspection.
- Trusting a `Content-Type` header, a file extension or a provider's claimed bitrate as fact.
- Caching a private result under a shared key, or widening a cache key to "improve hit rate".
- Logging a URL with a query string that might be signed.
- Committing a secret, a `.env`, or a credential "in a test fixture".
- Editing `dist/`, `node_modules/`, or the PRIVÉE root files.

## Required checks before declaring completion

```sh
cd auralis && npm run verify
cd auralis && npm run audit
```

Then confirm, explicitly:

- [ ] `verify` passed end to end, not partially.
- [ ] Security review completed if the change touched network, credentials, connectors or downloads.
- [ ] Docs updated: ADR for a decision, `docs/providers/` page for a new adapter, threat-model row for
      a new attack surface.
- [ ] No files outside your ownership were modified.
- [ ] The PRIVÉE root files are untouched:
      `git diff --stat HEAD -- index.html sw.js manifest.json version.json dishes.json lineups.json assets/ 'icon-*.png'`
      prints nothing.
