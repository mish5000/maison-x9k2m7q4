---
description: Handling credentials and other secrets.
globs: ['auralis/**']
---

# Secrets

## Never commit one

No API keys, tokens, passwords, private keys or `.env` files. The
`.claude/hooks/block-secrets.sh` hook rejects the common shapes before an edit
lands, but the hook is a safety net and not a substitute for care.

Placeholders in documentation must be obviously fake and clearly labelled.

## Storage

Connector secrets are encrypted with AES-256-GCM (`crypto/secrets.ts`) before
they reach the database, and live in `connector_credential`, separate from the
non-secret settings in `connector`. The ciphertext record carries a version
prefix so a key can be rotated without a migration.

`ConnectorRepository.resolveConfig` decrypts. Its only legitimate callers are
the search orchestrator and the connection test. Its result must never be
serialised into a response, a log record, or an error message.

## Never log

The logger redacts these field names at any depth, plus anything shaped like a
bearer credential and the query string of anything that looks like a signed URL:

`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `password`,
`secret`, `token`, `accesstoken`, `refreshtoken`, `apikey`, `sessionsecret`,
`credential`, `privatekey`, `signedurl`, `clientsecret`, `secretaccesskey`.

Do not defeat this by concatenating a secret into a message string.

## Never store

Full signed URLs. A signed URL is a bearer token. The download audit records the
host only.

## Configuration

`AURALIS_SECRET_KEY` and `AURALIS_SESSION_SECRET` come from the environment and
are required in production; the server refuses to start without them. There is
no code path that reads a secret from a file path or a URL.
