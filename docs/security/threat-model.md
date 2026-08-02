# Threat model

Auralis fetches attacker-influenced URLs, parses attacker-controlled bytes,
holds other people's credentials, and renders text from remote sources. That is
an uncomfortable combination, and it is the reason the security boundaries in
this system are narrow and explicit rather than diffuse.

Three properties do most of the work:

1. **One egress path.** Every outbound request is built by `createSafeFetch`.
   Nothing else in the repository may construct one, enforced by lint rule and
   by a pre-edit hook.
2. **One access authority.** `classifyAccess` is the only function that can
   decide a result is downloadable, and the API re-derives it server-side on
   every request.
3. **Bounded everything.** Bytes, time, redirects, recursion depth, frame
   counts, tag sizes, result counts. A malicious source can waste a bounded
   amount of Auralis's resources and no more.

---

## Assets worth protecting

| Asset                                   | Why it matters                                                        |
| --------------------------------------- | --------------------------------------------------------------------- |
| The internal network the server runs in | An SSRF gives an attacker a request forwarder inside a trust boundary |
| Connector credentials                   | S3 keys and WebDAV passwords belonging to users                       |
| One workspace's results and connectors  | Cross-tenant leakage is a breach even without credential loss         |
| Cloud instance metadata                 | The classic path from SSRF to full credential compromise              |
| The server process itself               | Availability; a crash or hang is a denial of service                  |
| The user's browser session              | XSS would expose everything above through the API                     |

## Adversaries

- **A hostile source.** Controls a URL Auralis will fetch: response headers,
  redirect targets, body bytes, media tags, directory listings, feed contents.
- **A hostile user of the deployment.** Can submit any query, configure any
  connector, and call any API endpoint.
- **A hostile tenant.** A legitimate user attempting to reach another
  workspace's data.
- **A network attacker.** Controls DNS answers, or can respond faster than the
  legitimate host.

---

## STRIDE by threat

### Spoofing

| Threat                                                                              | Mitigation                                                                                                                                                                                                          | Where                          | Tested by                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------ |
| Provider impersonation — a redirect to an attacker host that then serves "the file" | Every hop is revalidated; the final host is recorded on the verification record and shown on the card; TLS certificate validation is bound to the hostname via `servername` even though the connection is IP-pinned | `net/safe-fetch.ts`            | `safe-fetch.test.ts`           |
| Forged session cookie                                                               | Session value is HMAC-signed and verified with a constant-time comparison                                                                                                                                           | `crypto/secrets.ts`            | `security-integration.test.ts` |
| A client claiming a result is downloadable                                          | The classification is recomputed server-side from the stored verification record; the request body carries no access data                                                                                           | `services/download-control.ts` | `security-integration.test.ts` |

### Tampering

| Threat                                                  | Mitigation                                                                                                                                | Where                                    | Tested by                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Tampered credential ciphertext                          | AES-256-GCM; the auth tag makes modification a decryption failure                                                                         | `crypto/secrets.ts`                      | `security-integration.test.ts`          |
| Header injection through a filename or a request header | `sanitiseFilename` strips control bytes, quotes and semicolons; header names must be tokens and values must contain no control characters | `util/filenames.ts`, `net/safe-fetch.ts` | `scoring.test.ts`, `safe-fetch.test.ts` |
| Content-disposition injection                           | The header is built from the sanitised name with RFC 5987 encoding                                                                        | `util/filenames.ts`                      | `scoring.test.ts`                       |
| SQL injection                                           | Every statement is parameterised; the only interpolated identifiers are table names from a module-local constant list                     | `db/*.ts`                                | —                                       |

### Repudiation

| Threat                                          | Mitigation                                                                                                                                                                                               | Where                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| No record of who was permitted to download what | Every download decision — allowed or refused — writes a `download_audit` row with the workspace, provider, classification, reason and final host. Full URLs are never stored, because they may be signed | `db/repositories.ts` |
| No record of connector changes                  | `connector_audit` records create, test and disconnect with their outcome                                                                                                                                 | `db/repositories.ts` |

### Information disclosure

