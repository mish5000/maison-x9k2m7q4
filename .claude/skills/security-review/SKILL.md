---
name: security-review
description: Review an Auralis change that touches network requests, credentials, connectors, downloads, media parsing, or caching. Use before merging any such change.
---

# Security review

Read `docs/security/threat-model.md` for the reasoning behind each check.

## Scope

Run this review when the change touches any of:

- `packages/core/src/net/**` — egress
- `packages/core/src/access/**` — access decisions
- `packages/core/src/media/**` — parsing untrusted bytes
- `packages/core/src/cache/**` — cache scoping
- `packages/server/src/services/download-control.ts`
- `packages/server/src/crypto/**`, `db/connectors.ts`
- any new provider adapter
- any route that fetches a URL or starts a transfer

## Checklist

### Egress

- [ ] No `fetch`, `axios`, `http.request` outside `packages/core/src/net/`
- [ ] Every URL passes `assertUrlAllowed` before a request is built
- [ ] Redirects are revalidated per hop and bounded
- [ ] Credential headers are dropped on a host change
- [ ] Byte and time caps are passed and cannot be disabled by a caller
- [ ] The pinned lookup remains asynchronous and handles both callback shapes
- [ ] Every socket has an error listener

### Access and download

- [ ] `classifyAccess` is the only decision point
- [ ] The API re-derives the decision rather than trusting stored or client data
- [ ] No new path to bytes that bypasses `createIntent`
- [ ] Filenames pass `sanitiseFilename`; headers built with `contentDispositionAttachment`
- [ ] `mediaUrl` is withheld when `copy_direct_url` is not permitted

### Tenancy

- [ ] Every workspace-owned query filters on `workspaceId`
- [ ] Another workspace's identifier returns 404, not 403
- [ ] Private results cannot produce a `shared:` cache key
- [ ] Disconnecting a connector clears its cache prefix

### Credentials

- [ ] Secrets encrypted before insert, listed in `secretConfigKeys`
- [ ] Nothing decrypted outside the orchestrator and the connection test
- [ ] No secret in a response, log, or error message
- [ ] No full signed URL persisted

### Parsing

- [ ] Every loop bounded; every allocation clamped
- [ ] No length field trusted without a cap
- [ ] Parsers remain pure and synchronous
- [ ] Tag strings pass `cleanTagString`

### Responses

- [ ] No stack trace, internal path, or upstream error text returned
- [ ] Errors mapped to an `AuralisError` code
- [ ] Correlation id present

## Verify by running

```bash
cd auralis
npm run lint          # includes the egress restrictions
npm test              # includes url-safety, safe-fetch, access, security-integration
npm run audit
```

## Report

For each finding: what it is, the concrete inputs that trigger it, the file and
line, and the smallest fix. Rank by exploitability, not by how interesting the
bug is. If nothing survives verification, say so plainly rather than padding the
list.
