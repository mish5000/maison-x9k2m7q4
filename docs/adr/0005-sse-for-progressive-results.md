# ADR 0005 — Server-sent events for progressive results

## Status

Accepted — 2026-08-02

## Context

A search fans out across up to ten providers with a total budget of 12 s
(quick), 45 s (deep) or 25 s (connected). Each candidate is then verified
independently — HEAD, a 64 KiB range probe, sometimes a 32 KiB tail probe — and
that verification is what turns a claim into a fact. Waiting for all of it before
showing anything would mean a blank screen for the whole budget.

The pipeline is also genuinely incremental in a second dimension: a single
result _improves_ over time. `processCandidate` emits `candidate_discovered`
immediately with provider claims at `confidence: 'none'`, then
`candidate_verified` once the bytes have been read, then `candidate_enriched`
when duplicate grouping changes its variants or demotes it behind a better copy.

So the transport requirements were:

- server → client push, many small messages, one search
- ordered, with a cursor, so a dropped connection can resume without duplicates
  or gaps
- no client → server messages during the stream (cancel is a separate action a
  user takes deliberately, not a stream message)
- works through ordinary HTTP infrastructure and carries the session cookie
- the client is a browser and nothing else

## Decision

Server-sent events over a long-lived `GET`, with `Last-Event-ID` as the resume
cursor.

`POST /api/v1/searches` returns **201** immediately with `searchId` and
`eventsUrl`; the search is already running in the background. The client opens
`GET /api/v1/searches/:searchId/events` with a plain
`new EventSource(created.eventsUrl)`.

Frame format (`routes/searches.ts`):

```
id: <event.seq>
event: <event.type>
data: <JSON.stringify(event)>

```

`id` is `event.seq`, a dense monotonic counter owned by a single emitter in
`SearchOrchestrator.run`. That is what makes `Last-Event-ID` usable as a cursor
with no bespoke protocol:

```ts
const lastEventId = Number.parseInt(
  String(request.headers['last-event-id'] ?? '0'),
  10,
);
const afterSeq =
  Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;
```

`SearchService.subscribe(searchId, workspaceId, afterSeq, onEvent)` replays from
the in-memory buffer (`event.seq > afterSeq`) for a live search, or from
`search_event` via `eventsSince(searchId, afterSeq)` for one that has finished,
returning `alreadyFinished: true`. `appendEvent` uses `INSERT OR IGNORE` against
the unique `(search_id, seq)` index, so replayed writes are no-ops.

Operational details that matter:

- Headers include `cache-control: no-cache, no-transform` and
  `x-accel-buffering: no` so intermediaries do not buffer the stream.
- A `: keep-alive\n\n` comment every 15 s keeps idle connections open.
- `subscribe` is called **before** `reply.hijack()`, so an unknown search still
  gets an ordinary JSON 404 rather than a half-written stream.
- Events arriving between subscribe and header-write are queued in `pending` and
  flushed once `streaming = true`.
- A finished search receives `event: stream_closed` and the response ends.
- In development Vite proxies `/api` to the API process, so the browser talks to
  one origin and `EventSource` sends the session cookie without needing
  `withCredentials`.

## Consequences

### Positive

- Reconnection and replay come free. `EventSource` reconnects on its own and
  resends `Last-Event-ID`; the server already keys events by `seq`. No
  heartbeat protocol, no sequence negotiation, no client-side resume logic —
  `useSearchStream.ts` never touches the header.
- Ordinary HTTP. Cookies, CORS, `helmet`, the CSRF preHandler, per-workspace
  rate limiting and the standard error handler all apply without a parallel
  authentication path for the socket.
- Text frames are debuggable with `curl`. A stalled search can be diagnosed by
  reading the stream.
- Buffering + persistence make the stream durable in two directions: a client
  that connects late replays the buffer, and a client that reconnects after the
  live entry expires (120 s) replays from SQLite.
