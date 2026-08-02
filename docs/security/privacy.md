# Privacy architecture

Auralis is a search product, and search queries are among the more revealing
things a person can type. The design goal is that using Auralis should leave as
little trace as the product's function allows, and that whatever trace exists
should be visible and deletable by the person who created it.

---

## No account

There is no sign-up, no email address, no password. On first request the server
creates a workspace and a user, and binds them to a signed, HttpOnly cookie.
That identifier exists so connectors have a tenant to belong to and so search
history has an owner — not to identify anyone.

The consequence is stated plainly: clearing cookies loses the workspace and
everything scoped to it, including connectors. That trade was made deliberately
in [ADR 0006](../adr/0006-anonymous-workspace-session-model.md).

---

## What is stored, and for how long

| Table                      | Contents                                                                     | Retention          |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `workspace`, `app_user`    | Opaque identifiers and timestamps only                                       | Until deleted      |
| `search_session`           | Query text, normalised query, filters, mode, provider list, status           | 30 days            |
| `search_event`             | The event stream for a search, for replay                                    | 7 days             |
| `search_result`            | The delivered result payload plus the fields download control needs          | 30 days            |
| `provider_search`          | Per-provider outcome, candidate count, duration                              | 7 days             |
| `connector`                | Kind, display name, non-secret settings, masked account identity             | Until disconnected |
| `connector_credential`     | AES-256-GCM ciphertext only                                                  | Until disconnected |
| `connector_audit`          | create / test / disconnect and their outcomes                                | 180 days           |
| `saved_item`               | Items the user chose to save                                                 | Until removed      |
| `download_audit`           | Workspace, provider, classification, allowed/refused, reason, final **host** | 90 days            |
| `abuse_signal`             | Rate-limit and abuse events                                                  | 90 days            |
| `provider_health_snapshot` | Provider status and latency                                                  | 7 days             |

Retention is applied by `pruneExpiredData` in
`auralis/packages/server/src/db/database.ts`, driven by the `RETENTION_DAYS`
constant in `schema.ts`. Run it with `npm run db:migrate`, or on a schedule.

The query text is stored so a person can review and delete their own history.
It is excluded from logs by default and expires with the session row.

---

## What is never stored

- Plaintext credentials. Secret connector settings are encrypted before insert.
- Full media URLs in the audit log. A download URL may be signed, and a signed
  URL is a bearer token; only the host is recorded.
- IP addresses. Rate limiting is keyed by workspace, not by address, so a shared
  network is not penalised and no address needs to be kept.
- Media file contents. Auralis reads a bounded sample to identify a file and
  discards it; nothing is mirrored or cached to disk.

---

## What is never logged

`observability/logger.ts` enforces this rather than relying on discipline.
Fields matching a fixed name list are replaced wherever they appear in a log
record, at any nesting depth:

`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `password`,
`secret`, `token`, `accesstoken`, `refreshtoken`, `apikey`, `sessionsecret`,
`credential(s)`, `privatekey`, `signedurl`, `clientsecret`, `secretaccesskey`.

In addition, any string that looks like a bearer or basic credential is
redacted, and any URL containing a signature-like parameter has its query string
stripped while keeping the origin and path.

Search text is not logged at all unless `AURALIS_LOG_QUERY_TEXT=true` is set
deliberately. With it off, `logger.queryField` records only a character count.

---

## In the browser

- Recent searches live in `localStorage` (at most eight), and there is a control
  to clear them. They are never sent to the server as history.
- No third-party analytics, no tracking pixels, no fingerprinting, no
  advertising identifiers. The client makes requests to its own API and fetches
  artwork and audio from source hosts.
- Artwork is loaded with `referrerPolicy="no-referrer"`, so browsing Auralis
  does not tell a source host what you searched for.
- The Content-Security-Policy set when the API serves the client restricts
  scripts and connections to the same origin.

---

## Connector data boundaries

- A connector belongs to exactly one workspace. Every read filters on it.
- Connector results are keyed `ws:<workspaceId>:…` in the cache. The key builder
  throws rather than produce a shared key for a private provider, so the mistake
  fails loudly at the point it is made.
- Disconnecting a connector deletes its credentials by cascade and clears its
  cache prefix immediately.
- Nothing is indexed in the background. A connected source is read when you
  search it, and not otherwise.

---

## Control

| Action                               | How                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| See your search history              | `GET /api/v1/searches/:searchId` per search; the client keeps recent queries locally |
| Delete all your search history       | `DELETE /api/v1/searches`                                                            |
| Clear recent searches on this device | The control next to the recent-search list                                           |
| List what is connected               | `GET /api/v1/connectors`                                                             |
| Disconnect a source                  | `DELETE /api/v1/connectors/:connectorId` — removes credentials and cached results    |
| Remove a saved item                  | `DELETE /api/v1/saved/:savedId`                                                      |
| Delete everything for a workspace    | `deleteWorkspaceData` in `db/database.ts`                                            |

Export is not yet exposed as an endpoint; the stored shape is a small number of
tables and is documented in [the data model](../architecture/data-model.md).
That gap is listed as a known limitation rather than implied to be complete.

---

## Operator responsibilities

If you deploy Auralis for other people:

- Set `AURALIS_SECRET_KEY` and `AURALIS_SESSION_SECRET`. The server refuses to
  start in production without them.
- Leave `AURALIS_LOG_QUERY_TEXT` off unless you have a specific, disclosed
  reason and have told your users.
- Run the retention job. Data does not expire on its own.
- Treat the database file as containing personal data: it holds search history
  and encrypted credentials.
- Serve over HTTPS. The session cookie is marked `Secure` in production, so it
  will not be sent over plain HTTP.
