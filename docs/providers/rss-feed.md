# RSS and Atom feeds

## What it searches

Feeds that a user or administrator explicitly configured. This provider never discovers feeds on
its own. Each configured feed URL is fetched through `context.fetch`, parsed with the hardened XML
reader (no DOCTYPE, no entity expansion), and read as either RSS 2.0 (`rss > channel > item`) or
Atom (`feed > entry`). Media URLs come from an `<enclosure url>` or a `<link rel="enclosure" href>`;
size comes from the enclosure's `length`, MIME type from its `type`, and duration from a
`<duration>` element. Because feeds have no server-side search, matching is applied client-side.

## Status

Needs configuration. At least one feed address must be supplied in `feeds` before the provider
leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key     | Required | What it is                                                                                                                | Example                                                       |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `feeds` | required | Newline- or comma-separated list of feed URLs. `configList` keeps at most 50 entries; the adapter then uses the first 12. | `https://example.org/show.xml, https://example.org/other.xml` |

No secret keys are registered for this provider (`secretConfigKeys: []`), so nothing here is
encrypted at rest — do not put a feed URL containing an embedded token in this field, because it is
stored and echoed back as ordinary public configuration.

## Setup

1. Collect the feed addresses. Each must be reachable from the server, over a scheme and host the
   egress URL policy allows.
2. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "rss-feed",
  "displayName": "Field recording podcasts",
  "config": {
    "feeds": "https://example.org/show.xml\nhttps://example.org/other.xml"
  }
}
```

3. Test it with `POST /api/v1/connectors/<connectorId>/test`, or check
   `GET /api/v1/providers/health`.

## Capabilities

| Capability                  | Value                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                       | `quick`, `deep`, `connected`                                                                       |
| Timeout                     | 12 000 ms                                                                                          |
| Rate limit                  | concurrency only, max 3                                                                            |
| Max concurrent requests     | 3                                                                                                  |
| Pagination                  | no                                                                                                 |
| Incremental streaming       | yes                                                                                                |
| Server-side search          | **no** — relevance is applied client-side                                                          |
| Direct media URLs           | yes                                                                                                |
| Preview                     | yes                                                                                                |
| Exposes file size           | yes                                                                                                |
| Exposes duration            | yes                                                                                                |
| Exposes bitrate             | no                                                                                                 |
| Cacheable / private results | cacheable, not private                                                                             |
| Robots posture              | `user_configured`                                                                                  |
| Retry                       | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

An item with an enclosure URL is declared `direct_download`; an item without one is declared
`metadata_only`. That mirrors reality: a podcast enclosure is a public, directly fetchable file,
whereas an entry with only a web link is a page, not a recording. `producesPrivateResults` is
false, so results may enter the shared cache — configure only feeds you are content to have cached
across the deployment.

## Limits and caveats

- **No server-side search.** Every configured feed is fetched in full on every search, then scored
  locally with token `coverage` — the title, and the title plus description at 0.7 weight — and
  anything below 0.34 is discarded. Survivors are capped at 10 items in `quick`/`connected` and 25
  in `deep`.
- Hard bounds: 12 feeds per search, 300 items parsed per feed, 2 MiB per feed response.
- A feed that is unreachable, non-200 or unparseable is logged and skipped; the remaining feeds
  still run.
- Descriptions are stripped of tags and truncated to 500 characters. They are used for scoring and
  kept in `providerExtras.summary`.
- Artwork falls back to the channel-level image when an item has none.
- Item identity is `<guid>`, falling back to the media URL, falling back to `<feedUrl>#<index>` — a
  feed that reuses GUIDs will produce unstable asset ids.

## Troubleshooting

| Symptom                   | Health message                                                                                                 | What it means                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs       | `Add one or more feed addresses to search them.`                                                               | Status `not_configured`. `feeds` is missing or blank.                                                                                                                                         |
| Configured but no results | `<n> feeds configured.`                                                                                        | Status `ready`. The feeds parsed but nothing scored at or above 0.34 coverage against the query. Try terms that appear in episode titles.                                                     |
| Some episodes missing     | `<n> feeds configured.`                                                                                        | Only the first 300 items per feed are parsed, and only the top 10/25 by score are emitted.                                                                                                    |
| Feed listed but silent    | `The first configured feed responded with status <code>.` or `The first configured feed could not be reached.` | Status `degraded`. Only the _first_ feed is probed by the health check, so a healthy first feed can mask a broken later one — check the server log for "A configured feed could not be read". |
