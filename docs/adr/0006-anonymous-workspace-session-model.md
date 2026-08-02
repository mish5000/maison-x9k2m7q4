# ADR 0006 — Anonymous workspace session model

## Status

Accepted — 2026-08-02

## Context

Auralis needs a tenant. Not for billing or for identity, but because several
things are genuinely per-user and must not leak between users:

- **Connector credentials.** An S3 access key, a WebDAV password, an FTP login.
  These must belong to someone and must never be visible to anyone else.
- **Private results.** Anything from a connector or a selected local folder is
  `connected_private` or `user_owned`, and `cache/keys.ts` refuses to put it in a
  shared cache — which requires a workspace id to scope the key to.
- **Search history and saved items.** Useful, and obviously not shared.
- **Rate limits.** Keyed by workspace rather than by IP, _"so a shared network is
  not penalised and a single tenant cannot exhaust the process."_

At the same time, the privacy position is that a search engine should not need
to know who you are. There is no account, no third-party analytics, no tracking,
and search text is not logged unless `AURALIS_LOG_QUERY_TEXT` is explicitly
turned on.

Those two requirements pull in opposite directions: tenancy needs a stable
identifier, and identity collection is what we are trying to avoid.

## Decision

Create a workspace and a user on first contact, bind them to a signed HttpOnly
cookie, and collect nothing else.

`http/session.ts` `resolveSession(request, reply, options)`:

1. If `request.session` is already set for this request, return it.
2. Read the `auralis_session` cookie. `verifySession(raw, secret)`
   (`crypto/secrets.ts`) splits on the last `.`, recomputes an HMAC-SHA256 over
   the value and compares with `timingSafeEqual`. A forged or tampered cookie
   returns `null`.
3. If it verifies and `workspaces.findByUserId(userId)` finds a row,
   `workspaces.touch(userId)` updates `last_seen_at` on both `app_user` and
   `workspace`, and that session is used.
4. Otherwise `workspaces.create()` inserts a new `workspace` + `app_user` pair
   in one transaction and `reply.setCookie` issues the signed cookie.

Cookie attributes: `httpOnly: true`, `sameSite: 'lax'`,
`secure: config.isProduction`, `path: '/'`,
`maxAge: 60 * 60 * 24 * 90` (90 days).

What the identity actually contains — `workspace(id, created_at, last_seen_at)`
and `app_user(id, workspace_id, created_at, last_seen_at)`. No name, no email,
no password, no IP address, no user agent. The ids are opaque and non-guessable
(`randomId('ws')` / `randomId('usr')`, 20 characters from `node:crypto`
random bytes).

CSRF is handled separately and additively. `SameSite=Lax` already blocks
cross-site form posts; `assertCsrf` in the `preHandler` requires a non-empty
`x-auralis-csrf` header on every non-GET/HEAD/OPTIONS request, which a
cross-origin form cannot set without a successful CORS preflight. So a
simple-request forgery fails twice.

`AURALIS_SESSION_SECRET` is required to be ≥ 32 characters in production;
`loadConfig` throws otherwise. In development a fixed key is derived so local
databases stay readable across restarts.

## Consequences

### Positive

- No identity is collected, so none can be leaked, subpoenaed, sold or breached.
  The database's most sensitive contents are encrypted connector credentials and
  search text, both of which have retention limits.
- Zero friction. A first-time visitor searches immediately; there is no signup
  wall in front of the thing the product does.
- Connectors get a real tenant. `ConnectorRepository` scopes every query on
  `workspace_id`, credentials are AES-256-GCM ciphertext in
  `connector_credential`, and `resolveConfig` — the only method that decrypts —
  goes through `get(workspaceId, connectorId)` first.
- Cache scoping becomes checkable. `buildProviderKey` throws
  `CacheScopeViolationError` if asked to produce a `shared:` key for a provider
  with `producesPrivateResults`, which is only possible because a workspace id is
  always available.
- Rate limiting by workspace is fairer than by IP: a university or an office
  behind one NAT address is not collectively throttled.
- The cookie is opaque. It carries a user id and an HMAC, nothing derivable.
- Sessions are cheap to reason about: no refresh tokens, no revocation lists, no
  password reset flow, no email delivery dependency.

### Negative