| Threat                                                   | Mitigation                                                                                                                                                                 | Where                                      | Tested by                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| Cross-tenant result leakage                              | Every workspace-owned query takes and filters on `workspaceId`; a result from another workspace returns 404, not 403                                                       | `db/repositories.ts`                       | `security-integration.test.ts` |
| Connector results served from a shared cache             | Cache keys are either `shared:` or `ws:<id>:`; `buildProviderKey` throws rather than build a shared key for a private provider                                             | `cache/keys.ts`                            | `scoring.test.ts`              |
| Credentials returned by the API                          | Secret keys are stored in a separate table and never included in a connector summary; `resolveConfig` is reachable only from the orchestrator and the connection test      | `db/connectors.ts`                         | `security-integration.test.ts` |
| Credentials or signed URLs in logs                       | The logger drops a fixed list of field names wherever they appear, redacts anything shaped like a bearer token, and strips the query string from any URL that looks signed | `observability/logger.ts`                  | —                              |
| Search text in logs                                      | Off by default; `AURALIS_LOG_QUERY_TEXT` must be set deliberately, and the logger otherwise reports only a length                                                          | `observability/logger.ts`, `config/env.ts` | —                              |
| Stack traces or internal paths in responses              | The error handler maps everything to a public code and message; internal detail is logged, never returned                                                                  | `app.ts`                                   | `security-integration.test.ts` |
| Credentials surviving a redirect to another host         | `authorization`, `cookie` and `proxy-authorization` are dropped when the host changes                                                                                      | `net/safe-fetch.ts`                        | `safe-fetch.test.ts`           |
| A withheld direct URL leaking through the result payload | `mediaUrl` is set to `null` unless the access decision includes `copy_direct_url`                                                                                          | `orchestrate/search.ts`                    | `search-integration.test.ts`   |

### Denial of service

| Threat                                         | Mitigation                                                                                                                                             | Where                                              | Tested by                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------ |
| A source that streams forever                  | Hard byte cap per response; the socket is destroyed once it is exceeded                                                                                | `net/safe-fetch.ts`                                | `safe-fetch.test.ts`                 |
| A source that never responds                   | Per-request, per-provider and per-search deadlines                                                                                                     | `net/safe-fetch.ts`, `orchestrate/limits.ts`       | `safe-fetch.test.ts`, contract suite |
| A redirect loop                                | Bounded redirect count                                                                                                                                 | `net/safe-fetch.ts`                                | `safe-fetch.test.ts`                 |
| A lying `Content-Length`                       | The byte cap is applied to bytes actually received, not to the declared length                                                                         | `net/safe-fetch.ts`                                | `safe-fetch.test.ts`                 |
| A crafted media file that spins the parser     | Every parser loop is bounded: MP3 frames, FLAC metadata blocks, MP4 boxes and depth, ID3 frames, RIFF chunks, Ogg pages, XML nodes and depth           | `media/parsers/*.ts`, `util/xml.ts`                | `media-probe.test.ts`                |
| Playlist recursion                             | Depth and entry caps, plus a visited-set check that drops circular references                                                                          | `media/playlist.ts`                                | `media-probe.test.ts`                |
| A directory listing that expands without limit | Depth, page-count and entry caps; links outside the configured root are discarded                                                                      | `providers/http-directory.ts`                      | contract suite                       |
| One tenant exhausting the process              | Per-workspace rate limits on searches and downloads, plus a cap on concurrent searches                                                                 | `http/rate-limit.ts`, `services/search-service.ts` | `security-integration.test.ts`       |
| A failing provider consuming the whole budget  | Circuit breaker per provider; deterministic 4xx never opens it                                                                                         | `orchestrate/breaker.ts`                           | —                                    |
| An unhandled socket error crashing the process | A socket error listener is attached in the `socket` event, and the pinned DNS callback is deferred so the connect cannot happen before listeners exist | `net/safe-fetch.ts`                                | `safe-fetch.test.ts`                 |

### Elevation of privilege

