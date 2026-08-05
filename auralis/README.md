# Auralis

**Find the sound. Verify the file.**

Auralis is a universal audio discovery engine. You type one thing — a title, a
phrase, a filename, a creator, an episode, a speech — and it searches across
public archives, open-data repositories, feeds, directory listings, and any
storage you have connected. Results stream in as they are found.

The part that matters is the second half of the tagline. A link ending in
`.mp3` is a claim, not a fact. Auralis reads the actual bytes of every candidate
— a bounded sample, never the whole file — and reports what is really there:
container, codec, sample rate, bit depth, channels, duration, bitrate and how
confident it is in each number. A web page served as `audio/mpeg` is rejected. A
playlist is never presented as a playable file. A file that has not been
verified is never offered as a download.

---

## Quick start

```bash
cd auralis
npm install
npm run build
npm run dev
```

Then open <http://localhost:5174>.

`npm run dev` starts three things: the API on port 5175, the Vite client on
5174, and a bundled fixture origin on 5176 that publishes a set of real,
generated audio files as an HTTP directory. That last piece is why a clean
clone has something genuine to search before you configure anything — the
directory adapter really crawls the index, really issues range requests, and
really parses the container bytes it gets back.

Search for `tone` to see the pipeline end to end.

Requires **Node 22.6 or newer**. There is no database server, no native build
step, and no external media tool to install.

### No computer to hand?

Open the repository in a GitHub Codespace — it runs entirely in a browser,
including a mobile one. `.devcontainer/devcontainer.json` installs and builds on
first start, so the only thing left is:

```bash
npm run dev
```

