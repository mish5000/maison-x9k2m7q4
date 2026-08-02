# WebDAV storage

## What it searches

A WebDAV collection and everything beneath it — Nextcloud, ownCloud, or any generic DAV server. The
adapter issues `PROPFIND` with `Depth: 1` against the configured collection, parses the multistatus
response for `displayname`, `getcontentlength`, `getcontenttype`, `getlastmodified`, `resourcetype`
and `getetag`, queues child collections, and emits the audio files it finds. Credentials are sent
as HTTP Basic and only to the configured host.

## Status

Needs configuration. All three of `baseUrl`, `username` and `password` must be present before the
provider leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key           | Required                 | What it is                                                                                                                          | Example                                                       |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `baseUrl`     | required                 | Collection URL. A trailing `/` is added if missing, and it is the prefix traversal is confined to.                                  | `https://cloud.example.org/remote.php/dav/files/alice/Music/` |
| `username`    | required                 | Login user. Also used as the connector's account identity. Stored as public configuration — it is **not** in the secret key list.   | `alice`                                                       |
| `password`    | required                 | **Secret.** Login password; an app password is strongly preferred.                                                                  | `••••••••`                                                    |
| `displayName` | supplied by the platform | Injected by `ConnectorRepository.resolveConfig` from the connector's display name and used as the provider display name on results. | `Nextcloud music`                                             |

`password` is the only registered secret key (`WEBDAV_SECRET_CONFIG_KEYS`). It is encrypted at rest
with AES-256-GCM and is never returned by the API — `toConnectorSummary` masks it, and only the
search orchestrator and the connection test read the decrypted value. `username` is deliberately
not a secret: it is displayed as the connector's account identity.

## Setup

1. Generate an app password rather than using the account password. Nextcloud and ownCloud both
   support this, and it can be revoked without touching the account.
2. Copy the collection URL from the WebDAV settings panel and append the sub-folder you want to
   scope to.
3. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "webdav",
  "displayName": "Nextcloud music",
  "config": {
    "baseUrl": "https://cloud.example.org/remote.php/dav/files/alice/Music/",
    "username": "alice",
    "password": "…"
  }
}
```

4. Test it with `POST /api/v1/connectors/<connectorId>/test`.

## Capabilities

| Capability              | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                   | `connected` only                                                                                   |
| Timeout                 | 15 000 ms                                                                                          |
| Rate limit              | token bucket, capacity 6, refill 3/s                                                               |
| Max concurrent requests | 2                                                                                                  |
| Pagination              | no                                                                                                 |
| Incremental streaming   | yes                                                                                                |
| Server-side search      | **no** — filename matching is client-side                                                          |
| Direct media URLs       | **no**                                                                                             |
| Preview                 | yes                                                                                                |
| Exposes file size       | yes                                                                                                |
| Exposes duration        | no                                                                                                 |
| Exposes bitrate         | no                                                                                                 |
| Requires authentication | **yes**                                                                                            |
| Private results         | **yes**                                                                                            |
| Robots posture          | `not_applicable`                                                                                   |
| Retry                   | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Declares `connected_private`. The file is in an account the workspace connected, so it is
downloadable for that workspace and no other — `producesPrivateResults` is true, so results never
enter the shared cross-tenant cache. `mediaUrl` is always `null`: the file is behind Basic auth, so
there is no URL that can be handed to a browser. `DownloadControl` streams it through the
workspace-scoped mediated route. If the stored credentials cannot be resolved, `classifyAccess`
narrows the result to `restricted` and offers _connect account_ rather than _download_.

## Limits and caveats

- **Traversal never leaves the configured root.** Every entry's absolute href must start with the
  normalised `baseUrl`; anything else is discarded, including hrefs a server rewrites onto a
  different path.
- Requests are pinned with `allowHosts` to the `baseUrl` host, and the egress layer drops the
  `authorization` header on any cross-origin redirect, so credentials cannot be replayed elsewhere.
- Bounded: 40 collections fetched per search, depth cap 4, 4 MiB per PROPFIND response, and 2 000
  `<response>` elements parsed. A deep library will be truncated — point `baseUrl` at a sub-folder.
- Matching is filename-only token `coverage`, threshold 0.34, against `displayname` (falling back to
  the last URL segment). Only names that look like audio are emitted.
- Only size and content type (from `getcontentlength` / `getcontenttype`) are exposed. Duration and
  bitrate are not.
- Both `207` and `200` are accepted as successful PROPFIND responses; anything else that is not
  401/403 is skipped and the walk continues.
- `connected` mode only. This provider never runs in `quick` or `deep`.

## Troubleshooting

| Symptom                                   | Health message                                                 | What it means                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs                       | `Connect a WebDAV folder to search it. Missing: <keys>.`       | Status `not_configured`. The named keys are absent or blank.                                                                                                  |
| Login rejected                            | `The stored credentials were rejected. Reconnect this folder.` | Status `auth_required` (401/403). Most often the account password was used where an app password is required, or two-factor authentication blocks Basic auth. |
| Server answers but not with a multistatus | `The server responded with status <code>.`                     | Status `degraded`. Usually `baseUrl` points at the web UI rather than the DAV endpoint — it must be the `remote.php/dav/...` style path.                      |
| Unreachable                               | `The WebDAV server could not be reached.`                      | Status `unavailable`. DNS, TLS, egress policy, or a private host the URL safety policy blocks.                                                                |
| Connects but finds nothing                | `Connected.`                                                   | Status `ready`. Nothing scored 0.34 against the query, or the files sit below depth 4 or beyond the 40-collection budget.                                     |
