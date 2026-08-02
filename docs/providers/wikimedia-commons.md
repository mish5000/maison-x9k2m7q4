# Wikimedia Commons

## What it searches

Audio files in the File namespace on Wikimedia Commons. The adapter calls the MediaWiki API at
`https://commons.wikimedia.org/w/api.php` using `generator=search` with `gsrsearch=filetype:audio
<query>` and `gsrnamespace=6`, requesting `imageinfo` with `iiprop=url|size|mime|extmetadata|
mediatype`. It reads only the first `imageinfo` entry per page. Author, licence and date come from
`extmetadata` (`Artist`, `Credit`, `LicenseShortName`, `UsageTerms`, `DateTimeOriginal`), are
stripped of HTML, and are carried through verbatim as attribution — never inferred.

## Status

Works out of the box. No API key, no configuration. Registered with `enabledByDefault: true` and
listed in `ZERO_CONFIG_PROVIDER_IDS`.

## Configuration

The adapter reads no configuration keys. `capabilities.requiredConfiguration` is empty, so
`configurationStatus` always returns `ready`. There are no secret keys for this provider.

## Setup

Nothing to do. It is not a connector, so it has no `POST /api/v1/connectors` body. Confirm it is
live with `GET /api/v1/providers/health` and look for `wikimedia-commons`.

## Capabilities

| Capability                  | Value                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                       | `quick`, `deep`                                                                                    |
| Timeout                     | 10 000 ms                                                                                          |
| Rate limit                  | token bucket, capacity 5, refill 1/s                                                               |
| Max concurrent requests     | 2                                                                                                  |
| Pagination                  | yes                                                                                                |
| Incremental streaming       | yes                                                                                                |
| Exact title search          | no                                                                                                 |
| Server-side search          | yes                                                                                                |
| Direct media URLs           | yes                                                                                                |
| Preview                     | yes                                                                                                |
| Exposes file size           | yes                                                                                                |
| Exposes duration            | yes                                                                                                |
| Exposes bitrate             | no                                                                                                 |
| Cacheable / private results | cacheable, not private                                                                             |
| Robots posture              | `api_terms_only`                                                                                   |
| Retry                       | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

Result limit scales with mode: 15 in `quick`, 40 in `deep`. The response body is capped at 1 MiB.

## Access classification

Declares `direct_download`. Commons publishes the file itself at the `imageinfo.url` returned by
the API, so a usable URL exists. As everywhere, that is a starting point only — `classifyAccess`
requires verification evidence before a download is offered. The `descriptionurl` becomes the
candidate's page URL, so visit source and copy source URL are available even when the download is
not.

## Limits and caveats

- Relevance is entirely MediaWiki's. There is no client-side re-ranking, so a low-quality
  `gsrsearch` match is emitted as-is and sorted later by the pipeline.
- Duration is only present when Commons has computed it; the adapter reads `imageinfo.duration` and
  does not parse it from anywhere else. Bitrate is never exposed.
- Only the first `imageinfo` entry is read. Files with multiple revisions surface the current one.
- Titles are cosmetically cleaned: the `File:` prefix, the extension and runs of `_`/`-` are
  stripped, so the displayed title may differ from the exact page title. `providerAssetId` keeps
  the page id.
- Licences vary per file. The adapter reports whatever Commons states and never normalises it into
  a licence family — a blank `rightsStatement` means Commons supplied none, not that the file is
  unencumbered.
- A non-200 status or a body that is not valid JSON ends the contribution silently.

## Troubleshooting

| Symptom                                  | Health message                            | What it means                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No results for an obviously present file | `Reachable.`                              | The `filetype:audio` generator search matched nothing. Commons search is title- and description-driven; try fewer, broader terms.                                                   |
| Sporadic empty contributions             | `Responded with status <code>.`           | Status `degraded`. Commonly 429 from the MediaWiki API under shared egress; the token bucket (5 capacity, 1/s) is deliberately conservative but a shared IP can still be throttled. |
| Provider never contributes               | `Wikimedia Commons could not be reached.` | Status `unavailable`. Check outbound HTTPS to `commons.wikimedia.org` and the egress URL policy.                                                                                    |
