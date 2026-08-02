# Product brief

**Auralis — find the sound, verify the file.**

---

## The problem

Finding audio is not hard. Finding out what you actually found is.

A search returns a list of links. Each one carries a filename, a stated format,
sometimes a bitrate, sometimes a duration. Every one of those is a claim made by
whoever published the page, and none of them are checked. A `.mp3` extension is
a string. A `Content-Type: audio/mpeg` header is a string. A "320kbps" label in
a listing is a string that somebody typed.

So the person doing the searching downloads the file to find out. They discover
it is a 128kbps file transcoded up to look like 320, or a two-minute preview
where a forty-minute recording was expected, or a truncated download, or an HTML
error page with an audio filename, or a playlist rather than a file, or a
duplicate of something they already have at better quality. Then they do it
again for the next result.

The waste is not the download. It is that every claim has to be verified by
hand, one file at a time, and the tools that could verify them are not connected
to the tools that find them.

## What Auralis does

Auralis searches the sources the operator is permitted to search, and then —
before showing a result — reads the actual bytes to establish what the file
really is.

For every candidate it reports the container, codec, sample rate, bit depth,
channel count, duration and bitrate; whether each of those was measured or
estimated; how confident it is; whether the file's signature agrees with its
extension and its declared type; whether it shows signs of truncation or damage;
whether it is a duplicate of something else in the results and how it compares;
and what may actually be done with it.

It does this from a bounded sample. A HEAD request and at most two range
requests are enough to identify any supported format. Auralis never downloads a
whole file to describe one.

## The promise

**A result card never claims more than the evidence supports.**

That single sentence generates most of the design:

- A file that has not been verified is never offered as a download.
- A number that was inferred rather than measured is marked `estimated` and
  carries a confidence.
- Something not measured is reported as `null`, not filled in with a plausible
  value.
- A signature match is stated as evidence; an extension and a `Content-Type` are
  stated as claims, and agreement and disagreement are shown separately.
- When Auralis does not know, it says `unknown` — and `unknown` never permits a
  download.

Every claim traces to a check that ran. The scores publish their breakdowns; the
access decision publishes its evidence and the rules that fired.

## Who it is for

Someone assembling a set from public archives who needs to know a file will play
on the hardware they are taking to a venue. A researcher pulling recordings from
an open-data collection who needs to know which of six copies is the original. A
podcaster looking for a clip whose duration and encoding they can trust. Anyone
who has a large amount of audio in their own storage and no way to search it
alongside everything else.

The common shape: they can find candidates already. What they lack is grounds
for choosing between them.

## Scope

**In scope.** Public archives and open-data collections. Podcast, RSS and Atom
feeds. Documented audio APIs. Public HTTP and FTP directory listings. Local
directories the user selected. Storage the user explicitly connected —
S3-compatible, WebDAV, a custom JSON endpoint. An organisation's own repository.

**Out of scope, permanently.** Anything that only becomes searchable by working
around a control the source put in the way: authentication, paywalls, signed-URL
restrictions, anti-bot measures, geo-restriction, rate limits, DRM. Auralis does
not guess identifiers, does not scan address ranges, does not fabricate a
download URL, and does not proxy a restricted file to evade its source's
controls. The definitive list, with the module enforcing each line and the test
proving it, is
[`docs/security/source-access-policy.md`](../security/source-access-policy.md).

This boundary is a product decision, not a per-deployment setting. There is no
configuration flag that relaxes it.

## The three modes

**Quick** — fast providers, a tight budget, minimal enrichment before display.
For "is this out there at all".

**Deep** — more providers, a longer budget, more query variants, deeper
traversal within configured roots, more thorough validation, more aggressive
duplicate detection. For "find me the best copy of this".

**Connected sources** — searches storage the user has connected, using official
APIs or explicitly configured endpoints. Results are scoped to the workspace and
never enter a shared cache.

Deep mode widens coverage. It does not relax a single network, credential or
scope control.

## What a result carries

|               |                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Identity      | Title, creator, source, the host bytes actually came from                                                      |
| Verification  | State, what was checked, what each check found                                                                 |
| Technical     | Container, codec, sample rate, bit depth, channels, duration, bitrate — each with `estimated` and `confidence` |
| Integrity     | Corruption signals as stable `format:problem` identifiers                                                      |
| Compatibility | Per device profile: compatible, probably compatible, transcoding recommended, incompatible, or unknown         |
| Access        | One of eight classifications, the actions it permits, and the evidence behind it                               |
| Duplicates    | The group, which copy leads it, and why                                                                        |
| Scoring       | Quality and relevance, with the breakdown that produced each                                                   |

## How success is judged

- A person can tell, without downloading anything, whether a result is worth
  downloading.
- Auralis is never confidently wrong. Being uncertain out loud is a pass; a
  fabricated bitrate is a failure regardless of how often it would be right.
- One dead provider is a note on the page, never a failed search.
- Results appear as they are found — the first useful result should not wait for
  the slowest source.
- Nothing leaves the process except through the one audited egress path.

## Known limitations

Stated here because an unstated limitation is a false claim by omission.

- Verification reads container structure, not decoded audio. A file can be
  structurally valid and still contain silence or damage past the sampled
  region. Corruption signals report what was observed, not what was not looked
  at.
- Transcode detection is inference from container evidence, not spectral
  analysis. It is reported as a signal with a confidence, never as a verdict.
- Duplicate detection groups by progressive fingerprinting of metadata and
  sampled bytes. It does not compare decoded audio, so two encodes of the same
  performance may not group.
- Licensing statements are carried verbatim from the source. Auralis displays
  them; it does not evaluate or vouch for them.
- The egress layer pins connections to a validated IP, which is incompatible
  with an HTTP proxy. A deployment requiring proxied egress cannot use it as
  written.
- Search history export is documented as a data model but is not yet an
  endpoint.

## Where the rest is written down

|                            |                                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| How it is built            | [`docs/architecture/overview.md`](../architecture/overview.md)                 |
| How a search runs          | [`docs/architecture/search-pipeline.md`](../architecture/search-pipeline.md)   |
| What may be searched       | [`docs/security/source-access-policy.md`](../security/source-access-policy.md) |
| What can go wrong          | [`docs/security/threat-model.md`](../security/threat-model.md)                 |
| What is stored             | [`docs/security/privacy.md`](../security/privacy.md)                           |
| Why, for each big decision | [`docs/adr/`](../adr/)                                                         |
| How it looks, and why      | [`design-language.md`](./design-language.md)                                   |
