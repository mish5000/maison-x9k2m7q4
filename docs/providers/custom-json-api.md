# Custom JSON API

## What it searches

Whatever an internal catalogue's HTTP JSON endpoint returns. An administrator supplies a URL
template and a set of dotted field paths; the adapter substitutes the query into the template,
fetches the JSON, resolves `itemsPath` to an array, and maps each element onto a candidate using
the configured paths. No code is evaluated — mappings are plain dotted paths resolved against
parsed JSON, and prototype keys are never traversed, so a malicious configuration cannot execute
anything.

## Status

Needs configuration. All four of `urlTemplate`, `itemsPath`, `titlePath` and `mediaUrlPath` must be
present before the provider leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key                    | Required                 | What it is                                                                                                                                                                                 | Example                                                        |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `urlTemplate`          | required                 | Search URL. `{query}`, `{limit}` and `{locale}` are substituted and URL-encoded; `{limit}` is 20 in `connected` and 50 in `deep`.                                                          | `https://media.example.org/api/search?q={query}&limit={limit}` |
| `itemsPath`            | required                 | Dotted path to the result array. Empty means the response root.                                                                                                                            | `data.results`                                                 |
| `titlePath`            | required                 | Dotted path to the title, relative to each item. An item with no title is skipped.                                                                                                         | `name`                                                         |
| `mediaUrlPath`         | required                 | Dotted path to the media URL. An item without one is emitted as `metadata_only`.                                                                                                           | `files.0.url`                                                  |
| `creatorPath`          | optional                 | Dotted path to the creator.                                                                                                                                                                | `artist.name`                                                  |
| `pageUrlPath`          | optional                 | Dotted path to a human landing page.                                                                                                                                                       | `permalink`                                                    |
| `filenamePath`         | optional                 | Dotted path to the filename.                                                                                                                                                               | `files.0.filename`                                             |
| `durationPath`         | optional                 | Dotted path to duration. Accepts seconds, `M:SS` or `H:MM:SS`.                                                                                                                             | `duration_seconds`                                             |
| `sizePath`             | optional                 | Dotted path to size in bytes.                                                                                                                                                              | `files.0.bytes`                                                |
| `bitratePath`          | optional                 | Dotted path to bitrate. Values under 10 000 are treated as kbps and scaled to bits per second.                                                                                             | `files.0.bitrate`                                              |
| `mimeTypePath`         | optional                 | Dotted path to the MIME type.                                                                                                                                                              | `files.0.content_type`                                         |
| `publishedAtPath`      | optional                 | Dotted path to the publication date.                                                                                                                                                       | `published_at`                                                 |
| `artworkPath`          | optional                 | Dotted path to artwork.                                                                                                                                                                    | `images.large`                                                 |
| `idPath`               | optional                 | Dotted path to a stable id. Falls back to the media URL, then the title.                                                                                                                   | `id`                                                           |
| `authHeaderName`       | optional                 | Header name for authentication. Lower-cased before use. Only sent when both name and value are set.                                                                                        | `authorization`                                                |
| `authHeaderValue`      | optional                 | **Secret.** Header value.                                                                                                                                                                  | `Bearer …`                                                     |
| `accessClassification` | optional                 | Starting classification for items that have a media URL. One of `direct_download`, `source_download`, `preview_only`, `metadata_only`. Anything else, or unset, means `connected_private`. | `source_download`                                              |
| `displayName`          | supplied by the platform | Injected by `ConnectorRepository.resolveConfig`; used as the provider display name and the attribution on results.                                                                         | `Internal catalogue`                                           |

`authHeaderValue` is the only registered secret key (`CUSTOM_API_SECRET_CONFIG_KEYS`). It is
encrypted at rest with AES-256-GCM and is never returned by the API — `toConnectorSummary` masks
it, and only the search orchestrator and the connection test read the decrypted value.

## Setup

1. Confirm the endpoint returns JSON, accepts the query as a URL parameter, and is reachable from
   the server under the egress URL policy.
