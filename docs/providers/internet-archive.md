# Internet Archive

## What it searches

Audio items on archive.org. The adapter queries the public `advancedsearch.php` endpoint with a
Lucene-style query pinned to `mediatype:(audio)`, then fetches `https://archive.org/metadata/<id>`
for each matching item to enumerate the files inside it. Audio files are ranked (originals first,
then FLAC, VBR MP3, 128 kbps, 64 kbps, with small bonuses for a parseable size or length) and at
most six files per item are emitted. Item-level title, creator, collection, rights and publication
date are carried through verbatim; nothing is inferred.

## Status

Works out of the box. No API key, no configuration. Registered with `enabledByDefault: true` and
listed in `ZERO_CONFIG_PROVIDER_IDS`.

## Configuration

The adapter reads no configuration keys. `capabilities.requiredConfiguration` is empty, so
`configurationStatus` always returns `ready`. There are no secret keys for this provider.

## Setup

Nothing to do. It is not a connector, so it has no `POST /api/v1/connectors` body. To confirm it is
live, call `GET /api/v1/providers/health` and look for `internet-archive`.

## Capabilities

| Capability                  | Value                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                       | `quick`, `deep`                                                                                    |
| Timeout                     | 12 000 ms                                                                                          |
| Rate limit                  | token bucket, capacity 8, refill 2/s                                                               |
| Max concurrent requests     | 3                                                                                                  |
| Pagination                  | yes                                                                                                |
| Incremental streaming       | yes                                                                                                |
| Exact title search          | yes                                                                                                |
| Server-side search          | yes                                                                                                |
| Direct media URLs           | yes                                                                                                |
| Preview                     | yes                                                                                                |
| Exposes file size           | yes                                                                                                |
| Exposes duration            | yes                                                                                                |
| Exposes bitrate             | no                                                                                                 |
| Cacheable / private results | cacheable, not private                                                                             |
| Robots posture              | `api_terms_only`                                                                                   |
| Retry                       | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

Row counts scale with mode: 12 search rows in `quick`, 30 in `deep`.

## Access classification

Declares `direct_download`. Archive.org serves item files straight from
`https://archive.org/download/<identifier>/<file>`, so a URL that Auralis can hand over does exist.
That declaration is only a starting point: `classifyAccess` still requires positive verification
evidence before a download is offered, and will narrow the result to `unknown` or `metadata_only`
otherwise. In practice a user gets preview, download, copy direct URL, and visit source (the
`https://archive.org/details/<identifier>` page).

## Limits and caveats

- Query terms are stripped of Lucene metacharacters (`+ - & | ! ( ) { } [ ] ^ " ~ * ? : \ /`)
  before being sent, so punctuation-heavy queries lose precision rather than erroring.
- At most four excluded terms from the normalised query are translated into `NOT` clauses.
- One metadata request is made per search hit, each capped at 1 MiB and 6 s, and the loop exits as
  soon as `context.deadlineMs` passes. A slow item therefore reduces coverage rather than failing
  the search.
- Only files whose extension looks like audio _and_ whose `format` matches one of the known Archive
  format hints are considered; unusual derivatives are skipped.
- Six files per item is a hard cap, so a 200-track item contributes only its six best-ranked files.
- Bitrate is never exposed even though Archive format strings imply it; the value is not parsed.
- The search endpoint returns non-200 or non-JSON under load. Both cases end the provider's
  contribution silently — no partial or fabricated candidates.

## Troubleshooting

| Symptom                               | Health message                              | What it means                                                                                                                               |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No results, provider looks fine       | `Reachable.`                                | The endpoint answered but the query matched nothing, or every match's metadata request timed out inside the deadline. Retry in `deep` mode. |
| Intermittent gaps under load          | `The archive responded with status <code>.` | Archive.org returned a non-200 (commonly 429 or 503). Status is `degraded`; the circuit breaker may open if it persists.                    |
| Provider absent from results entirely | `The archive could not be reached.`         | Status `unavailable` — DNS, egress policy or connectivity. Check that outbound HTTPS to `archive.org` is permitted.                         |
