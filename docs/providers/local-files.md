# Local files

## What it searches

Directories on the server's own filesystem that the user explicitly selected. The adapter walks
each configured root breadth-first, skips dotfiles and dot-directories, and emits regular files
whose name looks like audio and whose filename matches the query. Size and modification time come
from `stat`. Nothing is read from outside a selected root, and results are marked private to the
workspace.

## Status

Needs configuration. At least one absolute directory path must be supplied in `roots` before the
provider leaves `not_configured`. Registered with `enabledByDefault: false`.

## Configuration

| Key     | Required | What it is                                                                                                                                      | Example                                   |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `roots` | required | Newline- or comma-separated directory paths, resolved with `path.resolve`. `configList` keeps at most 50 entries; the adapter uses the first 8. | `/srv/media/library, /srv/media/incoming` |

No secret keys are registered for this provider (`secretConfigKeys: []`). Paths are stored and
echoed back as ordinary public configuration.

## Setup

1. Confirm the server process can read the directories, and that they contain only material the
   workspace is entitled to search.
2. Create the connector — note the connector kind is `local-directory`, which maps to the
   `local-files` provider in `CONNECTOR_PROVIDER_BY_KIND`:

```http
POST /api/v1/connectors
Content-Type: application/json

{
  "kind": "local-directory",
  "displayName": "Library volume",
  "config": {
    "roots": "/srv/media/library\n/srv/media/incoming"
  }
}
```

3. Test it with `POST /api/v1/connectors/<connectorId>/test`, or check
   `GET /api/v1/providers/health`.

## Capabilities

| Capability              | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Modes                   | `connected`, `deep`                                                                                |
| Timeout                 | 10 000 ms                                                                                          |
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
| Private results         | **yes**                                                                                            |
| Robots posture          | `not_applicable`                                                                                   |
| Retry                   | default policy: 3 attempts, 250 ms base, 4 s cap, jitter, retryable on 408/425/429/500/502/503/504 |

## Access classification

Declares `user_owned`. The file is in storage the user selected, so a download is legitimate — but
there is no URL, so `mediaUrl` is always `null` and the server exposes the bytes through a
workspace-scoped mediated streaming route once access is classified. Because
`producesPrivateResults` is true, these results never enter a shared cross-tenant cache and are
never offered to another workspace.

## Limits and caveats

- **Symlinks cannot escape.** `isInsideRoot` is checked twice: once on each queued directory and
  again on every `join`-ed child path before it is read or emitted. A symlink pointing outside the
  selected folder is therefore rejected rather than followed.
- The same check is re-applied at read time. `openLocalAsset` and `readLocalSample` both re-resolve
  the path and re-verify it against the allowed roots before opening a stream, so a stored path can
  never be used to read an arbitrary file later.
- Bounded: 8 roots, depth 6, and 5 000 directory entries scanned per search across all roots. A
  very large library will be truncated rather than scanned exhaustively.
- Entries whose name starts with `.` are skipped entirely, directories included.
- Matching is filename-only token `coverage`, threshold 0.34. Tags inside the file are not read at
  this stage, so a well-tagged but badly named file will not match.
- Duration and bitrate are never exposed by this provider; only size and modification time.
- A directory that cannot be read, or a file whose `stat` fails, is skipped silently.
- Only `connected` and `deep` modes select this provider; it never runs in `quick`.

## Troubleshooting

| Symptom                           | Health message                               | What it means                                                                                                                          |
| --------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider never runs               | `Select one or more folders to search them.` | Status `not_configured`. `roots` is missing or blank.                                                                                  |
| Some folders missing from results | `<n> of <m> folders could not be read.`      | Status `degraded`. The path does not exist, is not a directory, or the server process lacks permission.                                |
| Nothing at all                    | `<n> of <n> folders could not be read.`      | Status `unavailable`. Every configured root failed to `stat` — usually a wrong absolute path or a container mount that is not present. |
| Folders readable but no results   | `<n> folders available.`                     | Status `ready`. Nothing matched at 0.34 coverage, the files sit deeper than depth 6, or the 5 000-entry scan budget ran out first.     |
