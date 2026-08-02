# Providers

A provider is an adapter that turns a normalised query into a stream of raw candidates from exactly
one kind of source. It implements `SearchProvider` (`auralis/packages/core/src/domain/provider.ts`)
and nothing else. The contract is narrow on purpose: a provider streams candidates as it finds them
(yield early, yield often), honours both the `AbortSignal` it is handed and `context.deadlineMs`,
performs no network I/O of its own — every request goes through the SSRF-hardened `context.fetch`,
never global `fetch` — and makes no access decisions beyond declaring a conservative starting point
in `declaredAccess`. The real decision is made later by `classifyAccess`
(`packages/core/src/access/classify.ts`), which may narrow a provider's declaration but never widen
it. A provider must never fabricate a media URL: if it has no URL it can hand over, it emits `null`
and a classification that does not imply a download.

## Registered providers

Values below are taken from each adapter's `capabilities` declaration and from
`packages/core/src/providers/index.ts`.

| id                                          | Display name            | Category                  | Auth required | Required configuration                                           | Modes                  | Direct media URLs | Private results |
| ------------------------------------------- | ----------------------- | ------------------------- | ------------- | ---------------------------------------------------------------- | ---------------------- | ----------------- | --------------- |
| [`internet-archive`](internet-archive.md)   | Internet Archive        | `open_archive`            | no            | —                                                                | quick, deep            | yes               | no              |
| [`wikimedia-commons`](wikimedia-commons.md) | Wikimedia Commons       | `open_data`               | no            | —                                                                | quick, deep            | yes               | no              |
| [`librivox`](librivox.md)                   | LibriVox                | `open_archive`            | no            | —                                                                | quick, deep            | no                | no              |
| [`rss-feed`](rss-feed.md)                   | RSS and Atom feeds      | `podcast_feed`            | no            | `feeds`                                                          | quick, deep, connected | yes               | no              |
| [`http-directory`](http-directory.md)       | HTTP directory listings | `http_directory`          | no            | `roots`                                                          | quick, deep, connected | yes               | no              |
| [`ftp-directory`](ftp-directory.md)         | FTP directories         | `ftp_directory`           | no            | `roots`                                                          | connected, deep        | no                | yes             |
| [`local-files`](local-files.md)             | Local files             | `local_files`             | no            | `roots`                                                          | connected, deep        | no                | yes             |
| [`s3-compatible`](s3-compatible.md)         | S3-compatible storage   | `connected_storage`       | yes           | `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey` | connected              | no                | yes             |
| [`webdav`](webdav.md)                       | WebDAV storage          | `connected_storage`       | yes           | `baseUrl`, `username`, `password`                                | connected              | no                | yes             |
| [`custom-json-api`](custom-json-api.md)     | Custom JSON API         | `organisation_repository` | yes           | `urlTemplate`, `itemsPath`, `titlePath`, `mediaUrlPath`          | connected, deep        | yes               | yes             |

`internet-archive`, `wikimedia-commons` and `librivox` are registered with `enabledByDefault: true`
and are listed in `ZERO_CONFIG_PROVIDER_IDS`. Every other adapter is registered but stays in
`not_configured` until its required keys exist for the workspace — it is never silently dropped.

Note two declarations that read oddly at first glance and are correct as written:
`ftp-directory` declares `requiresAuthentication: false` because anonymous FTP is a supported mode,
even though it accepts credentials; `custom-json-api` declares `requiresAuthentication: true`
although the auth header keys themselves are optional, because it is treated as a
workspace-private connector regardless.

## Provider status

`ProviderStatus` is declared in `packages/core/src/domain/provider.ts`.

| Status           | Meaning                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | Required configuration is present and, for a health check, the source answered.                                              |
| `not_configured` | One or more `requiredConfiguration` keys are missing or blank for this workspace.                                            |
| `auth_required`  | The source was reachable but rejected the stored credentials (401/403, or an FTP credential rejection).                      |
| `degraded`       | Reachable but not fully working: a non-2xx status, a partially readable set of roots, or an open circuit breaker.            |
| `unavailable`    | The source could not be reached at all, or the health check itself did not complete.                                         |
| `disabled`       | Registered but excluded — turned off by configuration, filtered out of the request, or not selectable in the requested mode. |

Where they surface:

- `GET /api/v1/providers` returns one summary per registered provider with `status` derived from
  `ProviderRegistry.configurationStatus` — a pure configuration check, so it only ever yields
  `ready`, `not_configured` or `disabled`. It never touches the network.
- `GET /api/v1/providers/health` runs each adapter's own `healthCheck` against the workspace's
  merged static and connector configuration (6 s budget per provider) and returns `status`,
  `message`, `latencyMs`, `circuitState` and `setupDocPath`.
- The diagnostics view (`packages/web/src/components/DiagnosticsView.tsx`) renders the health
  response as a table, including the setup document path for anything that needs attention.

Health checks always run against the calling workspace's configuration, so a connector configured
by one workspace never shows as `ready` for another.

## Contract test suite

`packages/core/tests/provider-contract.test.ts` runs the same battery against every registration in
the default registry, with a local mock server standing in for every remote source. A provider that
cannot pass it is not fit for the registry, whatever it does when the network is healthy — the
orchestrator's guarantees are only as strong as the weakest adapter.

Registry-level:

- every adapter is registered exactly once, and its `setupDocPath` matches `docs/providers/<id>.md`;
- registering the same provider twice throws;
- only providers with no missing `requiredConfiguration` are selected;
- an open circuit suppresses selection;
- an explicit provider restriction is honoured.

Per adapter:

- declares a coherent capability set — id matches `^[a-z0-9-]+$`, non-empty display name,
  `0 < timeoutMs <= 30000`, `maxConcurrentRequests > 0`, at least one mode, `retry.maxAttempts >= 1`,
  and `requiresAuthentication` implies `producesPrivateResults`;
- emits well-formed candidates for a valid query — correct `providerId`, non-empty
  `providerAssetId` and `title`, a parseable `mediaUrl` when one is present, and never
  `direct_download` when `mediaUrl` is `null`;
- returns nothing rather than failing on an empty (`{}`) response;
- survives a malformed response without emitting a candidate;
- survives a 429 rate-limit response;
- survives a 401 authentication failure without leaking credentials;
- stops within 3 s of an already-aborted signal, emitting at most one candidate;
- respects a 700 ms deadline against a server that never responds;
- reports health without throwing, with a non-empty message and a valid status;
- never emits more candidates than `context.maxCandidates`.

## Per-provider pages

- [Internet Archive](internet-archive.md)
- [Wikimedia Commons](wikimedia-commons.md)
- [LibriVox](librivox.md)
- [RSS and Atom feeds](rss-feed.md)
- [HTTP directory listings](http-directory.md)
- [FTP directories](ftp-directory.md)
- [Local files](local-files.md)
- [S3-compatible storage](s3-compatible.md)
- [WebDAV storage](webdav.md)
- [Custom JSON API](custom-json-api.md)