- The client reducer stays simple because the semantics are "replace by
  `result.id`" — `discovered → verified → enriched` is idempotent under replay.
- Nothing new to operate. No socket server, no sticky-session requirement beyond
  what a single process already implies.

### Negative

- **SSE is one-directional.** Nothing can be sent up the stream. Cancellation is
  a separate `POST /api/v1/searches/:id/cancel`, and any future
  "refine while running" interaction would need its own request. That is a real
  constraint on what the UI can do mid-search.
- **Browsers cap concurrent connections per origin.** Over HTTP/1.1 that is
  around six, and an open SSE stream consumes one for its whole life. Several
  Auralis tabs against the same origin can exhaust the budget and stall ordinary
  API requests. HTTP/2 raises the ceiling substantially, but the constraint is
  the browser's, not the application's, and it is not something the server can
  fix. The 3-live-searches-per-workspace cap in `SearchService.create` limits
  the damage without removing it.
- **Text only.** Every frame is JSON in a `data:` line; there is no binary
  framing. Fine here — the payloads are result objects — but it forecloses
  streaming bytes over the same channel.
- **`EventSource` cannot set request headers.** Only cookies authenticate the
  stream, and the resume cursor is the only header the browser will send.
  Anything token-based would have to go in the query string, which is worse.
- **Reconnect storms are the browser's policy, not ours.** The retry interval is
  not configured server-side, and `useSearchStream.ts` only treats
  `readyState === CLOSED` as terminal, so a flapping network produces repeated
  subscribe calls and repeated replays.
- **Replay is bounded three ways** and none of them is obvious from the client:
  the live entry is dropped 120 s after the search finishes, the in-memory
  buffer stops at `BUFFER_LIMIT = 4000` events, and `search_event` rows are
  pruned after 7 days.
- **Proxy buffering breaks progressiveness silently.** `x-accel-buffering: no`
  is a request, not a guarantee; an intermediary that ignores it turns a
  progressive stream into one large delivery at the end, and the failure looks
  like slowness rather than misconfiguration.
- Each connected client holds an open response for the life of the search, which
  is a per-process resource ceiling in a way that polling would not be.

## Alternatives considered

| Alternative                                            | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSockets**                                         | The stream is one-way. Adopting a bidirectional transport to carry a unidirectional stream means writing, by hand, everything SSE provides for free: a reconnect policy, a heartbeat, a sequence-and-resume protocol, and a separate authentication path for the upgrade request (cookies work, but nothing else in the Fastify request pipeline — CSRF check, rate limiter, error handler — applies to a socket without being re-implemented). It also adds an operational surface: proxies and load balancers that pass HTTP fine need explicit configuration for upgrades. The one thing it would buy — client → server messages — is served by a single `POST /cancel`. |
| **Long polling**                                       | Each result would cost a request/response round trip, or results would be batched and the progressive experience lost. It also makes ordering and de-duplication the client's problem, which is exactly what `seq` + `Last-Event-ID` removes.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Short polling `GET /api/v1/searches/:id`**           | The status endpoint exists and returns the full result set, but polling it every second during a 45 s deep search is 45 round trips of mostly-unchanged JSON, and it cannot express `candidate_rejected`, per-provider outcomes or progress counters. It remains the right way to _re-read_ a finished search.                                                                                                                                                                                                                                                                                                                                                              |
| **HTTP/2 server push**                                 | Deprecated and removed from major browsers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A single response with chunked JSON lines (NDJSON)** | Streams fine, but the browser has no built-in consumer with reconnect-and-resume semantics; it would need `fetch` + a `ReadableStream` reader plus hand-written resume logic — i.e. reimplementing `EventSource` badly.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **gRPC-web streaming**                                 | Requires a proxy layer, a code-generation step and a schema language, in exchange for a binary framing the payloads do not need. Disproportionate for eleven event types already defined as a TypeScript union.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
