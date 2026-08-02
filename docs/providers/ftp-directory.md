# FTP directories

## What it searches

FTP paths that an administrator configured. The adapter uses the in-house FTP client
(`packages/core/src/net/ftp-client.ts`) to log in, walk the configured directory tree with MLSD
(falling back to LIST), and emit the audio files it finds. It speaks only the subset it needs:
login, PASV, MLSD/LIST and SIZE. The same address classification that guards HTTP egress is applied
to the control connection _and_ to the address a server hands back in its PASV reply.

## Status

Needs configuration. At least one valid `ftp://` address must be supplied in `roots` before the
provider leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key           | Required                 | What it is                                                                                                                                                                                       | Example                          |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `roots`       | required                 | Newline- or comma-separated `ftp://` URLs. Non-`ftp:` schemes, out-of-range ports and paths containing a `..` segment are rejected. `configList` keeps at most 50; the adapter uses the first 4. | `ftp://media.example.org/audio/` |
| `username`    | optional                 | Login user. Defaults to `anonymous`. Supplying anything else marks the results as connected-private.                                                                                             | `archive-reader`                 |
| `password`    | optional                 | **Secret.** Login password. Defaults to `auralis@example.invalid` for anonymous logins.                                                                                                          | `••••••••`                       |
| `maxDepth`    | optional                 | Traversal depth below each root. Default 2, hard maximum 4.                                                                                                                                      | `3`                              |
| `displayName` | supplied by the platform | Injected by `ConnectorRepository.resolveConfig` from the connector's display name and used as the provider display name on results.                                                              | `Studio FTP`                     |

`password` is the only registered secret key (`FTP_SECRET_CONFIG_KEYS`). It is encrypted at rest
with AES-256-GCM and is never returned by the API — `toConnectorSummary` masks it and only the
search orchestrator and the connection test ever see the decrypted value.

## Setup

1. Confirm the server accepts passive mode and that the account can list the target path.
2. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "ftp-directory",
  "displayName": "Studio FTP",
  "config": {
    "roots": "ftp://media.example.org/audio/",
    "username": "archive-reader",
    "password": "…",
    "maxDepth": "2"
  }
}
```

3. Test it with `POST /api/v1/connectors/<connectorId>/test`.

## Capabilities

| Capability              | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                   | `connected`, `deep`                                                                                |
| Timeout                 | 20 000 ms (connect 5 000 ms, command 8 000 ms)                                                     |
| Rate limit              | concurrency only, max 1                                                                            |
| Max concurrent requests | 1                                                                                                  |
| Pagination              | no                                                                                                 |
| Incremental streaming   | yes                                                                                                |
| Server-side search      | **no** — filename matching is client-side                                                          |
| Direct media URLs       | **no**                                                                                             |
| Preview                 | yes                                                                                                |
| Exposes file size       | yes                                                                                                |
| Exposes duration        | no                                                                                                 |
| Exposes bitrate         | no                                                                                                 |
| Requires authentication | declared `false` (anonymous FTP is supported)                                                      |
| Private results         | **yes**                                                                                            |
| Robots posture          | `not_applicable`                                                                                   |
| Retry                   | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Declares `connected_private` when a non-anonymous `username` is configured, and `source_download`
otherwise. `mediaUrl` is always `null`: an `ftp://` URL is not something a browser can be handed,
so the server streams the file through a workspace-scoped mediated route once access is classified.
Because `producesPrivateResults` is true, results never enter the shared cross-tenant cache.

## Limits and caveats

- **PASV replies are re-validated.** The data-connection address a server returns is
  attacker-controlled, so it is re-classified against the URL safety policy before it is dialled
  (`rule: ftp-pasv:<rule>`). A server cannot use a PASV reply to point Auralis at an internal host.
- Roots with a `..` path segment are rejected at parse time, and during the walk any queued path
  that does not start with the root path is skipped.
- Bounded: 4 roots per search, depth cap 4, 30 directories listed per root, and the loop exits on
  abort or deadline. Entries whose name contains `/` or is `.`/`..` are skipped.
- Matching is filename-only token `coverage`, threshold 0.34. No duration or bitrate is available.
- Only `connected` and `deep` modes select this provider; it never runs in `quick`.
- The client closes the connection in a `finally` block, so a failure mid-walk still releases the
  socket — but one root that hangs consumes the whole per-provider deadline, since concurrency is 1.

## Troubleshooting

| Symptom                      | Health message                                            | What it means                                                                                                                      |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs          | `Add one or more FTP addresses to search them.`           | Status `not_configured`. `roots` is missing or blank.                                                                              |
| Configured but rejected      | `The configured FTP addresses are not valid ftp:// URLs.` | Status `not_configured`. Wrong scheme, bad port, or a `..` in the path.                                                            |
| Login fails                  | `The server rejected the stored credentials.`             | Status `auth_required`. Re-enter `username`/`password` on the connector; the stored password may also have failed to decrypt.      |
| Cannot connect at all        | `The FTP server could not be reached.`                    | Status `unavailable`. Firewall, passive-port range, or the URL safety policy rejecting the host or the PASV address.               |
| Connects but returns nothing | `Connected to <host>.`                                    | Status `ready`. The path is empty, deeper than `maxDepth`, past the 30-directory budget, or nothing scored 0.34 against the query. |