2. Note the dotted path to the result array and to the title and media URL fields within one item.
3. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "custom-json-api",
  "displayName": "Internal catalogue",
  "config": {
    "urlTemplate": "https://media.example.org/api/search?q={query}&limit={limit}",
    "itemsPath": "data.results",
    "titlePath": "name",
    "mediaUrlPath": "files.0.url",
    "creatorPath": "artist.name",
    "durationPath": "duration_seconds",
    "authHeaderName": "authorization",
    "authHeaderValue": "Bearer …",
    "accessClassification": "source_download"
  }
}
```

4. Test it with `POST /api/v1/connectors/<connectorId>/test`. The test reports whether `itemsPath`
   actually resolved to a list, which is the usual mistake.

## Capabilities

| Capability              | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                   | `connected`, `deep`                                                                                |
| Timeout                 | 12 000 ms                                                                                          |
| Rate limit              | token bucket, capacity 6, refill 3/s                                                               |
| Max concurrent requests | 2                                                                                                  |
| Pagination              | no                                                                                                 |
| Incremental streaming   | yes                                                                                                |
| Server-side search      | **yes** — the endpoint does the matching                                                           |
| Direct media URLs       | yes                                                                                                |
| Preview                 | yes                                                                                                |
| Exposes file size       | yes                                                                                                |
| Exposes duration        | yes                                                                                                |
| Exposes bitrate         | **yes** — the only provider that does                                                              |
| Requires authentication | **yes**                                                                                            |
| Private results         | **yes**                                                                                            |
| Robots posture          | `user_configured`                                                                                  |
| Retry                   | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Items with a media URL are declared with whatever `accessClassification` says, defaulting to
`connected_private` when unset or unrecognised — private-by-default, so a misconfiguration cannot
accidentally publish an internal catalogue. Items without a media URL are always declared
`metadata_only`, regardless of configuration. `producesPrivateResults` is true, so results never
enter the shared cross-tenant cache.

Note that `classifyAccess` still narrows: even with `accessClassification: "direct_download"`, a
result needs positive verification evidence before a download is offered.

## Limits and caveats

- One request per search; there is no pagination. Control result volume with `{limit}` in the
  template. At most 200 items from the response are considered, then `context.maxCandidates` caps
  emission.
- The request is pinned with `allowHosts` to the template's host and the response body is capped at
  4 MiB.
- Field values are coerced with `asString`: strings and finite numbers only. Booleans, objects and
  arrays resolve to `null`.
- `resolvePath` walks own enumerable properties only, and numeric segments index arrays. A path
  that does not resolve yields `null` rather than an error, so a typo shows up as a missing field,
  not a failure.
- Bitrate normalisation is a heuristic: a value under 10 000 is assumed to be kbps and multiplied
  by 1 000. A genuinely very low bit rate in bits per second will be reported 1 000× too high.
- No relevance filtering is applied locally — the endpoint's own ordering is preserved and the
  pipeline scores it downstream.
- The auth header is only sent when _both_ `authHeaderName` and `authHeaderValue` are set; setting
  one alone silently sends no credentials.

## Troubleshooting

| Symptom                          | Health message                                                        | What it means                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs              | `Configure this API to search it. Missing: <keys>.`                   | Status `not_configured`. The named required keys are absent or blank.                                                                           |
| Test passes but no results       | `Connected, but the configured items path did not resolve to a list.` | Status `degraded`. `itemsPath` points at an object or a missing key. Check it against a real response body.                                     |
| Credentials rejected             | `The stored credentials were rejected.`                               | Status `auth_required` (401/403). Wrong header name, expired token, or only one of the two auth keys set.                                       |
| Endpoint errors                  | `The API responded with status <code>.`                               | Status `degraded`. The template probably produces a malformed URL for the health probe, which substitutes `query=test`, `limit=1`, `locale=en`. |
| Unreachable                      | `The API could not be reached.`                                       | Status `unavailable`. DNS, TLS, or the URL safety policy blocking a private host.                                                               |
| Results appear with wrong titles | `Connected and the item path resolved correctly.`                     | Status `ready`. `titlePath` is resolving to the wrong field — paths are relative to each _item_, not to the response root.                      |
