# S3-compatible storage

## What it searches

A single bucket on any service speaking the S3 API — AWS S3, MinIO, Backblaze B2's S3 endpoint,
Cloudflare R2, Wasabi and others. The adapter calls `ListObjectsV2` with SigV4 request signing
(computed in-process; no AWS SDK), pages through the results with the continuation token, and emits
objects whose key looks like audio and matches the query. Credentials never leave the server, and
object bytes are never proxied through Auralis.

## Status

Needs configuration. All five of `endpoint`, `region`, `bucket`, `accessKeyId` and
`secretAccessKey` must be present before the provider leaves `not_configured`. Registered with
`enabledByDefault: false`.

## Configuration

| Key               | Required                 | What it is                                                                                                                          | Example                              |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `endpoint`        | required                 | Service endpoint URL.                                                                                                               | `https://s3.eu-west-1.amazonaws.com` |
| `region`          | required                 | Signing region.                                                                                                                     | `eu-west-1`                          |
| `bucket`          | required                 | Bucket name. Also used as the connector's account identity.                                                                         | `studio-masters`                     |
| `accessKeyId`     | required                 | **Secret.** Access key id.                                                                                                          | `AKIA…`                              |
| `secretAccessKey` | required                 | **Secret.** Secret access key.                                                                                                      | `••••••••`                           |
| `prefix`          | optional                 | Restricts listing to a key prefix.                                                                                                  | `sessions/2026/`                     |
| `pathStyle`       | optional                 | `"true"` forces path-style addressing (the MinIO default). Anything else uses virtual-host addressing.                              | `true`                               |
| `displayName`     | supplied by the platform | Injected by `ConnectorRepository.resolveConfig` from the connector's display name and used as the provider display name on results. | `Studio masters`                     |

`accessKeyId` and `secretAccessKey` are the registered secret keys (`S3_SECRET_CONFIG_KEYS`). Both
are encrypted at rest with AES-256-GCM and are never returned by the API — `toConnectorSummary`
masks them, and only the search orchestrator, the connection test and the download-intent path read
the decrypted values.

## Setup

1. Create a credential scoped as narrowly as possible: `s3:ListBucket` on the bucket (ideally
   limited to the prefix) and `s3:GetObject` on the objects. Nothing else is used.
2. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "s3-compatible",
  "displayName": "Studio masters",
  "config": {
    "endpoint": "https://s3.eu-west-1.amazonaws.com",
    "region": "eu-west-1",
    "bucket": "studio-masters",
    "accessKeyId": "AKIA…",
    "secretAccessKey": "…",
    "prefix": "sessions/2026/",
    "pathStyle": "false"
  }
}
```

3. Test it with `POST /api/v1/connectors/<connectorId>/test`. For MinIO set `pathStyle` to `true`.

## Capabilities

| Capability              | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                   | `connected` only                                                                                   |
| Timeout                 | 15 000 ms                                                                                          |
| Rate limit              | token bucket, capacity 10, refill 5/s                                                              |
| Max concurrent requests | 2                                                                                                  |
| Pagination              | yes — 2 list pages in `connected`, up to 5 in `deep` context, 1 000 keys per page                  |
| Incremental streaming   | yes                                                                                                |
| Server-side search      | **no** — key matching is client-side                                                               |
| Direct media URLs       | **no** during search                                                                               |
| Preview                 | yes                                                                                                |
| Exposes file size       | yes                                                                                                |
| Exposes duration        | no                                                                                                 |
| Exposes bitrate         | no                                                                                                 |
| Requires authentication | **yes**                                                                                            |
| Private results         | **yes**                                                                                            |
| Robots posture          | `not_applicable`                                                                                   |
| Retry                   | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Declares `connected_private`. The object is in an account the workspace connected, so a download is
legitimate for that workspace and nobody else — `producesPrivateResults` is true, so these results
never enter the shared cross-tenant cache. `mediaUrl` is deliberately `null` during search.

At download time `DownloadControl` mints a **short-lived presigned GET URL** (`presignS3Url`, TTL
300 seconds) so the bytes travel from the storage service straight to the browser. Auralis never
proxies the object and never persists a signed URL. If the connector's credentials cannot be
resolved, `classifyAccess` narrows the result to `restricted` and the user is offered
_connect account_ instead of _download_.

## Limits and caveats

- **`connected` mode only.** This provider never runs in `quick` or `deep`; a search must be in
  connected mode for it to be selected.
- Matching is client-side: the key with `/` replaced by spaces is scored with token `coverage`,
  threshold 0.34, and only keys whose final segment looks like audio are considered. There is no
  server-side search in the S3 API.
- Listing is bounded to 2 pages (5 in a `deep` context) of 1 000 keys each, and the response body
  is capped at 4 MiB. A large flat bucket will be truncated — use `prefix` to narrow it.
- Requests are pinned with `allowHosts` to the computed bucket host, so a redirect elsewhere is
  refused by the egress layer.
- Only size and last-modified are available. Duration and bitrate are never exposed at search time.
- SigV4 is computed with `UNSIGNED-PAYLOAD`; server clock skew beyond the provider's tolerance will
  cause signature rejections that look like credential failures.

## Troubleshooting

| Symptom                                       | Health message                                                   | What it means                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs                           | `Connect an S3-compatible bucket to search it. Missing: <keys>.` | Status `not_configured`. The named keys are absent or blank.                                                                     |
| Credentials rejected                          | `The stored credentials were rejected. Reconnect this bucket.`   | Status `auth_required` (401/403). Wrong key, missing `s3:ListBucket`, wrong `region`, or server clock skew.                      |
| MinIO returns 404 or a bucket-not-found error | `The storage endpoint responded with status <code>.`             | Status `degraded`. Almost always `pathStyle` — set it to `"true"` for MinIO and most self-hosted gateways.                       |
| Endpoint unreachable                          | `The storage endpoint could not be reached.`                     | Status `unavailable`. DNS, egress policy, or a private endpoint the URL safety policy blocks.                                    |
| Connects but finds nothing                    | `Connected to bucket <bucket>.`                                  | Status `ready`. No key scored 0.34 against the query, or the matching objects sit beyond the page budget — narrow with `prefix`. |
