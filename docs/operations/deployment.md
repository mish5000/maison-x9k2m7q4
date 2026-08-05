# Deployment

Auralis is one process: a Fastify API that also serves the built client from
its own origin. There is no separate web server, no database server, and no
external media tool. That makes deployment unusually simple — and imposes one
constraint that shapes everything below.

## The constraint: one instance

Node's built-in SQLite is single-process. The rate limiter and the result cache
are also in-process. Running two instances gives you two databases, two rate
limit counters and two caches, and a user whose session lands on the wrong one
loses their connectors.

So: **one instance, with a persistent volume.** Do not autoscale. If you need
more than one instance, that is a real piece of work — a shared cache
(`AURALIS_REDIS_URL` exists for this) and a database that tolerates concurrent
writers — not a configuration change.

A single small instance is enough for a considerable amount of use. Searches are
bounded by design: per-provider deadlines, a total search budget, byte caps on
every response and a cap on concurrent searches.

## What runs where

|                  |                                                          |
| ---------------- | -------------------------------------------------------- |
| Runtime          | Node 22.6+ (`--experimental-sqlite`)                     |
| Port             | `AURALIS_PORT`, `8080` in the image                      |
| Health check     | `GET /health` → `{"status":"ok","version":"0.1.0"}`      |
| Persistent state | `AURALIS_DATABASE_PATH`, `/data/auralis.db` in the image |
| Client           | Served by the API from `packages/web/dist`               |

The image runs as the `node` user and contains production dependencies only —
TypeScript, Vite, Vitest and Playwright are dropped in the runtime stage.

## Required secrets

The server **refuses to start** in production without these. That is
deliberate: a deploy that would have run with a default key fails loudly
instead.

```bash
AURALIS_SECRET_KEY=$(openssl rand -base64 32)     # encrypts connector credentials
AURALIS_SESSION_SECRET=$(openssl rand -hex 32)    # signs the session cookie
```

Losing `AURALIS_SECRET_KEY` makes stored connector credentials undecryptable —
users would have to reconnect their sources. The ciphertext record carries a
version prefix so the key can be rotated without a migration.

## Fly.io

```bash
cd auralis          # the application is a subdirectory of this repository
fly launch --no-deploy --copy-config
fly volumes create auralis_data --size 1
fly secrets set AURALIS_SECRET_KEY="$(openssl rand -base64 32)" \
                AURALIS_SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

`auralis/fly.toml` pins `min_machines_running = 1` and mounts the volume at `/data`.
Raising the machine count splits the database — see the constraint above.

## Render

Point a Blueprint at the repository; `render.yaml` at the root describes the
whole service, with `dockerContext` pointing at `auralis/`.
Both secrets use `generateValue`, so Render creates them on first deploy and you
never handle them. A persistent disk requires a paid instance type — the free
tier has no durable storage, so the database would vanish on every restart.

## Making it private

A `fly.dev` or `onrender.com` address is reachable by anyone on the internet who
knows it. Auralis has no accounts — a workspace is bound to an anonymous cookie
— so a deployment with no further configuration is **open to whoever finds the
URL**. Not being listed anywhere is not access control.

Set one more secret and the whole instance closes behind a single password:

```bash
fly secrets set AURALIS_ACCESS_PASSWORD="$(openssl rand -base64 18)"
```

With it set, every request except `/health` requires the password. A browser
gets a plain unlock page; an API call gets `401` and nothing else. Unlocking
sets an HttpOnly, `SameSite=Lax`, `Secure` cookie that lasts a month.

What it is and is not:

- It is one shared password for one person's instance. It answers "only I can
  reach this".
- It is **not** a user system, and it is not multi-tenant authentication. Anyone
  with the password has the whole instance.
- The cookie value is derived from the password, so changing the password
  invalidates every cookie already issued.
- Comparison is constant-time over SHA-256 digests, so neither the length nor
  the content of the password leaks through timing.
- Failed attempts are throttled — a bounded number per minute, after which every
  attempt is refused, correct or not, until the window passes.
- `/health` stays open, because the platform's health check has to reach it.
  It returns a status and a version and nothing else.

Leave it unset for a local install, where the gate would only be in the way.

## Anywhere else

Any host that runs a container with a persistent volume works. What it needs:

- Node 22.6+ (the image provides it)
- A writable volume at `/data`
- The two secrets in the environment
- One instance
- Outbound HTTPS. Auralis pins connections to the IP it validated, which is
  **incompatible with an HTTP egress proxy** — a proxy resolves the hostname
  itself, which voids the pinning. A host that forces proxied egress cannot run
  this egress layer as written.

## What a fresh deployment can search

In production the bundled fixture origin does not start and private-network
egress is refused outright, so a new instance has the three sources that need no
configuration: Internet Archive, Wikimedia Commons and LibriVox. Searches work
immediately.

The other seven adapters are registered but sit in `not_configured` until
someone sets them up through the connectors screen. They are never silently
skipped and never pretend to work.

## Retention

`pruneExpiredData` is not automatic. Run `npm run db:migrate` on a schedule (a
daily cron is fine) or search history accumulates indefinitely. Retention
periods are in `RETENTION_DAYS` in `auralis/packages/server/src/db/schema.ts` and are
documented in [privacy](../security/privacy.md).

## Operating notes

- Serve over HTTPS. The session cookie is `Secure` in production and will not be
  sent over plain HTTP, so the app will appear to lose its session on every
  request if you terminate TLS incorrectly.
- Set `AURALIS_CORS_ORIGINS` only if something other than the bundled client
  calls the API. Serving the client from the API means there is no CORS surface
  by default.
- Leave `AURALIS_LOG_QUERY_TEXT` off unless you have a disclosed reason. On, it
  logs the text of every search.
- `AURALIS_ALLOW_PRIVATE_EGRESS` is refused at start-up when `NODE_ENV` is
  production. It exists for the local fixture origin and nothing else.
- Treat the volume as containing personal data: it holds search history and
  encrypted connector credentials.

## Verification of this configuration

The Dockerfile's runtime stage was validated by reproducing it outside Docker —
a `npm ci --omit=dev` install against the same manifests, the built `dist`
directories copied in, and the server started with the image's exact
environment. The workspace symlinks resolve, the production config gate accepts
the secrets, and the process serves `/health`, the client, its hashed assets and
the API. The container image itself has not been built and run; that happens on
your first `fly deploy` or Render build.
