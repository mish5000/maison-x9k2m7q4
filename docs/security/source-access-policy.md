# Source access policy

This is the definitive statement of what Auralis may search and what it may
never do. It is not aspirational: each prohibition below names the module that
enforces it, and the test that proves it.

---

## What Auralis may search

| Source kind                 | Provider                       | Notes                                                      |
| --------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Public archives             | `internet-archive`, `librivox` | Documented public APIs, no key required                    |
| Open-data repositories      | `wikimedia-commons`            | MediaWiki API; licence and author carried through verbatim |
| Podcast, RSS and Atom feeds | `rss-feed`                     | Only feeds the user or an administrator configured         |
| HTTP directory listings     | `http-directory`               | Only roots the user or an administrator configured         |
| FTP directory listings      | `ftp-directory`                | Only roots configured; anonymous or supplied credentials   |
| Files the user selected     | `local-files`                  | Only paths inside a configured root                        |
| User-connected storage      | `s3-compatible`, `webdav`      | Credentials supplied by the user, encrypted at rest        |
| Organisation repositories   | `custom-json-api`              | Administrator-configured endpoint and field mapping        |

Two properties are common to every entry. First, the source is either publicly
published or explicitly connected by the person searching. Second, nothing is
discovered by guessing — Auralis never invents a feed URL, a bucket name, a
directory path or a hostname.

---

## What Auralis must never do

Each of these is enforced in code.

| Prohibition                                                       | Enforced in                                                                                                                                                                | Proven by                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Circumvent authentication                                         | No adapter constructs or replays credentials it was not given; connectors send only the credentials the user supplied, to the host they were supplied for                  | `packages/core/src/providers/*.ts`                                                                             |
| Guess, extract or obtain credentials                              | There is no credential-discovery code path anywhere in the repository                                                                                                      | —                                                                                                              |
| Exploit directory traversal                                       | `isWithinRoot` (HTTP), `isInsideRoot` (local), root-prefix check (WebDAV), `..` rejection (FTP)                                                                            | `providers/http-directory.ts`, `providers/local-files.ts`, `providers/webdav.ts`, `providers/ftp-directory.ts` |
| Probe internal networks                                           | `classifyIp` blocks loopback, private, link-local, CGNAT, metadata, multicast, reserved and documentation ranges, for IPv4 and IPv6, including IPv4-mapped and NAT64 forms | `net/ip-rules.ts`; `tests/url-safety.test.ts`                                                                  |
| Scan arbitrary IP ranges                                          | There is no scanning code. Every request targets a URL that came from a provider result or a user configuration                                                            | —                                                                                                              |
| Defeat CAPTCHAs                                                   | No CAPTCHA handling exists                                                                                                                                                 | —                                                                                                              |
| Bypass signed URL restrictions                                    | Signed URLs are used as given and never cached beyond their validity (`ttlForUrl`)                                                                                         | `cache/keys.ts`; `tests/scoring.test.ts`                                                                       |
| Circumvent anti-bot controls                                      | Requests carry an honest `User-Agent` identifying Auralis; no header spoofing, no rotation                                                                                 | `net/safe-fetch.ts`                                                                                            |
| Ignore provider rate limits                                       | Each adapter declares a rate-limit strategy that the orchestrator applies before dispatch                                                                                  | `domain/provider.ts`, `orchestrate/limits.ts`                                                                  |
| Access endpoints outside the configured scope                     | Allow-list and deny-list in the URL policy; directory adapters confine traversal to their root                                                                             | `net/url-safety.ts`                                                                                            |
| Generate fabricated download links                                | A media URL is only ever what a provider actually returned. Adapters with no per-file URL (LibriVox) emit `null` rather than construct one                                 | `providers/librivox.ts`; contract test asserts it                                                              |
| Rehost third-party files by default                               | Public files are downloaded by the browser from the source. Only user-owned and connected assets are streamed, through a workspace-scoped route                            | `services/download-control.ts`                                                                                 |
| Remove embedded metadata                                          | Auralis reads tags; it never rewrites a file                                                                                                                               | `media/probe.ts`                                                                                               |
| Misrepresent previews as full original files                      | Preview uses the same asset and is labelled as preview; `preview_only` never permits download                                                                              | `access/classify.ts`                                                                                           |
| Search hidden-service networks                                    | Only `http:` and `https:` schemes are accepted, and `.onion` resolves nowhere through the standard resolver                                                                | `net/url-safety.ts`                                                                                            |
| Persist credentials in plaintext                                  | AES-256-GCM before insert; the ciphertext record carries a version byte for rotation                                                                                       | `crypto/secrets.ts`; `tests/security-integration.test.ts`                                                      |
| Proxy a restricted file to evade source controls                  | The mediated route re-runs `createIntent` and refuses anything not permitted                                                                                               | `app.ts` streaming route                                                                                       |
| Expand authenticated search beyond the granted scope              | A connector searches only its configured bucket, prefix, collection or root                                                                                                | connector adapters                                                                                             |
| Follow redirects into private, local, reserved or metadata ranges | Every hop is revalidated; the socket peer address is re-checked after connect                                                                                              | `net/safe-fetch.ts`; `tests/safe-fetch.test.ts`                                                                |

