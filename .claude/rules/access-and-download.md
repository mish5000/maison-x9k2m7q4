---
description: Rules for anything that decides what a user may do with a result.
globs: ['auralis/packages/**/*.ts']
---

# Access and download

## One authority

`classifyAccess` in `auralis/packages/core/src/access/classify.ts` is the only
function permitted to decide that a result is downloadable. Nothing else may
infer it, cache it, or accept it from a client.

## One download service

`DownloadControlService.createIntent` is the only path to a download. It
**re-derives** the classification from the stored verification record rather
than trusting the stored decision, because a connector may have been
disconnected or its credentials expired since the search ran.

The mediated streaming route calls the same service. There is no second path to
bytes, and adding one is a security regression.

## The monotonicity rule

Classification narrows, never widens. A provider may declare something more
restrictive and be honoured; nothing may raise a candidate above what the
verification evidence supports. If you are writing code that makes a result
_more_ accessible, you are almost certainly in the wrong place.

## Filenames

Every filename reaching a `Content-Disposition` header or a filesystem path goes
through `sanitiseFilename`. It removes path components, control characters,
quotes and semicolons, refuses dangerous extensions, and replaces reserved
device names. Build the header with `contentDispositionAttachment`.

## Withholding a URL

When the access decision does not include `copy_direct_url`, the result's
`mediaUrl` must be `null` in the payload sent to the client. The client cannot
leak a URL it was never given.

## Tests

Changes here require a test in `packages/core/tests/access.test.ts` and, if the
API surface is affected, in `packages/server/tests/security-integration.test.ts`.
