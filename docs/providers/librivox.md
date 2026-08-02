# LibriVox

## What it searches

Public-domain audiobooks in the LibriVox catalogue, through the read-only JSON API at
`https://librivox.org/api/feed/audiobooks`. The adapter searches by title with a prefix match
(`title=^<text>`), using the normalised query's parsed title when one exists. Each result is one
_book_, not one chapter: title, first author, total running time, section count, language, copyright
year and the book's RSS feed address are read from the response. A book with neither a LibriVox page
URL nor a zip archive URL is skipped.

## Status

Works out of the box. No API key, no configuration. Registered with `enabledByDefault: true` and
listed in `ZERO_CONFIG_PROVIDER_IDS`.

## Configuration

The adapter reads no configuration keys. `capabilities.requiredConfiguration` is empty, so
`configurationStatus` always returns `ready`. There are no secret keys for this provider.

## Setup

Nothing to do. It is not a connector, so it has no `POST /api/v1/connectors` body. Confirm it is
live with `GET /api/v1/providers/health` and look for `librivox`.

## Capabilities

| Capability                  | Value                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                       | `quick`, `deep`                                                                                    |
| Timeout                     | 10 000 ms                                                                                          |
| Rate limit                  | token bucket, capacity 4, refill 1/s                                                               |
| Max concurrent requests     | 2                                                                                                  |
| Pagination                  | yes                                                                                                |
| Incremental streaming       | no                                                                                                 |
| Exact title search          | no                                                                                                 |
| Server-side search          | yes                                                                                                |
| Direct media URLs           | **no**                                                                                             |
| Preview                     | **no**                                                                                             |
| Exposes file size           | no                                                                                                 |
| Exposes duration            | yes                                                                                                |
| Exposes bitrate             | no                                                                                                 |
| Cacheable / private results | cacheable, not private                                                                             |
| Robots posture              | `api_terms_only`                                                                                   |
| Retry                       | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

Result limit scales with mode: 10 in `quick`, 30 in `deep`.

## Access classification

Declares `source_download`. The recording is genuinely downloadable and genuinely public domain,
but the API hands back a per-book landing page and a zip archive — not a per-chapter media URL. The
adapter therefore emits `mediaUrl: null` and lets the user go to the LibriVox page rather than
guessing a chapter URL that may not exist. A user gets download-through-source, visit source, copy
source URL and inspect metadata; there is no in-app preview, because `supportsPreview` is false and
there are no bytes to preview.

## Limits and caveats

- **Book-level granularity.** One candidate is one audiobook. Chapters are not enumerated, so a
  query matching a single chapter title will not match unless the book title matches too.
- **No fabricated media URL.** `url_zip_file` is a zip archive, not a playable audio file, so it is
  deliberately not offered as `mediaUrl`. The RSS feed address is preserved in
  `providerExtras.rssFeed` — point the [RSS provider](rss-feed.md) at it if you need per-chapter
  entries.
- Search is a _title prefix_ match (`^`). Searching for a word from the middle of a title returns
  nothing; author-only queries will not match.
- Rights are reported as `Public domain` (with the copyright year when present). That string comes
  from the adapter, not from a per-file licence statement.
- Duration is the whole book (`totaltimesecs`, falling back to parsing `totaltime`). Size and
  bitrate are never exposed.
- A non-200 status or a body that is not valid JSON ends the contribution silently.

## Troubleshooting

| Symptom                                | Health message                   | What it means                                                                                                                                     |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| No results for a book you know exists  | `Reachable.`                     | The title prefix match failed. Query the opening words of the title, not the author or a chapter name.                                            |
| Results appear but have no play button | —                                | Expected. `returnsDirectMediaUrls` and `supportsPreview` are both false; use _visit source_ and download from the LibriVox page.                  |
| Intermittent empty contributions       | `Responded with status <code>.`  | Status `degraded`. The LibriVox API is slow under load and returns non-200s; the 4-token bucket keeps request pressure low but cannot prevent it. |
| Provider never contributes             | `LibriVox could not be reached.` | Status `unavailable`. Check outbound HTTPS to `librivox.org`.                                                                                     |