---

## Access classifications

Every result carries exactly one classification. The interface derives its
available actions from it, and the API re-derives it server-side before
permitting any download.

| Classification      | Meaning                                                              | Download permitted |
| ------------------- | -------------------------------------------------------------------- | ------------------ |
| `direct_download`   | The source publishes the file at a URL Auralis verified              | Yes                |
| `source_download`   | The file is downloadable through the source's own page or endpoint   | Yes                |
| `user_owned`        | The file is in storage the user selected                             | Yes                |
| `connected_private` | The file is in an account the user connected, with valid credentials | Yes                |
| `preview_only`      | The source offers listening but not retrieval                        | No                 |
| `metadata_only`     | The source lists the recording but does not publish the file         | No                 |
| `restricted`        | Access exists but Auralis does not have it                           | No                 |
| `unknown`           | Access has not been established                                      | No                 |

### The monotonicity rule

`classifyAccess` narrows, never widens. A provider may declare something more
restrictive than the evidence supports and it is honoured. A provider claim can
never raise a candidate above what the verification evidence justifies:

- No media URL and no private handle → at best `preview_only`, else `metadata_only`.
- Verification says `not_audio` → `metadata_only`.
- Verification says `playlist` → at best `metadata_only`.
- Not positively verified but declared downloadable → forced to `unknown`.
- Connector credentials invalid → `restricted`.
- Provider does not publish direct URLs → `direct_download` becomes `source_download`.

### Actions

The `actions` array on a decision is the complete set of things the interface
may offer: `preview`, `download`, `visit_source`, `copy_source_url`,
`copy_direct_url`, `inspect_metadata`, `open_provider`, `connect_account`,
`request_credentials`. `inspect_metadata` is always present — a user can always
see what Auralis found, whatever the access state. `download` appears only for
the four downloadable classifications, and only when verification succeeded.

A result whose decision withholds `copy_direct_url` also has its `mediaUrl` set
to `null` in the payload sent to the client. The client cannot leak a URL it was
never given.

---

## Adding a source

Before adding a provider, confirm all of the following:

1. The source is publicly published, or the user explicitly connects it.
2. The adapter can find results without guessing identifiers or paths.
3. The adapter can declare an honest starting classification.
4. Its access terms permit programmatic search, and its documented rate limits
   are expressible in `ProviderCapabilities.rateLimit`.
5. It passes the full contract suite in `packages/core/tests/provider-contract.test.ts`.

If a source only becomes searchable by working around a control it puts in the
way, it is out of scope. That is a product decision, not a technical one, and it
is not negotiable per-deployment.