- **History is bound to a cookie, so clearing cookies loses it.** This is the
  central trade-off and it is not mitigated anywhere. Clear site data, switch to
  a private window, switch browsers or switch devices, and the workspace is
  unreachable: search history, saved items and — most painfully — configured
  connectors and their credentials are all still in the database but no longer
  addressable by anyone. There is no recovery path, because a recovery path
  requires an identity, which is the thing this decision declines to collect.
  It was accepted deliberately.
- **No cross-device continuity.** A connector configured on a laptop does not
  exist on a phone. For a product whose "connected sources" mode depends on
  configured storage, that is a real limitation.
- **Orphaned workspaces accumulate.** Every cookie-less visitor creates a
  `workspace` + `app_user` pair. Neither table has a retention entry in
  `RETENTION_DAYS`, so they are never pruned. `last_seen_at` is maintained and
  `deleteWorkspaceData` exists, but nothing calls either for cleanup — the rows
  simply stay.
- **A leaked cookie is full access to that workspace**, including the ability to
  use (though not to read) its stored credentials. There is no second factor, no
  device binding and no way for a user to invalidate a session other than losing
  it. `httpOnly` blocks script access and `secure` blocks plaintext transmission
  in production; that is the whole defence.
- **Rotating `AURALIS_SESSION_SECRET` invalidates every session at once.** There
  is no key-id in the cookie and no dual-verification window, so a rotation
  orphans every existing workspace — the same failure as clearing cookies, but
  for everyone simultaneously.
- **90-day expiry is a silent cliff.** A user who returns after 91 days is a new
  workspace with no warning and no explanation.
- **Sybil-cheap.** Deleting a cookie yields a fresh workspace and a fresh rate
  limit budget. Workspace-keyed rate limiting is therefore an abuse _speed bump_,
  not an abuse control. The `abuse_signal` table exists for signals of this kind
  but no route writes to it yet.
- **`deleteWorkspaceData` is not exposed.** The user-facing delete today is
  `DELETE /api/v1/searches`, which removes search sessions (cascading to events,
  provider runs and results) but leaves saved items, connectors and audit rows in
  place.

## Alternatives considered

| Alternative                                           | Why rejected                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accounts (email + password, or OAuth)**             | Solves recovery, cross-device continuity and cookie loss outright — and requires collecting an identity, storing a credential or delegating to a third party, sending email, and handling reset flows. That is precisely the data the product has chosen not to hold. Reasonable to revisit as an _optional_ upgrade path layered on top of an anonymous workspace, which this model does not preclude. |
| **No tenancy at all — everything global**             | Impossible. Connector credentials, private results and per-tenant cache scoping all require an owner. Without one, `buildProviderKey` could not distinguish `shared:` from `ws:` and one user's S3 listing could be served to another.                                                                                                                                                                  |
| **IP-based identity**                                 | Unstable (mobile networks, CGNAT, VPNs), collective (an office shares one address), and worse for privacy than a random opaque id — it records where you are, which the cookie does not.                                                                                                                                                                                                                |
| **Browser fingerprinting for continuity**             | Would survive cookie clearing, which is exactly why it is unacceptable: it defeats a deliberate user action and constitutes tracking.                                                                                                                                                                                                                                                                   |
| **`localStorage`-held workspace id sent as a header** | Same loss characteristics as a cookie, but readable by any script on the page and requiring bespoke handling on every request — including `EventSource`, which cannot set headers at all.                                                                                                                                                                                                               |
| **Unsigned cookie carrying the workspace id**         | Any client could set an arbitrary workspace id and read another tenant's connectors. The HMAC is what makes the id unforgeable; `timingSafeEqual` is what stops the comparison leaking.                                                                                                                                                                                                                 |
| **JWT session tokens**                                | Adds signature-algorithm and expiry-handling complexity to solve a stateless-verification problem that does not exist here — the server has the database open and `findByUserId` is one indexed lookup.                                                                                                                                                                                                 |
| **A recovery code shown once at workspace creation**  | Would soften the cookie-loss cliff without collecting an identity. Genuinely attractive, and not implemented: it needs a place in the UI, a storage-and-verification path, and a user who takes the prompt seriously. Recorded here as the most plausible mitigation if cookie loss proves painful in practice.                                                                                         |
