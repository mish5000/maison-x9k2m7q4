# HTTP directory listings

## What it searches

Directory index pages of the Apache/nginx autoindex kind, at addresses an administrator configured.
The adapter fetches each configured root, parses the anchors out of the HTML (tolerantly — it also
reads the trailing size and date columns of the common `<pre>` layout), queues sub-directories, and
emits the audio files it finds. It is a bounded walker of directories you nominated, not a crawler:
every link is checked against the configured root prefix before it is followed or emitted.

## Status

Needs configuration. At least one directory address must be supplied in `roots` before the provider
leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key        | Required | What it is                                                                                                                                           | Example                            |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `roots`    | required | Newline- or comma-separated directory URLs. `configList` keeps at most 50 entries; the adapter uses the first 8. A trailing `/` is added if missing. | `https://media.example.org/audio/` |
| `maxDepth` | optional | Traversal depth below each root. Defaults to 2 in `quick`/`connected` and 3 in `deep`; clamped to a hard maximum of 4.                               | `3`                                |

No secret keys are registered for this provider (`secretConfigKeys: []`); everything above is
stored and echoed back as ordinary public configuration.

## Setup

1. Confirm the server actually emits an autoindex page (not a custom app page) and that the URL the
   listing is served from is the prefix you want to confine traversal to.
2. Create the connector:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "http-directory",
  "displayName": "Studio archive",
  "config": {
    "roots": "https://media.example.org/audio/",
    "maxDepth": "3"
  }
}
```

3. Test it with `POST /api/v1/connectors/<connectorId>/test`, or check
   `GET /api/v1/providers/health`.

## Capabilities

| Capability                  | Value                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                       | `quick`, `deep`, `connected`                                                                       |
| Timeout                     | 15 000 ms (per listing request: 8 000 ms)                                                          |
| Rate limit                  | token bucket, capacity 6, refill 3/s                                                               |
| Max concurrent requests     | 2                                                                                                  |
| Pagination                  | no                                                                                                 |
| Incremental streaming       | yes                                                                                                |
| Server-side search          | **no** — filename matching is client-side                                                          |
| Direct media URLs           | yes                                                                                                |
| Preview                     | yes                                                                                                |
| Exposes file size           | yes                                                                                                |
| Exposes duration            | no                                                                                                 |
| Exposes bitrate             | no                                                                                                 |
| Cacheable / private results | cacheable, not private                                                                             |
| Robots posture              | `user_configured`                                                                                  |
| Retry                       | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Declares `direct_download`. The listing links directly at the file over HTTP, so a URL Auralis can
hand over does exist. `producesPrivateResults` is false, so results can be shared-cached — only
configure roots whose contents you are content to expose to the whole deployment.

## Limits and caveats

- **Traversal is confined to the configured root.** `isWithinRoot` compares origin and requires the
  resolved path to start with the root's path prefix; anything else is discarded. This is what
  stops a crafted listing turning the adapter into a general crawler.
- **Bounded.** 8 roots, a hard depth cap of 4, at most 40 listing pages fetched per search (shared
  across all roots), 1 MiB per listing, 2 000 anchors parsed per page, and a visited set to avoid
  loops.
- Only names that look like audio, plus playlist containers (`m3u`, `m3u8`, `pls`, `cue`), are
  emitted. Playlists are surfaced so the pipeline can inspect them; the verifier classifies them as
  playlists and the orchestrator rejects them as playable files.
- Matching is filename-only token `coverage` against the query, threshold 0.34. A directory whose
  files are numbered rather than named will match almost nothing.
- Size is parsed from the human-readable autoindex column (`12M`, `340K`) and is therefore
  approximate. Duration and bitrate are never exposed.
- Listing formats vary. A theme that renders sizes in a table without the expected trailing column
  yields entries with `sizeBytes: null` rather than a wrong number.
- A root that is unreachable or non-200 is logged and skipped; the remaining roots still run.

## Troubleshooting

| Symptom                                          | Health message                                                                                                           | What it means                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs                              | `Add one or more directory addresses to search them.`                                                                    | Status `not_configured`. `roots` is missing or blank.                                                                                   |
| Configured, reachable, no results                | `<n> directories configured.`                                                                                            | Status `ready`. Either no filename scored 0.34 or higher, or the files sit deeper than `maxDepth`, or the 40-page budget ran out first. |
| Only the first root produces results             | `<n> directories configured.`                                                                                            | The page budget is shared across roots and consumed in order. Raise specificity or split into separate connectors.                      |
| Nothing found on a site that clearly lists files | `<n> directories configured.`                                                                                            | The page is probably an application page, not an autoindex — the anchors do not resolve under the root prefix and are discarded.        |
| Directory listed but silent                      | `The first configured directory responded with status <code>.` or `The first configured directory could not be reached.` | Status `degraded`. Only the _first_ root is probed; check the log for "A configured directory could not be listed".                     |