Codespaces forwards port 5174 and gives it a URL you can open from any device.
It is a development environment, not a deployment: it sleeps when idle and stops
when you delete it. For something permanent, see
[deploying](#deploying).

### Commands

| Command                  | What it does                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `npm run dev`            | API + client + fixture origin, with live reload on the client |
| `npm run build`          | Type-checks and builds all three packages                     |
| `npm start`              | Runs the built API (production entry point)                   |
| `npm run db:migrate`     | Applies migrations and the retention policy                   |
| `npm run fixtures:serve` | Runs only the fixture origin                                  |
| `npm test`               | Unit, contract and integration tests (293 tests, no network)  |
| `npm run test:live`      | Opt-in suite against real third-party services                |
| `npm run e2e`            | Playwright journeys against the production build              |
| `npm run typecheck`      | `tsc -b` across all packages                                  |
| `npm run lint`           | ESLint, including the project's egress restrictions           |
| `npm run format`         | Prettier                                                      |
| `npm run audit`          | `npm audit` for production dependencies                       |
| `npm run verify`         | The release gate: format, lint, types, tests, build, e2e      |

---

## How a search works

```
query → validate → normalise → extract intent → select providers
      → search providers in parallel (streaming)
      → URL safety check → resolve redirects → inspect headers
      → bounded range probe → verify signature → extract metadata
      → classify access → detect duplicates → score quality
      → rank → deliver progressively over SSE
```

Providers run concurrently and yield candidates as they find them. Each
candidate is then verified and enriched independently, so one slow source
delays only its own results. Everything is bounded: per-provider deadlines,
per-verification deadlines, a total search budget, byte caps on every response,
and a circuit breaker per provider.

### Three modes

- **Quick** — fast providers, tight budget, minimal enrichment before display.
- **Deep** — more providers, longer budget, more query variants, deeper
  directory traversal within configured roots, more thorough validation and
  more aggressive duplicate detection.
- **Connected sources** — searches storage you have connected, using official
  APIs or explicitly configured endpoints. Results are scoped to your workspace
  and never enter a shared cache.

Deep mode means broader coverage. It does not relax any network, credential or
scope control.

---

## Sources

Ten adapters ship in the registry. Three work with no configuration at all;
the rest are registered but stay in `not_configured` until you set them up —
they are never silently skipped and never pretend to work.

| Provider            | Category               | Configuration required                                           |
| ------------------- | ---------------------- | ---------------------------------------------------------------- |
| `internet-archive`  | Open archive           | None                                                             |
| `wikimedia-commons` | Open data              | None                                                             |
| `librivox`          | Open archive           | None                                                             |
| `rss-feed`          | Podcast / Atom feeds   | `feeds`                                                          |
| `http-directory`    | HTTP directory listing | `roots`, optional `maxDepth`                                     |
| `ftp-directory`     | FTP directory          | `roots`, optional `username` / `password`                        |
| `local-files`       | Files you selected     | `roots`                                                          |
| `s3-compatible`     | Connected storage      | `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey` |
| `webdav`            | Connected storage      | `baseUrl`, `username`, `password`                                |
| `custom-json-api`   | Organisation catalogue | `urlTemplate`, `itemsPath`, `titlePath`, `mediaUrlPath`          |

Per-provider setup notes live in [`../docs/providers/`](../docs/providers/).

---

## What Auralis will not do

These are enforced in code, not just documented.

- It will not reach a private, loopback, link-local, reserved or
  cloud-metadata address — before or after any redirect. Connections are
  pinned to the exact IP that passed validation, and the socket's peer address
  is re-checked after connect, so a DNS answer that changes between resolution
  and connection cannot be used to reach inside a network.
- It will not offer a download for anything it has not verified as audio.
  `classifyAccess` is the only authority on this, and the API re-derives the
  decision server-side on every download request — a client's opinion is never
  trusted.
- It will not download a whole file to identify one. A HEAD request plus at
  most two bounded range requests is always enough.
- It will not put results from a connected account into a shared cache. Cache
  keys are either `shared:` or `ws:<workspace>:`, and the key builder throws
  rather than produce a shared key for a private provider.
- It will not log credentials, authorization headers, signed URLs, or the text
  of your searches (that last one is opt-in and off by default).
- It will not guess. When it cannot determine something, it says `unknown`
  and shows you the most conservative action available.

The full policy is in
[`../docs/security/source-access-policy.md`](../docs/security/source-access-policy.md)
and the threat model in
[`../docs/security/threat-model.md`](../docs/security/threat-model.md).

---

## Architecture

```
auralis/
├── packages/core/     @auralis/core   — domain model, egress, media parsers,
│                                        providers, orchestration, scoring
├── packages/server/   @auralis/server — Fastify API, SSE, SQLite, connectors,
│                                        download control, fixture origin
├── packages/web/      @auralis/web    — React client and design system
└── e2e/                               — Playwright journeys and captures
```

`@auralis/core` is a Node package (it uses `node:crypto`, `node:dns`,
`node:http`). The client imports **types only** from it.

Notable decisions, with their trade-offs, are recorded as ADRs in
[`../docs/adr/`](../docs/adr/):

- **SQLite through Node's built-in `node:sqlite`** — no native compilation, no
  database process. It is marked experimental in Node 22 and prints a warning
  on start.
- **In-house media parsers instead of ffprobe** — no external binary, works
  from a clean clone, pure and synchronous so it can run in a bounded worker,
  and needs only a byte sample. It reads containers; it does not decode audio.
- **IP-pinned egress** — the reason Auralis cannot be pointed at an internal
  service. The cost is that the egress layer cannot work behind an HTTP proxy,
  because a proxy would resolve the hostname itself.
- **Server-sent events** for progressive results — reconnection and replay come
  for free via `Last-Event-ID`.
- **Anonymous workspace sessions** — connectors need a tenant; you should not
  need an account.

---

## Configuration

Every value has a safe default for local development. See
[`.env.example`](./.env.example) for the annotated list.

Two are **required in production**:

```bash
AURALIS_SECRET_KEY=$(openssl rand -base64 32)     # encrypts connector credentials
AURALIS_SESSION_SECRET=$(openssl rand -hex 32)    # signs the session cookie
```

`AURALIS_ALLOW_PRIVATE_EGRESS` exists so the bundled fixture origin can be
searched locally. Setting it with `NODE_ENV=production` is refused at start-up.

---

## Deploying

One container, one persistent volume, one instance — Node's SQLite is
single-process, so this deliberately does not autoscale. `Dockerfile` and
`fly.toml` are here; the Render blueprint is `render.yaml` at the repository
root.

```bash
cd auralis
fly launch --no-deploy --copy-config
fly volumes create auralis_data --size 1
fly secrets set AURALIS_SECRET_KEY="$(openssl rand -base64 32)" \
                AURALIS_SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

A deployed address is public unless you close it. For a personal instance, set
`AURALIS_ACCESS_PASSWORD` as well and every route except `/health` sits behind
one password.

Full notes, including why an HTTP egress proxy is incompatible with IP pinning
and what a fresh deployment can search before anything is configured:
[`../docs/operations/deployment.md`](../docs/operations/deployment.md).

---

## Testing

```bash
npm test              # 293 unit, contract and integration tests
npm run e2e           # 20 browser journeys, desktop and mobile
npm run test:live     # opt-in, hits real services
```

The default suite never touches the network beyond loopback, so it cannot fail
because a public API is having a bad day. Every provider passes the same
contract suite — valid query, empty result, malformed response, timeout,
cancellation, rate limit, authentication failure, candidate cap — because the
orchestrator's guarantees are only as good as the weakest adapter.

Accessibility is verified with axe-core in the browser, not asserted in prose.

---

## Privacy

No account. No third-party analytics. No tracking. Recent searches are kept in
your browser's local storage and you can clear them. Server-side search history
belongs to your workspace, is deleted on request
(`DELETE /api/v1/searches`), and expires on a schedule. Connector credentials
are encrypted with AES-256-GCM before they reach the database and are never
returned by any endpoint.

See [`../docs/security/privacy.md`](../docs/security/privacy.md).
