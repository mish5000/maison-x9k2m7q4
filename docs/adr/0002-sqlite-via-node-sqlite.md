# ADR 0002 — SQLite through Node's built-in `node:sqlite`

## Status

Accepted — 2026-08-02

## Context

Auralis needs durable storage for a small, well-bounded set of things: anonymous
workspaces and users, search sessions and their event logs, streamed results
(so a download request that arrives mid-search finds a row), connectors and
their encrypted credentials, saved items, and three audit tables. The whole
schema is one migration in `packages/server/src/db/schema.ts`.

The characteristics that shaped the choice:

- **Single-writer, low-volume.** One API process, a handful of inserts per
  search, everything pruned on a retention schedule.
- **Must work from a clean clone.** `npm install && npm run build &&
npm run dev` has to produce a working system. A developer who wants to see the
  search pipeline should not first have to provision Postgres.
- **No native compilation.** `better-sqlite3` and `node-sqlite3` both require a
  toolchain or a prebuilt binary matching the exact Node ABI. That is the single
  most common reason a clean clone fails to install.
- **WAL matters.** Search event writes happen _while_ the SSE stream is being
  read. A reader that blocks the writer would stall the live stream.

Node 22 ships `node:sqlite` in core, behind `--experimental-sqlite`.

## Decision

Use Node's built-in `node:sqlite` (`DatabaseSync`), loaded through
`createRequire` so bundlers that do not yet recognise `node:sqlite` as a
built-in cannot try to resolve it from disk:

```ts
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
```

`openDatabase(path)` in `db/database.ts` owns the whole surface:

- creates the parent directory, opens the file (or `:memory:` for tests)
- `PRAGMA journal_mode = WAL` (file databases only), `foreign_keys = ON`,
  `busy_timeout = 5000`, `synchronous = NORMAL`
- wraps the driver in a five-method `Db` interface (`exec`, `prepare`,
  `transaction`, `close`) so nothing else in the codebase touches the driver
- runs `migrate(db)` before returning

Migrations are append-only entries in `MIGRATIONS`, each applied once inside a
`BEGIN IMMEDIATE` transaction and recorded in `schema_migration`. Every table is
`STRICT`. All SQL lives in exactly three files: `database.ts`,
`repositories.ts` and `connectors.ts`.

The flag is carried in the scripts that need it:
`npm start` → `node --experimental-sqlite packages/server/dist/main.js`,
`npm run db:migrate` → `node --experimental-sqlite …/db/migrate-cli.js`.

## Consequences

### Positive

- Zero install friction. No compiler, no prebuilt binary, no ABI matching, no
  database server, no connection string. `engines.node >= 22.6.0` is the entire
  requirement.
- No supply-chain surface for the storage layer: the driver ships with the
  runtime, so there is no third-party package to audit, pin or update.
- Tests run against `:memory:` (`BuildAppOptions.databasePath`), so the whole
  application — routes, session, orchestrator, download control — can be built
  and torn down per test with no fixture database and no cleanup.
- WAL keeps readers from blocking the writer, which is what makes it safe to
  `appendEvent` into `search_event` while the SSE response is being written.
- The synchronous API is a genuine simplification. Repository methods are plain
  functions; there is no connection pool, no `await` on every statement, and no
  class of bug where a transaction spans an unexpected `await`.
- `STRICT` tables catch type mistakes at insert time rather than storing a
  string where a number was intended.

### Negative

- **`node:sqlite` is experimental in Node 22 and prints a warning on start.**
  Every process that touches the database emits an ExperimentalWarning to
  stderr. It is noise in logs, it looks alarming in a production console, and
  the module's API may change in a future Node major. This is stated in the
  header comment of `db/database.ts` and in the project README rather than
  hidden.
- **It requires a flag.** `--experimental-sqlite` must be present on every entry
  point. A deployment that runs `node dist/main.js` directly, without the flag,
  fails at startup. The flag lives in `package.json` scripts, so anything that
  bypasses those scripts has to remember it.
- **Single process.** SQLite in this configuration is one writer. That is fine
  for the database, but it makes two _in-memory_ structures per-process rather
  than per-deployment:
  - `http/rate-limit.ts` `RateLimiter` — a `Map` of fixed windows. Run four
    processes behind a load balancer and a workspace gets four times its
    allowance.
  - `cache/store.ts` `MemoryCacheStore` — an in-process LRU. Four processes mean
    four caches, four times the upstream traffic, and no shared invalidation.

  `SearchService`'s live search registry and the `CircuitBreakerRegistry` are
  per-process for the same reason: a search created on process A cannot be
  cancelled or subscribed to on process B, and a circuit opened on A stays
  closed on B. ADR 0007 records the `CacheStore` seam that would fix the cache
  and the rate limiter.

- No network access to the data. Inspecting production data means shell access
  to the host and a `sqlite3` binary, not a client connection.
- No built-in replication, failover or point-in-time recovery. Backups are file
  copies of the WAL set.
- `pruneExpiredData` is not scheduled by the server; it runs only via
  `npm run db:migrate`. Retention is an operational obligation.

## Alternatives considered

| Alternative                                | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`better-sqlite3`**                       | The closest competitor, and genuinely better in API surface and maturity. Rejected on install friction: it is a native module, so a clean clone needs either a working toolchain or a prebuilt binary for the exact platform and Node ABI. That failure mode is opaque to a new contributor and is precisely what "a clean clone must build" was meant to avoid. It also reintroduces a third-party dependency in the most security-sensitive layer. |
| **`node-sqlite3` (async)**                 | Same native-build problem, plus a callback/promise API that would push `await` through every repository method for no benefit at this scale.                                                                                                                                                                                                                                                                                                         |
| **PostgreSQL**                             | Solves multi-process cleanly and would remove the per-process cache and rate-limiter caveats. Rejected because it requires a server to provision, a connection string to configure, and a running container before a developer can see a search work. The workload — one writer, a few thousand rows, everything pruned — does not need it. Revisit if Auralis ever runs more than one API process.                                                  |
| **A JSON file or LevelDB**                 | No transactions across tables, no foreign keys, no `STRICT` typing, no SQL for the retention prune. The schema has real referential structure (workspace → session → event/result, connector → credential) and `ON DELETE CASCADE` is what makes `deleteWorkspaceData` a four-statement function.                                                                                                                                                    |
| **No persistence at all (in-memory only)** | Search history, saved items and connector credentials all need to survive a restart, and results must be readable after the search ends so a download intent can be re-derived server-side.                                                                                                                                                                                                                                                          |
| **Waiting for `node:sqlite` to stabilise** | Would mean shipping with a native module in the interim and migrating later. The interface in `db/database.ts` is five methods wide, so if `node:sqlite` changes or is abandoned, swapping the driver is a change to one file. That containment is what makes accepting an experimental module reasonable.                                                                                                                                           |