| Threat                                                | Mitigation                                                                                                                                                                                             | Where                                              | Tested by                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------- |
| **SSRF** — reaching an internal service               | Scheme allow-list; hostname deny-list; IP classification of every literal and every resolved address; port allow-list; per-hop revalidation                                                            | `net/url-safety.ts`                                | `url-safety.test.ts`                     |
| **DNS rebinding** — a second answer pointing inside   | The connection is pinned to the exact validated IP through a `lookup` hook, and the socket's peer address is compared to it after connect                                                              | `net/safe-fetch.ts`                                | `safe-fetch.test.ts`                     |
| Cloud metadata access                                 | `169.254.169.254` has its own rule; `metadata.google.internal` and friends are denied by name                                                                                                          | `net/ip-rules.ts`, `net/url-safety.ts`             | `url-safety.test.ts`                     |
| A host with one public and one internal address       | The whole host is rejected if any resolved address is internal                                                                                                                                         | `net/url-safety.ts`                                | `url-safety.test.ts`                     |
| An FTP server redirecting the data channel inward     | The address in a PASV reply is classified before Auralis connects to it                                                                                                                                | `net/ftp-client.ts`                                | —                                        |
| Alternative IP encodings (`2130706433`, `0x7f000001`) | Decoded to dotted quad before classification                                                                                                                                                           | `net/url-safety.ts`                                | `url-safety.test.ts`                     |
| Download-control bypass                               | The mediated streaming route calls `createIntent` and refuses if it is not allowed; there is no other path to bytes                                                                                    | `app.ts`                                           | `security-integration.test.ts`           |
| Credential-scope escalation                           | A connector's configuration bounds its search; there is no code path that widens it                                                                                                                    | connector adapters                                 | —                                        |
| Path traversal into the filesystem                    | Every resolved local path is re-checked against the configured root after joining, which is what catches a symlink that escapes                                                                        | `providers/local-files.ts`                         | —                                        |
| Executable disguised as audio                         | The signature check rejects MZ, ELF, Mach-O, ZIP and gzip; the filename sanitiser refuses to emit a dangerous extension                                                                                | `media/signatures.ts`, `util/filenames.ts`         | `media-probe.test.ts`, `scoring.test.ts` |
| XXE or billion laughs in a feed or PROPFIND response  | The XML reader discards DOCTYPE entirely, resolves only the five predefined entities, and caps nodes, depth and text length                                                                            | `util/xml.ts`                                      | —                                        |
| Stored or reflected XSS                               | The client never uses `dangerouslySetInnerHTML`; every source-supplied string passes `cleanTagString` server-side and renders as a text node; a strict CSP is set when the client is served by the API | `providers/helpers.ts`, `media/bytes.ts`, `app.ts` | e2e axe run                              |
| Malicious artwork                                     | Artwork is rendered as an `<img>` with `referrerPolicy="no-referrer"` and a fallback; it is never parsed server-side                                                                                   | web client                                         | —                                        |
| CSRF                                                  | `SameSite=Lax` cookie plus a required custom header that a simple cross-origin request cannot set                                                                                                      | `http/session.ts`                                  | `security-integration.test.ts`           |
| Cache poisoning                                       | Cache keys include the provider, the normalised query, the filters, the locale, the mode, the credential fingerprint and a schema version                                                              | `cache/keys.ts`                                    | `scoring.test.ts`                        |
| Dependency compromise                                 | Small dependency surface, committed lockfile, `npm audit` in the release gate; XML, FTP, SigV4 and media parsing are in-house rather than pulled in                                                    | `package.json`                                     | `npm run audit`                          |

---

## Accepted risks

Stated plainly, because an unstated accepted risk is an unmanaged one.

- **No HTTP proxy support.** IP pinning and proxying are mutually exclusive. A
  deployment that requires egress through a proxy cannot use this egress layer
  as written.
- **The port allow-list is a heuristic.** It stops the fetcher being used to
  probe common non-HTTP services, but a hostile service on port 443 inside an
  otherwise-public host is not prevented by it. The IP rules are the real
  boundary.
- **`node:sqlite` is experimental** in Node 22 and single-process. The rate
  limiter and cache are therefore per-process in a multi-process deployment.
- **Verification is sampling, not decoding.** Auralis reads container structure,
  not audio frames end to end. A file can be structurally valid and still
  contain silence or damage past the sampled region. Corruption signals report
  what was observed, not what was not looked at.
- **Provider claims about licensing are carried verbatim.** Auralis displays a
  source's rights statement; it does not evaluate or vouch for it.
- **The bundled fixture origin requires private-address egress.** That is why
  `AURALIS_ALLOW_PRIVATE_EGRESS` exists, and why setting it with
  `NODE_ENV=production` is refused at start-up rather than merely discouraged.

---

## Adversarial fixtures

The fixture set in `packages/core/src/testing/media-fixtures.ts` deliberately
includes inputs that must not be accepted:

| Fixture                | What it tests                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| `not-really-audio.mp3` | An HTML page with an audio filename and `Content-Type: audio/mpeg` |
| `truncated-tone.wav`   | A file cut off inside its format chunk                             |
| `collection.m3u`       | A playlist that must never be presented as a playable file         |

The hostile server in `packages/core/tests/safe-fetch.test.ts` adds redirects
into loopback and metadata space, a redirect to `file://`, a redirect loop, a
cross-origin redirect carrying credentials, an endless stream, a body far larger
than the policy permits, and a host that never responds.

---

## Reporting

Security findings should be raised privately with the maintainers before public
disclosure. Include the request, the response, and the module you believe is
implicated — the module names in the tables above are the fastest way to get a
finding to the right place.
